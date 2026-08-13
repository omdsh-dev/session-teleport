import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

integration("complete migration against real DSH and PostgreSQL", () => {
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
      apiToken: "migration-test-token",
      adminToken: "migration-test-admin-token",
    });
    baseUrl = (await app.listen()).url;
    client = new TeleportClient(
      baseUrl,
      "migration-test-token",
      "migration-test-admin-token",
    );
    dshHome = await mkdtemp(join(tmpdir(), "session-teleport-migration-"));
    await chmod(dshHome, 0o700);
    sessionId = `migration-${process.pid}-${Date.now()}`;
    await createSourceProfile(dshHome);
  });

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

  it("captures, plans, applies, reads back and rolls back one exact Session", async () => {
    const cliPath = fileURLToPath(new URL("../dist/import-cli.js", import.meta.url));
    const bundlePath = join(dshHome, `${sessionId}.session-import.json`);
    const commonEnvironment = {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_TELEPORT_URL: baseUrl,
      DSH_TELEPORT_API_TOKEN: "migration-test-token",
      DSH_TELEPORT_ADMIN_TOKEN: "migration-test-admin-token",
      DSH_TELEPORT_ADMIN_ACTOR: "migration-test",
      DSH_TELEPORT_DEVICE_ID: "migration-device",
      DSH_TELEPORT_CREDENTIAL_DIR: join(dshHome, "credentials"),
      DSH_TELEPORT_IMPORT_RECEIPT_DIR: join(dshHome, "receipts"),
      DSH_TELEPORT_DSH_COMMAND: process.execPath,
      DSH_TELEPORT_DSH_ARGS_JSON: JSON.stringify([dshTestBin!]),
      // The capture child must strip target-side credentials before booting.
      DATABASE_URL: connectionString!,
      PACKAGE_MANAGER_TOKEN: "migration-test-package-token",
    };

    const captured = await runCli(
      cliPath,
      ["capture", "migration-source", sessionId, bundlePath],
      commonEnvironment,
    );
    expect(captured).toMatchObject({ sessionId, eventCount: 2, nextSeq: 2 });

    const plan = await runCli(cliPath, ["dry-run", bundlePath], commonEnvironment);
    expect(plan).toMatchObject({ sessionId, eventCount: 2, targetStatus: "ready" });

    const applied = await runCli(cliPath, ["apply", bundlePath], commonEnvironment);
    expect(applied).toMatchObject({
      sessionId,
      eventCount: 2,
      targetStatus: "already-present",
      idempotentReplay: false,
    });
    await expect(client.snapshot(sessionId)).resolves.toMatchObject({
      revision: 1,
      nextSeq: 2,
      events: [
        { seq: 0, type: "user/message", sourceExtension: { exact: true } },
        { seq: 1, type: "assistant/message" },
      ],
    });

    const rolledBack = await runCli(
      cliPath,
      ["rollback", sessionId, "verified reversible migration"],
      commonEnvironment,
    );
    expect(rolledBack).toMatchObject({ sessionId, rolledBack: true });
    await expect(client.head(sessionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 40_000);
});

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

async function createSourceProfile(dshHome: string): Promise<void> {
  const profileDir = join(dshHome, "profiles", "migration-source");
  await mkdir(profileDir, { recursive: true });
  const sourcePlugin = join(dshHome, "migration-source.mjs");
  await writeFile(sourcePlugin, `
export function apply(ctx) {
  for (const key of ["PACKAGE_MANAGER_TOKEN", "DSH_TELEPORT_API_TOKEN", "DSH_TELEPORT_ADMIN_TOKEN", "DATABASE_URL"]) {
    if (process.env[key] !== undefined) throw new Error(key + " reached source profile");
  }
  ctx.provide("sessionPersistence", {
    name: "session-persistence-migration-fixture",
    async inspect(sessionId) {
      return {
        meta: { id: sessionId, version: 0, createdAt: 1 },
        events: [
          { type: "user/message", seq: 0, time: 1, data: { text: "migrate me" }, sourceExtension: { exact: true } },
          { type: "assistant/message", seq: 1, time: 2, data: { text: "continued" } },
        ],
      };
    },
  });
}
`, { mode: 0o600 });
  await writeFile(
    join(profileDir, "package.json"),
    `${JSON.stringify({
      name: "dsh-profile-migration-source",
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }, undefined, 2)}\n`,
  );
  await writeFile(
    join(profileDir, "cordis.patch.yml"),
    [
      "- insert:",
      "    - id: migration-source-persistence",
      `      name: '${pathToFileURL(sourcePlugin).href}'`,
      "",
    ].join("\n"),
  );
}
