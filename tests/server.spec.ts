import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TeleportAuthority } from "../src/authority.js";
import { TeleportClient } from "../src/client.js";
import { initializeSchema } from "../src/schema.js";
import { createTeleportServer, type RunningTeleportServer } from "../src/server.js";
import { PgliteDatabase } from "./pglite.js";

describe("Teleport HTTP API", () => {
  let database: PgliteDatabase;
  let authority: TeleportAuthority;
  let app: RunningTeleportServer;
  let baseUrl: string;

  beforeEach(async () => {
    database = new PgliteDatabase();
    await initializeSchema(database);
    authority = new TeleportAuthority(database);
    app = createTeleportServer(authority, {
      apiToken: "test-token",
      adminToken: "admin-token",
    });
    baseUrl = (await app.listen()).url;
  });

  afterEach(async () => {
    await app.close();
    await database.close();
  });

  it("exposes create, append, snapshot and handoff as one authenticated vertical slice", async () => {
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/sessions/demo`)).status).toBe(401);
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };

    const createdResponse = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: "demo",
        header: { version: 0 },
        deviceId: "office",
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { writer: unknown };

    const appended = await fetch(`${baseUrl}/v1/sessions/demo/append`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        writer: created.writer,
        expectedRevision: 0,
        expectedNextSeq: 0,
        idempotencyKey: "http-batch",
        events: [{ type: "user/message", seq: 0, time: 1, data: { text: "hello" } }],
      }),
    });
    expect(appended.status).toBe(200);
    expect(await appended.json()).toMatchObject({ revision: 1, nextSeq: 1 });

    const snapshot = await fetch(`${baseUrl}/v1/sessions/demo`, { headers });
    expect(await snapshot.json()).toMatchObject({
      revision: 1,
      nextSeq: 1,
      events: [{ type: "user/message", seq: 0 }],
    });

    const handoffResponse = await fetch(`${baseUrl}/v1/sessions/demo/handoffs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ writer: created.writer }),
    });
    const handoff = (await handoffResponse.json()) as { code: string };
    const acceptedResponse = await fetch(
      `${baseUrl}/v1/handoffs/${encodeURIComponent(handoff.code)}/accept`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ deviceId: "home" }),
      },
    );
    expect(await acceptedResponse.json()).toMatchObject({
      sessionId: "demo",
      writer: { deviceId: "home", writerEpoch: 2 },
    });
  });

  it("provides a typed client for the DSH persistence adapter", async () => {
    const client = new TeleportClient(baseUrl, "test-token");
    const created = await client.createSession({
      sessionId: "typed-client",
      header: { version: 0 },
      deviceId: "office",
    });
    await client.append({
      sessionId: "typed-client",
      writer: created.writer,
      expectedRevision: 0,
      expectedNextSeq: 0,
      idempotencyKey: "typed-client-batch",
      events: [{ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }],
    });
    expect(await client.snapshot("typed-client")).toMatchObject({
      revision: 1,
      events: [{ type: "turn/start", seq: 0 }],
    });
    const handoff = await client.createHandoff({
      sessionId: "typed-client",
      writer: created.writer,
    });
    expect(
      await client.acceptHandoff({ code: handoff.code, deviceId: "home" }),
    ).toMatchObject({ writer: { writerEpoch: 2, deviceId: "home" } });
  });

  it("requires a separate admin token for idempotent writer recovery and audit", async () => {
    const regular = new TeleportClient(baseUrl, "test-token");
    await regular.createSession({
      sessionId: "recovery-api",
      header: { version: 0 },
      deviceId: "lost-device",
    });
    const body = {
      expectedRevision: 0,
      expectedWriterEpoch: 1,
      deviceId: "replacement-device",
      writerToken: "replacement-token",
      idempotencyKey: "http-recovery",
      actorId: "test-operator",
      reason: "lost device",
    };
    const forbidden = await fetch(
      `${baseUrl}/v1/admin/sessions/recovery-api/recover-writer`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: "ADMIN_FORBIDDEN" } });

    const admin = new TeleportClient(baseUrl, "test-token", "admin-token");
    expect(await admin.recoverWriter({ sessionId: "recovery-api", ...body })).toMatchObject({
      idempotentReplay: false,
      writer: { deviceId: "replacement-device", writerEpoch: 2 },
    });
    expect(await admin.recoverWriter({ sessionId: "recovery-api", ...body })).toMatchObject({
      idempotentReplay: true,
      writer: { writerEpoch: 2 },
    });
    expect(await admin.writerAudit("recovery-api")).toMatchObject([
      {
        action: "admin_recovery",
        actorId: "test-operator",
        reason: "lost device",
        toDeviceId: "replacement-device",
        toEpoch: 2,
      },
    ]);
  });

  it("protects import rollback with the separate admin token", async () => {
    const regular = new TeleportClient(baseUrl, "test-token");
    await regular.materializeSession({
      sessionId: "rollback-auth",
      header: { id: "rollback-auth", version: 0 },
      deviceId: "import-device",
      writerToken: "import-token",
      idempotencyKey: `dsh-import-${"b".repeat(64)}-${"c".repeat(64)}`,
      events: [{ type: "turn/start", seq: 0, time: 1, data: {} }],
    });
    const forbidden = await fetch(
      `${baseUrl}/v1/admin/sessions/rollback-auth/rollback-import`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedRevision: 1,
          expectedNextSeq: 1,
          expectedWriterEpoch: 1,
          importIdempotencyKey: `dsh-import-${"b".repeat(64)}-${"c".repeat(64)}`,
          actorId: "test-operator",
          reason: "cutover failed",
        }),
      },
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      error: { code: "ADMIN_FORBIDDEN" },
    });
    expect(await regular.head("rollback-auth")).toMatchObject({ revision: 1, nextSeq: 1 });
  });

  it("rejects empty or shared service and admin credentials", () => {
    expect(() => createTeleportServer(authority, { apiToken: "" })).toThrow(/must not be empty/);
    expect(() => createTeleportServer(authority, { adminToken: "" })).toThrow(/must not be empty/);
    expect(() =>
      createTeleportServer(authority, { apiToken: "same-token", adminToken: "same-token" }),
    ).toThrow(/must differ/);
  });

  it("exposes atomic materialization plus lightweight head and list reads", async () => {
    const client = new TeleportClient(baseUrl, "test-token");
    const materialized = await client.materializeSession({
      sessionId: "adapter-lazy",
      header: { version: 0, id: "adapter-lazy", createdAt: 1 },
      deviceId: "office",
      writerToken: "adapter-generated-token",
      idempotencyKey: "adapter-first-batch",
      events: [{ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }],
    });
    expect(materialized).toMatchObject({ revision: 1, nextSeq: 1 });
    expect(await client.head("adapter-lazy")).toMatchObject({
      revision: 1,
      nextSeq: 1,
      header: { id: "adapter-lazy" },
    });
    expect((await client.listHeads()).map((head) => head.sessionId)).toContain("adapter-lazy");
  });

  it("fails malformed JSON, oversized bodies and malformed events with explicit 4xx errors", async () => {
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    const malformed = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers,
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "BAD_JSON" } });

    const limited = createTeleportServer(authority, {
      apiToken: "test-token",
      maxBodyBytes: 32,
    });
    const limitedUrl = (await limited.listen()).url;
    try {
      const oversized = await fetch(`${limitedUrl}/v1/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ padding: "x".repeat(64) }),
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({
        error: { code: "PAYLOAD_TOO_LARGE" },
      });
    } finally {
      await limited.close();
    }

    const client = new TeleportClient(baseUrl, "test-token");
    const created = await client.createSession({
      sessionId: "bad-event",
      header: { version: 0 },
      deviceId: "office",
    });
    const badEvent = await fetch(`${baseUrl}/v1/sessions/bad-event/append`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        writer: created.writer,
        expectedRevision: 0,
        expectedNextSeq: 0,
        idempotencyKey: "bad-event",
        events: [null],
      }),
    });
    expect(badEvent.status).toBe(400);
    expect(await badEvent.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("streams an initial exact snapshot and subsequent append over SSE", async () => {
    const client = new TeleportClient(baseUrl, "test-token");
    const created = await client.createSession({
      sessionId: "watched",
      header: { version: 0 },
      deviceId: "office",
    });
    const controller = new AbortController();
    const response = await fetch(client.watchUrl("watched"), {
      headers: { authorization: "Bearer test-token" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    try {
      const initial = await readUntil(reader, "event: snapshot");
      expect(initial).toContain('"revision":0');
      expect(initial).toContain('"events":[]');

      await client.append({
        sessionId: "watched",
        writer: created.writer,
        expectedRevision: 0,
        expectedNextSeq: 0,
        idempotencyKey: "watched-append",
        events: [{ type: "assistant/chunk", seq: 0, time: 1, data: { text: "live" } }],
      });
      const update = await readUntil(reader, "event: events");
      expect(update).toContain('"revision":1');
      expect(update).toContain('"text":"live"');
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let received = "";
  const deadline = Date.now() + 5_000;
  while (!received.includes(marker) && Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${marker}`)), remaining),
      ),
    ]);
    if (result.done) break;
    received += decoder.decode(result.value, { stream: true });
  }
  expect(received).toContain(marker);
  return received;
}
