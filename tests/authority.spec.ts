import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TeleportAuthority } from "../src/authority.js";
import { initializeSchema } from "../src/schema.js";
import type { TeleportEvent, WriterCredentials } from "../src/types.js";
import { PgliteDatabase } from "./pglite.js";

function event(seq: number, text: string, type = "assistant/chunk"): TeleportEvent {
  return {
    type,
    seq,
    time: 100 + seq,
    data: { text, nested: { keep: true } },
    sourceEventSeqs: seq === 0 ? [] : [seq - 1],
    surfaceOp: "append",
  };
}

describe("TeleportAuthority", () => {
  let database: PgliteDatabase;
  let authority: TeleportAuthority;
  let writer: WriterCredentials;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await initializeSchema(database);
    authority = new TeleportAuthority(database);
    writer = (
      await authority.createSession({
        sessionId: "session-1",
        header: { version: 0, cwd: "/work" },
        deviceId: "mac-office",
      })
    ).writer;
  });

  afterEach(async () => {
    await database.close();
  });

  it("round-trips every event 1:1, including assistant/chunk and surface metadata", async () => {
    const events = [event(0, "delta"), event(1, "message", "assistant/message")];
    await authority.append({
      sessionId: "session-1",
      writer,
      expectedRevision: 0,
      expectedNextSeq: 0,
      idempotencyKey: "batch-1",
      events,
    });
    const snapshot = await authority.snapshot("session-1");
    expect(snapshot.events).toEqual(events);
    expect(snapshot).toMatchObject({ revision: 1, nextSeq: 2, writerDeviceId: "mac-office" });
  });

  it("atomically materializes a lazy DSH session and replays the same first batch", async () => {
    const request = {
      sessionId: "lazy-materialized",
      header: { version: 0, id: "lazy-materialized", createdAt: 1 },
      deviceId: "mac-office",
      writerToken: "client-generated-writer-token",
      idempotencyKey: "materialize-batch",
      events: [event(0, "first"), event(1, "second")],
    };
    expect(await authority.materializeSession(request)).toMatchObject({
      revision: 1,
      nextSeq: 2,
      idempotentReplay: false,
      writer: { deviceId: "mac-office", writerEpoch: 1 },
    });
    expect(await authority.materializeSession(request)).toMatchObject({
      revision: 1,
      nextSeq: 2,
      idempotentReplay: true,
    });
    expect(await authority.head(request.sessionId)).toMatchObject({
      header: request.header,
      revision: 1,
      nextSeq: 2,
    });
    expect((await authority.listHeads()).map((head) => head.sessionId)).toContain(
      request.sessionId,
    );
    expect((await authority.snapshot(request.sessionId)).events).toEqual(request.events);
  });

  it("does not let a different materializer adopt an existing session id", async () => {
    const base = {
      sessionId: "materialize-race",
      header: { version: 0, id: "materialize-race", createdAt: 1 },
      deviceId: "mac-office",
      writerToken: "writer-a",
      idempotencyKey: "materialize-a",
      events: [event(0, "a")],
    };
    await authority.materializeSession(base);
    await expect(
      authority.materializeSession({
        ...base,
        deviceId: "mac-home",
        writerToken: "writer-b",
        idempotencyKey: "materialize-b",
        events: [event(0, "b")],
      }),
    ).rejects.toMatchObject({ code: "SESSION_EXISTS" });
  });

  it("recognizes a response-loss retry without duplicating events or bumping revision", async () => {
    const request = {
      sessionId: "session-1",
      writer,
      expectedRevision: 0,
      expectedNextSeq: 0,
      idempotencyKey: "retryable-batch",
      events: [event(0, "once")],
    };
    expect(await authority.append(request)).toEqual({
      revision: 1,
      nextSeq: 1,
      idempotentReplay: false,
    });
    expect(await authority.append(request)).toEqual({
      revision: 1,
      nextSeq: 1,
      idempotentReplay: true,
    });
    expect((await authority.snapshot("session-1")).events).toHaveLength(1);
  });

  it("rejects reuse of an idempotency key for different content", async () => {
    await authority.append({
      sessionId: "session-1",
      writer,
      expectedRevision: 0,
      expectedNextSeq: 0,
      idempotencyKey: "same-key",
      events: [event(0, "first")],
    });
    await expect(
      authority.append({
        sessionId: "session-1",
        writer,
        expectedRevision: 0,
        expectedNextSeq: 0,
        idempotencyKey: "same-key",
        events: [event(0, "different")],
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("serializes two writers at one head: one commits and the other conflicts", async () => {
    const first = authority.append({
      sessionId: "session-1",
      writer,
      expectedRevision: 0,
      expectedNextSeq: 0,
      idempotencyKey: "concurrent-a",
      events: [event(0, "a")],
    });
    const second = authority.append({
      sessionId: "session-1",
      writer,
      expectedRevision: 0,
      expectedNextSeq: 0,
      idempotencyKey: "concurrent-b",
      events: [event(0, "b")],
    });
    const settled = await Promise.allSettled([first, second]);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect((await authority.snapshot("session-1")).events).toHaveLength(1);
  });

  it("hands the writer baton to another device and fences the old token", async () => {
    const handoff = await authority.createHandoff({ sessionId: "session-1", writer });
    const accepted = await authority.acceptHandoff({ code: handoff.code, deviceId: "mac-home" });
    expect(accepted.writer).toMatchObject({ deviceId: "mac-home", writerEpoch: 2 });

    await expect(
      authority.append({
        sessionId: "session-1",
        writer,
        expectedRevision: 0,
        expectedNextSeq: 0,
        idempotencyKey: "old-writer",
        events: [event(0, "stale")],
      }),
    ).rejects.toMatchObject({ code: "WRITER_FENCED" });

    await expect(
      authority.append({
        sessionId: "session-1",
        writer: accepted.writer,
        expectedRevision: 0,
        expectedNextSeq: 0,
        idempotencyKey: "new-writer",
        events: [event(0, "continued")],
      }),
    ).resolves.toMatchObject({ revision: 1, nextSeq: 1 });
    expect((await authority.snapshot("session-1")).writerDeviceId).toBe("mac-home");
    expect(await authority.listWriterAudit("session-1")).toMatchObject([
      {
        action: "handoff",
        actorId: "mac-home",
        fromDeviceId: "mac-office",
        toDeviceId: "mac-home",
        fromEpoch: 1,
        toEpoch: 2,
      },
    ]);
  });

  it("recovers a lost writer exactly once, audits it and fences the old device", async () => {
    const request = {
      sessionId: "session-1",
      expectedRevision: 0,
      expectedWriterEpoch: 1,
      deviceId: "replacement-mac",
      writerToken: "replacement-writer-token",
      idempotencyKey: "recovery-1",
      actorId: "operator@example.invalid",
      reason: "lost office laptop",
    };
    const recovered = await authority.recoverWriter(request);
    expect(recovered).toMatchObject({
      revision: 0,
      nextSeq: 0,
      idempotentReplay: false,
      writer: { deviceId: "replacement-mac", writerEpoch: 2 },
    });
    expect(await authority.recoverWriter(request)).toMatchObject({
      idempotentReplay: true,
      writer: { writerEpoch: 2 },
    });

    await expect(
      authority.recoverWriter({ ...request, reason: "different request" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      authority.append({
        sessionId: "session-1",
        writer,
        expectedRevision: 0,
        expectedNextSeq: 0,
        idempotencyKey: "old-writer-after-recovery",
        events: [event(0, "stale")],
      }),
    ).rejects.toMatchObject({ code: "WRITER_FENCED" });
    await expect(
      authority.append({
        sessionId: "session-1",
        writer: recovered.writer,
        expectedRevision: 0,
        expectedNextSeq: 0,
        idempotencyKey: "recovered-writer",
        events: [event(0, "continued")],
      }),
    ).resolves.toMatchObject({ revision: 1, nextSeq: 1 });

    expect(await authority.listWriterAudit("session-1")).toMatchObject([
      {
        idempotencyKey: "recovery-1",
        action: "admin_recovery",
        actorId: "operator@example.invalid",
        reason: "lost office laptop",
        fromDeviceId: "mac-office",
        toDeviceId: "replacement-mac",
        fromEpoch: 1,
        toEpoch: 2,
        revision: 0,
        nextSeq: 0,
      },
    ]);
  });

  it("refuses recovery against a stale revision or writer epoch", async () => {
    await authority.append({
      sessionId: "session-1",
      writer,
      expectedRevision: 0,
      expectedNextSeq: 0,
      idempotencyKey: "advance-before-recovery",
      events: [event(0, "advance")],
    });
    const request = {
      sessionId: "session-1",
      expectedRevision: 0,
      expectedWriterEpoch: 1,
      deviceId: "replacement-mac",
      writerToken: "replacement-writer-token",
      idempotencyKey: "stale-recovery",
      actorId: "operator",
      reason: "device lost",
    };
    await expect(authority.recoverWriter(request)).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });

    const handoff = await authority.createHandoff({ sessionId: "session-1", writer });
    await authority.acceptHandoff({ code: handoff.code, deviceId: "mac-home" });
    await expect(
      authority.recoverWriter({
        ...request,
        expectedRevision: 1,
        idempotencyKey: "stale-epoch-recovery",
      }),
    ).rejects.toMatchObject({ code: "WRITER_FENCED" });
  });

  it("acknowledges an exact committed retry after handoff but fences new stale writes", async () => {
    const committed = {
      sessionId: "session-1",
      writer,
      expectedRevision: 0,
      expectedNextSeq: 0,
      idempotencyKey: "response-lost-before-handoff",
      events: [event(0, "committed")],
    };
    await authority.append(committed);
    const handoff = await authority.createHandoff({ sessionId: "session-1", writer });
    await authority.acceptHandoff({ code: handoff.code, deviceId: "mac-home" });

    await expect(authority.append(committed)).resolves.toEqual({
      revision: 1,
      nextSeq: 1,
      idempotentReplay: true,
    });
    await expect(
      authority.append({
        sessionId: "session-1",
        writer,
        expectedRevision: 1,
        expectedNextSeq: 1,
        idempotencyKey: "new-stale-write",
        events: [event(1, "must fail")],
      }),
    ).rejects.toMatchObject({ code: "WRITER_FENCED" });
    expect((await authority.snapshot("session-1")).events).toHaveLength(1);
  });

  it("allows a handoff code to be consumed only once", async () => {
    const handoff = await authority.createHandoff({ sessionId: "session-1", writer });
    await authority.acceptHandoff({ code: handoff.code, deviceId: "mac-home" });
    await expect(
      authority.acceptHandoff({ code: handoff.code, deviceId: "third-device" }),
    ).rejects.toMatchObject({ code: "HANDOFF_CONSUMED" });
  });

  it("rejects an expired handoff without changing the writer epoch", async () => {
    let now = 1_000;
    const timed = new TeleportAuthority(database, {
      now: () => now,
      defaultHandoffTtlMs: 100,
    });
    const handoff = await timed.createHandoff({ sessionId: "session-1", writer });
    now = 1_101;
    await expect(
      timed.acceptHandoff({ code: handoff.code, deviceId: "late-device" }),
    ).rejects.toMatchObject({ code: "HANDOFF_EXPIRED" });
    expect((await timed.snapshot("session-1")).writerEpoch).toBe(1);
  });

  it("reads a suffix without changing the snapshot revision", async () => {
    await authority.append({
      sessionId: "session-1",
      writer,
      expectedRevision: 0,
      expectedNextSeq: 0,
      idempotencyKey: "suffix-batch",
      events: [event(0, "zero"), event(1, "one"), event(2, "two")],
    });
    const suffix = await authority.snapshot("session-1", 0);
    expect(suffix.events.map((item) => item.seq)).toEqual([1, 2]);
    expect(suffix).toMatchObject({ revision: 1, nextSeq: 3 });
  });
});
