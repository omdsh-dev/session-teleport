import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TeleportAuthority } from "../src/authority.js";
import { TeleportClient } from "../src/client.js";
import { PostgresDatabase } from "../src/database.js";
import { initializeSchema } from "../src/schema.js";
import { createTeleportServer, type RunningTeleportServer } from "../src/server.js";

const connectionString = process.env.POSTGRES_TEST_URL;
const dshTestBin = process.env.DSH_TELEPORT_TEST_DSH_BIN;
const integration = connectionString === undefined || dshTestBin === undefined
  ? describe.skip
  : describe;
const execFileAsync = promisify(execFile);

integration("migration from real DSH JSONL to real PostgreSQL", () => {
  let database: PostgresDatabase;
  let authority: TeleportAuthority;
  let app: RunningTeleportServer;
  let client: TeleportClient;
  let baseUrl: string;
  let dshHome: string;
  let sessionId: string;

  beforeAll(async () => {
    database = new PostgresDatabase(connectionString!);
    await initializeSchema(database);
    authority = new TeleportAuthority(database);
    app = createTeleportServer(authority, {
      apiToken: "jsonl-migration-test-token",
      adminToken: "jsonl-migration-test-admin-token",
    });
    baseUrl = (await app.listen()).url;
    client = new TeleportClient(
      baseUrl,
      "jsonl-migration-test-token",
      "jsonl-migration-test-admin-token",
    );
    dshHome = await mkdtemp(join(tmpdir(), "session-teleport-jsonl-migration-"));
    await chmod(dshHome, 0o700);
    sessionId = `jsonl-migration-${process.pid}-${Date.now()}`;
    await createBaseProfile(dshHome);
    await seedRealJsonl(dshHome, sessionId);
  }, 30_000);

  afterAll(async () => {
    await database.query("DELETE FROM teleport_sessions WHERE session_id = $1", [sessionId]);
    await database.query(
      "DELETE FROM teleport_import_rollback_audit WHERE session_id = $1",
      [sessionId],
    );
    await Promise.all([app.close(), database.close()]);
    const { rm } = await import("node:fs/promises");
    await rm(dshHome, { recursive: true, force: true });
  });

  it("preserves a physical JSONL prefix through capture, import and rollback", async () => {
    expect(await containsFile(join(dshHome, "sessions"))).toBe(true);
    const cliPath = fileURLToPath(new URL("../dist/import-cli.js", import.meta.url));
    const bundlePath = join(dshHome, `${sessionId}.session-import.json`);
    const environment = {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEPORT_URL: baseUrl,
      DSH_TELEPORT_API_TOKEN: "jsonl-migration-test-token",
      DSH_TELEPORT_ADMIN_TOKEN: "jsonl-migration-test-admin-token",
      DSH_TELEPORT_ADMIN_ACTOR: "jsonl-migration-test",
      DSH_TELEPORT_DEVICE_ID: "jsonl-migration-device",
      DSH_TELEPORT_CREDENTIAL_DIR: join(dshHome, "credentials"),
      DSH_TELEPORT_IMPORT_RECEIPT_DIR: join(dshHome, "receipts"),
      DSH_TELEPORT_DSH_COMMAND: process.execPath,
      DSH_TELEPORT_DSH_ARGS_JSON: JSON.stringify([dshTestBin!]),
      DATABASE_URL: connectionString!,
      PACKAGE_MANAGER_TOKEN: "jsonl-migration-test-package-token",
    };

    const captured = await runCli(
      cliPath,
      ["capture", "jsonl-source", sessionId, bundlePath],
      environment,
    );
    expect(captured).toMatchObject({
      sessionId,
      eventCount: 2,
      nextSeq: 2,
      sourceBackend: "session-persistence-jsonl",
    });
    const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
      header: Record<string, unknown>;
      events: unknown[];
    };
    expect(bundle.header).toMatchObject({ id: sessionId, version: 4 });
    expect(bundle.events).toEqual(sourceEvents());

    await expect(runCli(cliPath, ["dry-run", bundlePath], environment)).resolves.toMatchObject({
      sessionId,
      targetStatus: "ready",
    });
    await expect(runCli(cliPath, ["apply", bundlePath], environment)).resolves.toMatchObject({
      sessionId,
      targetStatus: "already-present",
    });
    await expect(client.snapshot(sessionId)).resolves.toMatchObject({
      revision: 1,
      nextSeq: 2,
      events: sourceEvents(),
    });
    await expect(
      runCli(
        cliPath,
        ["rollback", sessionId, "real JSONL migration verified"],
        environment,
      ),
    ).resolves.toMatchObject({ sessionId, rolledBack: true });
    await expect(client.head(sessionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 40_000);
});

async function createBaseProfile(dshHome: string): Promise<void> {
  const profileDir = join(dshHome, "profiles", "jsonl-source");
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    join(profileDir, "package.json"),
    `${JSON.stringify({
      name: "dsh-profile-jsonl-source",
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
    }, undefined, 2)}\n`,
  );
  await writeFile(join(profileDir, "cordis.patch.yml"), "[]\n");
}

async function seedRealJsonl(dshHome: string, sessionId: string): Promise<void> {
  const seedPlugin = join(dshHome, "seed-jsonl.mjs");
  const seedPatch = join(dshHome, "seed-jsonl.patch.yml");
  const readyPath = join(dshHome, "seed-ready.json");
  await writeFile(seedPlugin, `
import { writeFile } from "node:fs/promises";

export const inject = ["sessionPersistence"];
export async function apply(ctx) {
  const id = process.env.DSH_TELEPORT_JSONL_SEED_SESSION_ID;
  const ready = process.env.DSH_TELEPORT_JSONL_SEED_READY_PATH;
  const handle = await ctx.sessionPersistence.create({ version: 4, id, createdAt: 1000, isSeeded: false });
  await handle.append(${JSON.stringify(sourceEvents())});
  await handle.flush();
  await handle.close();
  await writeFile(ready, JSON.stringify({ ok: true, id }) + "\\n", { mode: 0o600, flag: "wx" });
}
`, { mode: 0o600 });
  await writeFile(
    seedPatch,
    [
      "- insert:",
      "    - id: session-teleport-jsonl-seed",
      `      name: '${pathToFileURL(seedPlugin).href}'`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [dshTestBin!, "--profile", "jsonl-source", "--patch", seedPatch],
    {
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_TELEMETRY_DISABLED: "1",
        DSH_TELEPORT_JSONL_SEED_SESSION_ID: sessionId,
        DSH_TELEPORT_JSONL_SEED_READY_PATH: readyPath,
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  try {
    await waitForFileOrExit(child, readyPath, 20_000);
    expect(JSON.parse(await readFile(readyPath, "utf8"))).toEqual({ ok: true, id: sessionId });
  } finally {
    await stopChild(child);
  }
}

function sourceEvents(): Array<Record<string, unknown>> {
  return [
    {
      type: "plugin/session-teleport-test",
      ignorable: true,
      seq: 0,
      time: 1,
      data: { text: "from real JSONL", extension: { exact: true } },
    },
    {
      type: "plugin/session-teleport-test",
      ignorable: true,
      seq: 1,
      time: 2,
      data: { text: "second event" },
    },
  ];
}

async function runCli(
  cliPath: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    timeout: 30_000,
    encoding: "utf8",
    env: environment,
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function waitForFileOrExit(
  child: ChildProcess,
  path: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (child.exitCode !== null) {
      throw new Error(`DSH JSONL seed process exited with code ${child.exitCode}`);
    }
    await delay(25);
  }
  throw new Error(`DSH JSONL seed timed out after ${timeoutMs} ms`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const graceful = new Promise<boolean>((resolveExit) =>
    child.once("close", () => resolveExit(true)),
  );
  child.kill("SIGINT");
  const exited = await Promise.race([graceful, delay(5_000).then(() => false)]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGINT");
    await Promise.race([
      new Promise<void>((resolveExit) => child.once("close", () => resolveExit())),
      delay(500),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function containsFile(path: string): Promise<boolean> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && await containsFile(join(path, entry.name))) return true;
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
