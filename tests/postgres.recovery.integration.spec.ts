import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TeleportAuthority } from "../src/authority.js";
import { PostgresDatabase } from "../src/database.js";
import { initializeSchema } from "../src/schema.js";

const connectionString = process.env.POSTGRES_TEST_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("writer recovery on a real PostgreSQL server", () => {
  let first: PostgresDatabase;
  let second: PostgresDatabase;
  let firstAuthority: TeleportAuthority;
  let secondAuthority: TeleportAuthority;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    first = new PostgresDatabase(connectionString!);
    second = new PostgresDatabase(connectionString!);
    await initializeSchema(first);
    firstAuthority = new TeleportAuthority(first);
    secondAuthority = new TeleportAuthority(second);
  });

  afterAll(async () => {
    for (const sessionId of sessionIds) {
      await first.query("DELETE FROM teleport_sessions WHERE session_id = $1", [sessionId]);
      await first.query(
        "DELETE FROM teleport_import_rollback_audit WHERE session_id = $1",
        [sessionId],
      );
    }
    await Promise.all([first.close(), second.close()]);
  });

  it("serializes competing recoveries and preserves one audited writer", async () => {
    const sessionId = uniqueSessionId("race");
    sessionIds.push(sessionId);
    const original = await firstAuthority.createSession({
      sessionId,
      header: { version: 0 },
      deviceId: "original-device",
    });
    const base = {
      sessionId,
      expectedRevision: 0,
      expectedWriterEpoch: 1,
      actorId: "postgres-test",
      reason: "lost device",
    };
    const settled = await Promise.allSettled([
      firstAuthority.recoverWriter({
        ...base,
        deviceId: "replacement-a",
        writerToken: "replacement-token-a",
        idempotencyKey: "recovery-a",
      }),
      secondAuthority.recoverWriter({
        ...base,
        deviceId: "replacement-b",
        writerToken: "replacement-token-b",
        idempotencyKey: "recovery-b",
      }),
    ]);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect(await firstAuthority.listWriterAudit(sessionId)).toHaveLength(1);
    await expect(
      firstAuthority.append({
        sessionId,
        writer: original.writer,
        expectedRevision: 0,
        expectedNextSeq: 0,
        idempotencyKey: "stale-after-recovery",
        events: [{ type: "turn/start", seq: 0, time: 1, data: {} }],
      }),
    ).rejects.toMatchObject({ code: "WRITER_FENCED" });
  });

  it("converges concurrent retries of one recovery request", async () => {
    const sessionId = uniqueSessionId("retry");
    sessionIds.push(sessionId);
    await firstAuthority.createSession({
      sessionId,
      header: { version: 0 },
      deviceId: "original-device",
    });
    const request = {
      sessionId,
      expectedRevision: 0,
      expectedWriterEpoch: 1,
      deviceId: "replacement-device",
      writerToken: "replacement-token",
      idempotencyKey: "same-recovery",
      actorId: "postgres-test",
      reason: "response lost",
    };
    const results = await Promise.all([
      firstAuthority.recoverWriter(request),
      secondAuthority.recoverWriter(request),
    ]);
    expect(results.map((result) => result.idempotentReplay).sort()).toEqual([false, true]);
    expect(results[0]!.writer).toEqual(results[1]!.writer);
    expect(await firstAuthority.listWriterAudit(sessionId)).toHaveLength(1);
  });

  it("serializes import rollback against the first post-cutover append", async () => {
    const sessionId = uniqueSessionId("import-rollback-race");
    sessionIds.push(sessionId);
    const imported = await firstAuthority.materializeSession({
      sessionId,
      header: { id: sessionId, version: 0 },
      deviceId: "import-device",
      writerToken: "import-writer-token",
      idempotencyKey: `dsh-import-${"a".repeat(64)}-${"b".repeat(64)}`,
      events: [{ type: "turn/start", seq: 0, time: 1, data: {} }],
    });
    const settled = await Promise.allSettled([
      firstAuthority.append({
        sessionId,
        writer: imported.writer,
        expectedRevision: 1,
        expectedNextSeq: 1,
        idempotencyKey: "first-post-cutover-append",
        events: [{ type: "turn/end", seq: 1, time: 2, data: {} }],
      }),
      secondAuthority.rollbackImport({
        sessionId,
        expectedRevision: 1,
        expectedNextSeq: 1,
        expectedWriterEpoch: 1,
        importIdempotencyKey: `dsh-import-${"a".repeat(64)}-${"b".repeat(64)}`,
        actorId: "postgres-test",
        reason: "cutover smoke test failed",
      }),
    ]);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(1);

    const head = await firstAuthority.head(sessionId).catch((error: unknown) => error);
    if (head instanceof Error) {
      expect(head).toMatchObject({ code: "NOT_FOUND" });
    } else {
      expect(head).toMatchObject({ revision: 2, nextSeq: 2, writerEpoch: 1 });
    }
  });

  it("converges concurrent retries of one import rollback", async () => {
    const sessionId = uniqueSessionId("import-rollback-retry");
    sessionIds.push(sessionId);
    const importIdempotencyKey = `dsh-import-${"c".repeat(64)}-${"d".repeat(64)}`;
    await firstAuthority.materializeSession({
      sessionId,
      header: { id: sessionId, version: 0 },
      deviceId: "import-device",
      writerToken: "import-writer-token",
      idempotencyKey: importIdempotencyKey,
      events: [{ type: "turn/start", seq: 0, time: 1, data: {} }],
    });
    const request = {
      sessionId,
      expectedRevision: 1,
      expectedNextSeq: 1,
      expectedWriterEpoch: 1,
      importIdempotencyKey,
      actorId: "postgres-test",
      reason: "same rollback retry",
    };
    const results = await Promise.all([
      firstAuthority.rollbackImport(request),
      secondAuthority.rollbackImport(request),
    ]);
    expect(results.map((result) => result.idempotentReplay).sort()).toEqual([false, true]);
    await expect(firstAuthority.head(sessionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const audit = await first.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM teleport_import_rollback_audit
        WHERE session_id = $1`,
      [sessionId],
    );
    expect(Number(audit.rows[0]?.count)).toBe(1);
  });

  function uniqueSessionId(label: string): string {
    return `recovery-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
});
