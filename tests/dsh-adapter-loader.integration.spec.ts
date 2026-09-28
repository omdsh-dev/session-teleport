import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { it, expect } from "vitest";
import { PgliteDatabase } from "./pglite.js";
import { initializeSchema } from "../src/schema.js";
import { TeleportAuthority } from "../src/authority.js";
import { createTeleportServer } from "../src/server.js";

const dshBin = process.env.DSH_TELEPORT_TEST_DSH_BIN;

it.skipIf(dshBin === undefined)("boots the packaged adapter inside the real DSH loader and flushes a live Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "teleport-loader-"));
  const database = new PgliteDatabase();
  await initializeSchema(database);
  const authority = new TeleportAuthority(database);
  const app = createTeleportServer(authority, { apiToken: "loader-test-token" });
  const { url } = await app.listen();
  const profile = join(directory, "profiles", "teleport-loader");
  const statusPath = join(directory, "result.json");
  const probe = join(directory, "probe.mjs");
  let output = "";
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-loader", private: true,
      dependencies: {}, dsh: { profile: { bundles: [] } } }));
    await writeFile(probe, `
import { writeFile } from "node:fs/promises";
export const inject = ["sessions", "sessionPersistence"];
export async function apply(ctx) {
  const session = ctx.sessions.create();
  const handle = await ctx.sessionPersistence.create(session.header);
  try {
    session.append("turn/start", { turn: 1 });
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await ctx.sessions.flush(session);
    const read = await handle.read();
    await writeFile(${JSON.stringify(statusPath)}, JSON.stringify({ id: session.id, events: read.events }));
  } finally { await handle.close(); }
}
`);
    await writeFile(join(profile, "cordis.patch.yml"), [
      "- insert:",
      "    - id: sessions",
      "      name: '@deepseek-ai/dsh-session'",
      "    - id: session-persistence-teleport",
      `      name: '${new URL("../dist/dsh-adapter.js", import.meta.url).href}'`,
      "      config:",
      `        baseUrl: '${url}'`,
      "        apiToken: 'loader-test-token'",
      "        deviceId: 'loader-device'",
      `        credentialDir: '${join(directory, "writers")}'`,
      "    - id: probe",
      `      name: '${pathToFileURL(probe).href}'`,
    ].join("\n"));
    child = spawn(process.execPath, [dshBin!, "--profile", "teleport-loader"], {
      env: { ...process.env, DSH_HOME: directory, DSH_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (data) => { output += String(data); });
    child.stderr?.on("data", (data) => { output += String(data); });
    const deadline = Date.now() + 15_000;
    let result: { id: string; events: unknown[] } | undefined;
    while (Date.now() < deadline) {
      try { result = JSON.parse(await readFile(statusPath, "utf8")); break; }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (child.exitCode !== null) throw new Error(`DSH exited before probe: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (result === undefined) throw new Error(`DSH loader probe timed out: ${output}`);
    expect(result.events).toHaveLength(2);
    expect((await authority.snapshot(result.id)).events).toEqual(result.events);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child!.once("close", resolve));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child!.kill("SIGKILL"), 2_000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await app.close();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 25_000);
