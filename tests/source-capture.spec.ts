import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureSessionBundle,
  captureSessionFromProfile,
} from "../src/source-capture.js";
import { apply as runSourceExport } from "../src/source-export-plugin.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("source Session capture", () => {
  it("writes an exact owner-only bundle and never replaces an existing file", async () => {
    const root = await temporaryRoot();
    const outputPath = join(root, "captured.session-import.json");
    const header = { id: "capture-one", version: 0 };
    const events = [
      { type: "user/message", seq: 0, time: 1, data: { text: "secret prompt" }, extension: true },
    ];
    const result = await captureSessionBundle(
      { inspect: async () => ({ meta: header, events }) },
      "capture-one",
      outputPath,
      "session-persistence-jsonl",
    );

    expect(result).toMatchObject({
      sessionId: "capture-one",
      eventCount: 1,
      nextSeq: 1,
      sourceBackend: "session-persistence-jsonl",
    });
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({
      format: "dsh-session-teleport/import-v1",
      header,
      events,
    });
    await expect(
      captureSessionBundle(
        { inspect: async () => ({ meta: header, events }) },
        "capture-one",
        outputPath,
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({ header });
  });

  it("orchestrates a one-shot profile, scrubs target secrets and stops it", async () => {
    const root = await temporaryRoot();
    const childScript = join(root, "fake-dsh.mjs");
    const stopped = join(root, "stopped");
    const outputPath = join(root, "from-profile.session-import.json");
    await writeFile(childScript, fakeDshScript(), { mode: 0o700 });

    const result = await captureSessionFromProfile({
      profile: "old-profile",
      sessionId: "profile-session",
      outputPath,
      dshCommand: process.execPath,
      dshArgsPrefix: [childScript],
      timeoutMs: 5_000,
      environment: {
        ...process.env,
        PACKAGE_MANAGER_TOKEN: "must-not-reach-source",
        DSH_TELEPORT_API_TOKEN: "must-not-reach-source",
        DSH_TELEPORT_ADMIN_TOKEN: "must-not-reach-source",
        DATABASE_URL: "must-not-reach-source",
        CAPTURE_STOPPED_PATH: stopped,
      },
      sourcePluginUrl: "file:///not-used-by-fixture.mjs",
    });

    expect(result).toMatchObject({
      sessionId: "profile-session",
      eventCount: 1,
      sourceBackend: "fixture:no-target-secrets",
    });
    await expect(readFile(stopped, "utf8")).resolves.toBe("SIGINT");
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
  });

  it("does not clobber an output path before starting DSH", async () => {
    const root = await temporaryRoot();
    const outputPath = join(root, "exists.session-import.json");
    await writeFile(outputPath, "keep", { mode: 0o600 });
    await expect(
      captureSessionFromProfile({
        profile: "old-profile",
        sessionId: "profile-session",
        outputPath,
        dshCommand: "/command/that/must/not/run",
      }),
    ).rejects.toThrow("capture output already exists");
    await expect(readFile(outputPath, "utf8")).resolves.toBe("keep");
  });

  it("reports source failures without copying arbitrary error text", async () => {
    const root = await temporaryRoot();
    const outputPath = join(root, "failed.session-import.json");
    const statusPath = join(root, "status.json");
    await expect(
      runSourceExport(
        {
          sessionPersistence: {
            name: "session-persistence-jsonl",
            inspect: async () => {
              throw new Error("prompt contents and password=do-not-copy");
            },
          },
        },
        { sessionId: "failed", outputPath, statusPath, nonce: "test-nonce" },
      ),
    ).rejects.toThrow("prompt contents");
    const statusValue = await readFile(statusPath, "utf8");
    expect(statusValue).not.toContain("prompt contents");
    expect(statusValue).not.toContain("do-not-copy");
    expect(JSON.parse(statusValue)).toEqual({
      version: 1,
      nonce: "test-nonce",
      ok: false,
      error: "source Session capture failed; inspect the source profile locally",
    });
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "session-teleport-test-"));
  temporaryRoots.push(root);
  await chmod(root, 0o700);
  return root;
}

function fakeDshScript(): string {
  return `
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

for (const key of ["PACKAGE_MANAGER_TOKEN", "DSH_TELEPORT_API_TOKEN", "DSH_TELEPORT_ADMIN_TOKEN", "DATABASE_URL"]) {
  if (process.env[key] !== undefined) throw new Error(key + " reached source child");
}
const sessionId = process.env.DSH_TELEPORT_CAPTURE_SESSION_ID;
const outputPath = process.env.DSH_TELEPORT_CAPTURE_OUTPUT_PATH;
const statusPath = process.env.DSH_TELEPORT_CAPTURE_STATUS_PATH;
const nonce = process.env.DSH_TELEPORT_CAPTURE_NONCE;
const bundle = {
  format: "dsh-session-teleport/import-v1",
  header: { id: sessionId, version: 0 },
  events: [{ type: "user/message", seq: 0, time: 1, data: { text: "fixture" } }],
};
const encode = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(encode).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + encode(value[key])).join(",") + "}";
};
const digestInput = { format: bundle.format, header: bundle.header, eventJson: bundle.events.map(JSON.stringify) };
const digest = createHash("sha256").update(encode(digestInput)).digest("hex");
const payload = JSON.stringify(bundle) + "\\n";
await writeFile(outputPath, payload, { mode: 0o600, flag: "wx" });
await writeFile(statusPath, JSON.stringify({
  version: 1,
  nonce,
  ok: true,
  result: {
    sessionId,
    digest,
    eventCount: 1,
    nextSeq: 1,
    bundleBytes: Buffer.byteLength(payload),
    outputPath,
    sourceBackend: "fixture:no-target-secrets",
  },
}) + "\\n", { mode: 0o600, flag: "wx" });
process.on("SIGINT", async () => {
  await writeFile(process.env.CAPTURE_STOPPED_PATH, "SIGINT");
  process.exit(0);
});
setInterval(() => {}, 1000);
`;
}
