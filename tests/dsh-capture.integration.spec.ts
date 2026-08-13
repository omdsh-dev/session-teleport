import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const dshTestBin = process.env.DSH_TELEPORT_TEST_DSH_BIN;
const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(dshTestBin === undefined)("real DSH source capture", () => {
  it("loads the temporary file URL overlay and exports through inspect()", async () => {
    const dshHome = await mkdtemp(join(tmpdir(), "session-teleport-dsh-home-"));
    temporaryRoots.push(dshHome);
    await chmod(dshHome, 0o700);
    const profileDir = join(dshHome, "profiles", "capture-fixture");
    await mkdir(profileDir, { recursive: true });
    const sourcePlugin = join(dshHome, "source-fixture.mjs");
    await writeFile(sourcePlugin, sourcePluginSource(), { mode: 0o600 });
    await writeFile(
      join(profileDir, "package.json"),
      `${JSON.stringify({
        name: "dsh-profile-capture-fixture",
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [] } },
      }, undefined, 2)}\n`,
    );
    await writeFile(
      join(profileDir, "cordis.patch.yml"),
      [
        "- insert:",
        "    - id: source-persistence-fixture",
        `      name: '${pathToFileURL(sourcePlugin).href}'`,
        "",
      ].join("\n"),
    );
    const outputPath = join(dshHome, "captured.session-import.json");

    const cliPath = fileURLToPath(new URL("../dist/import-cli.js", import.meta.url));
    const command = await execFileAsync(
      process.execPath,
      [cliPath, "capture", "capture-fixture", "real-loader-session", outputPath],
      {
        timeout: 25_000,
        encoding: "utf8",
        env: {
          ...process.env,
          DSH_HOME: dshHome,
          DSH_TELEPORT_DSH_COMMAND: process.execPath,
          DSH_TELEPORT_DSH_ARGS_JSON: JSON.stringify([dshTestBin!]),
          DSH_TELEPORT_API_TOKEN: "must-be-scrubbed",
          DSH_TELEPORT_ADMIN_TOKEN: "must-be-scrubbed",
          DATABASE_URL: "must-be-scrubbed",
          PACKAGE_MANAGER_TOKEN: "must-be-scrubbed",
        },
      },
    );
    const result = JSON.parse(command.stdout) as Record<string, unknown>;

    expect(result).toMatchObject({
      sessionId: "real-loader-session",
      eventCount: 2,
      nextSeq: 2,
      sourceBackend: "session-persistence-fixture",
    });
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
      header: { id: "real-loader-session" },
      events: [
        { seq: 0, type: "user/message" },
        { seq: 1, type: "assistant/message" },
      ],
    });
  }, 30_000);
});

function sourcePluginSource(): string {
  return `
export function apply(ctx) {
  for (const key of ["PACKAGE_MANAGER_TOKEN", "DSH_TELEPORT_API_TOKEN", "DSH_TELEPORT_ADMIN_TOKEN", "DATABASE_URL"]) {
    if (process.env[key] !== undefined) throw new Error(key + " reached source profile");
  }
  ctx.provide("sessionPersistence", {
    name: "session-persistence-fixture",
    async inspect(sessionId) {
      return {
        meta: { id: sessionId, version: 0, createdAt: 1 },
        events: [
          { type: "user/message", seq: 0, time: 1, data: { text: "fixture input" } },
          { type: "assistant/message", seq: 1, time: 2, data: { text: "fixture output" } },
        ],
      };
    },
  });
}
`;
}
