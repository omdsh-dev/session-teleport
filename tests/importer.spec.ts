import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TeleportAuthority } from "../src/authority.js";
import { TeleportClient } from "../src/client.js";
import { MemoryWriterCredentialStore } from "../src/credential-store.js";
import {
  MemoryImportReceiptStore,
  SessionImporter,
  createSessionImportBundle,
  exportSessionImportBundle,
  type SessionImportClient,
} from "../src/importer.js";
import { initializeSchema } from "../src/schema.js";
import { createTeleportServer, type RunningTeleportServer } from "../src/server.js";
import type { SessionImportBundle } from "../src/types.js";
import { PgliteDatabase } from "./pglite.js";

describe("existing Session import", () => {
  let database: PgliteDatabase;
  let authority: TeleportAuthority;
  let app: RunningTeleportServer;
  let client: TeleportClient;
  let credentials: MemoryWriterCredentialStore;
  let receipts: MemoryImportReceiptStore;
  let importer: SessionImporter;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await initializeSchema(database);
    authority = new TeleportAuthority(database);
    app = createTeleportServer(authority, {
      apiToken: "test-token",
      adminToken: "admin-token",
    });
    client = new TeleportClient((await app.listen()).url, "test-token", "admin-token");
    credentials = new MemoryWriterCredentialStore();
    receipts = new MemoryImportReceiptStore();
    importer = new SessionImporter(client, credentials, receipts, {
      deviceId: "import-device",
      actorId: "test-operator",
      now: () => Date.parse("2026-08-11T00:00:00.000Z"),
    });
  });

  afterEach(async () => {
    await app.close();
    await database.close();
  });

  it("dry-runs without changing the target or local authority material", async () => {
    const bundle = importBundle("dry-run");
    await expect(importer.dryRun(bundle)).resolves.toMatchObject({
      sessionId: "dry-run",
      eventCount: 2,
      nextSeq: 2,
      targetStatus: "ready",
    });
    expect(await authority.listHeads()).toEqual([]);
    expect(await credentials.get("dry-run")).toBeUndefined();
    expect(await receipts.get("dry-run")).toBeUndefined();
  });

  it("exports through the existing inspect seam and checks source identity", async () => {
    const expected = importBundle("source-session");
    await expect(
      exportSessionImportBundle(
        {
          inspect: async () => ({ meta: expected.header, events: expected.events }),
        },
        "source-session",
      ),
    ).resolves.toEqual(expected);
    await expect(
      exportSessionImportBundle(
        {
          inspect: async () => ({ meta: expected.header, events: expected.events }),
        },
        "different-session",
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("imports one exact transaction, verifies it and replays idempotently", async () => {
    const bundle = importBundle("imported");
    await expect(importer.apply(bundle)).resolves.toMatchObject({
      sessionId: "imported",
      targetStatus: "already-present",
      idempotentReplay: false,
    });
    await expect(importer.apply(bundle)).resolves.toMatchObject({
      idempotentReplay: true,
    });
    expect(await client.snapshot("imported")).toMatchObject({
      header: bundle.header,
      revision: 1,
      nextSeq: 2,
      events: bundle.events,
    });
    expect(await credentials.get("imported")).toMatchObject({
      deviceId: "import-device",
      writerEpoch: 1,
    });
    expect(await receipts.get("imported")).toMatchObject({
      version: 1,
      sessionId: "imported",
      revision: 1,
      nextSeq: 2,
      createdAt: "2026-08-11T00:00:00.000Z",
    });
  });

  it("resumes safely after the import committed but its response was lost", async () => {
    let loseFirstResponse = true;
    const responseLossClient: SessionImportClient = {
      snapshot: (sessionId, afterSeq) => client.snapshot(sessionId, afterSeq),
      rollbackImport: (request) => client.rollbackImport(request),
      materializeSession: async (request) => {
        const result = await client.materializeSession(request);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error("simulated response loss");
        }
        return result;
      },
    };
    const retrying = new SessionImporter(responseLossClient, credentials, receipts, {
      deviceId: "import-device",
      actorId: "test-operator",
    });
    const bundle = importBundle("response-loss");
    await expect(retrying.apply(bundle)).rejects.toThrow("simulated response loss");
    expect(await credentials.get("response-loss")).toBeDefined();
    expect(await receipts.get("response-loss")).toBeUndefined();
    await expect(retrying.apply(bundle)).resolves.toMatchObject({ idempotentReplay: true });
    expect((await client.snapshot("response-loss")).events).toEqual(bundle.events);
  });

  it("never overwrites a conflicting target", async () => {
    const existing = await client.createSession({
      sessionId: "collision",
      header: { id: "collision", version: 0 },
      deviceId: "other-device",
    });
    await client.append({
      sessionId: "collision",
      writer: existing.writer,
      expectedRevision: 0,
      expectedNextSeq: 0,
      idempotencyKey: "existing-content",
      events: [{ type: "user/message", seq: 0, time: 1, data: { text: "existing" } }],
    });
    const before = await client.snapshot("collision");
    await expect(importer.dryRun(importBundle("collision"))).resolves.toMatchObject({
      targetStatus: "conflict",
    });
    await expect(importer.apply(importBundle("collision"))).rejects.toMatchObject({
      code: "SESSION_EXISTS",
    });
    expect(await client.snapshot("collision")).toEqual(before);
    expect(await credentials.get("collision")).toBeUndefined();
  });

  it("treats a reordered event envelope as a conflict", async () => {
    await client.materializeSession({
      sessionId: "order-sensitive",
      header: { version: 0, id: "order-sensitive", createdAt: 1 },
      deviceId: "other-device",
      writerToken: "other-token",
      idempotencyKey: "other-materialization",
      events: [
        { data: { text: "same" }, time: 1, seq: 0, type: "user/message" },
      ],
    });
    const bundle = createSessionImportBundle(
      { id: "order-sensitive", version: 0, createdAt: 1 },
      [{ type: "user/message", seq: 0, time: 1, data: { text: "same" } }],
    );
    await expect(importer.dryRun(bundle)).resolves.toMatchObject({
      targetStatus: "conflict",
    });
  });

  it("does not reuse a stale local receipt after remote rollback", async () => {
    const bundle = importBundle("stale-receipt");
    await importer.apply(bundle);
    const receipt = (await receipts.get("stale-receipt"))!;
    await client.rollbackImport({
      sessionId: receipt.sessionId,
      expectedRevision: receipt.revision,
      expectedNextSeq: receipt.nextSeq,
      expectedWriterEpoch: receipt.writerEpoch,
      importIdempotencyKey: receipt.idempotencyKey,
      actorId: "test-operator",
      reason: "remote rollback completed",
    });
    await expect(importer.apply(bundle)).rejects.toMatchObject({
      code: "IMPORT_NOT_ROLLBACKABLE",
    });
    await expect(importer.rollback("stale-receipt", "remote rollback completed")).resolves.toMatchObject({
      idempotentReplay: true,
    });
    await expect(importer.apply(bundle)).resolves.toMatchObject({
      idempotentReplay: false,
    });
  });

  it("rolls back an unchanged import, records it and makes retries idempotent", async () => {
    await importer.apply(importBundle("rollback-clean"));
    const receipt = (await receipts.get("rollback-clean"))!;
    await expect(importer.rollback("rollback-clean", "smoke test failed")).resolves.toEqual({
      sessionId: "rollback-clean",
      rolledBack: true,
      idempotentReplay: false,
    });
    await expect(client.head("rollback-clean")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await credentials.get("rollback-clean")).toBeUndefined();
    expect(await receipts.get("rollback-clean")).toBeUndefined();

    await expect(
      client.rollbackImport({
        sessionId: receipt.sessionId,
        expectedRevision: receipt.revision,
        expectedNextSeq: receipt.nextSeq,
        expectedWriterEpoch: receipt.writerEpoch,
        importIdempotencyKey: receipt.idempotencyKey,
        actorId: "test-operator",
        reason: "smoke test failed",
      }),
    ).resolves.toMatchObject({ idempotentReplay: true });

    await importer.apply(importBundle("rollback-clean"));
    const secondReceipt = (await receipts.get("rollback-clean"))!;
    expect(secondReceipt.idempotencyKey).not.toBe(receipt.idempotencyKey);
    await expect(
      client.rollbackImport({
        sessionId: receipt.sessionId,
        expectedRevision: receipt.revision,
        expectedNextSeq: receipt.nextSeq,
        expectedWriterEpoch: receipt.writerEpoch,
        importIdempotencyKey: receipt.idempotencyKey,
        actorId: "test-operator",
        reason: "smoke test failed",
      }),
    ).rejects.toMatchObject({ code: "IMPORT_NOT_ROLLBACKABLE" });
    await expect(importer.rollback("rollback-clean", "second cutover failed")).resolves.toMatchObject({
      rolledBack: true,
      idempotentReplay: false,
    });
    expect(
      Number(
        (
          await database.query<{ count: string | number }>(
            "SELECT COUNT(*) AS count FROM teleport_import_rollback_audit WHERE session_id = $1",
            ["rollback-clean"],
          )
        ).rows[0]?.count,
      ),
    ).toBe(2);
  });

  it("refuses rollback after the imported authority has advanced", async () => {
    await importer.apply(importBundle("rollback-closed"));
    const writer = (await credentials.get("rollback-closed"))!;
    await client.append({
      sessionId: "rollback-closed",
      writer,
      expectedRevision: 1,
      expectedNextSeq: 2,
      idempotencyKey: "post-cutover-write",
      events: [{ type: "turn/end", seq: 2, time: 3, data: { ok: true } }],
    });
    await expect(importer.rollback("rollback-closed", "too late")).rejects.toMatchObject({
      code: "IMPORT_NOT_ROLLBACKABLE",
    });
    expect((await client.snapshot("rollback-closed")).nextSeq).toBe(3);
    expect(await credentials.get("rollback-closed")).toBeDefined();
    expect(await receipts.get("rollback-closed")).toBeDefined();
  });
});

function importBundle(sessionId: string): SessionImportBundle {
  return createSessionImportBundle(
    { id: sessionId, version: 0, createdAt: 1, extension: { preserved: true } },
    [
      {
        type: "user/message",
        seq: 0,
        time: 1,
        data: { text: "hello" },
        pluginEnvelope: { keep: "exactly" },
      },
      {
        type: "assistant/chunk",
        seq: 1,
        time: 2,
        data: { text: "world" },
        sourceEventSeqs: [0],
      },
    ],
  );
}
