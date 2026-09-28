import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Session, SessionStore, SessionId, SessionSeq, SESSION_FORMAT_VERSION,
  type SessionHeader, type SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionHandleClosedError,
  SessionReadOnlyError, SessionOwnershipLostError, SessionFormatUnsupportedError } from "@deepseek-ai/dsh-session-persistence";
import JsonlPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { SessionPersistenceTeleport } from "../src/dsh-adapter.js";
import { TeleportAuthority } from "../src/authority.js";
import { TeleportClient } from "../src/client.js";
import { MemoryWriterCredentialStore } from "../src/credential-store.js";
import { SessionImporter, MemoryImportReceiptStore, exportSessionImportBundle } from "../src/importer.js";
import { initializeSchema } from "../src/schema.js";
import { createTeleportServer, type RunningTeleportServer } from "../src/server.js";
import { PgliteDatabase } from "./pglite.js";

const id = SessionId("adapter-session");
const header: SessionHeader = { id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false };
const event = (seq: number): SessionEvent => ({ type: "turn/start", seq: SessionSeq(seq), time: seq + 1, data: { turn: seq } });

describe("DSH 0.2 handle contract over HTTP authority", () => {
  let database: PgliteDatabase;
  let app: RunningTeleportServer;
  let root: string;
  let client: TeleportClient;
  let credentials: MemoryWriterCredentialStore;
  let backend: SessionPersistenceTeleport;
  let ctx: Context;
  const contexts: Context[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "teleport-adapter-"));
    database = new PgliteDatabase();
    await initializeSchema(database);
    app = createTeleportServer(new TeleportAuthority(database), { apiToken: "test-token", adminToken: "admin-token" });
    client = new TeleportClient((await app.listen()).url, "test-token", "admin-token");
    credentials = new MemoryWriterCredentialStore();
    ({ ctx, backend } = setup("device-a", credentials));
  });
  afterEach(async () => {
    // Close through Cordis effects as production teardown does.
    await Promise.allSettled(contexts.splice(0).map((context) => context.fiber.dispose()));
    await app.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  });
  function setup(deviceId: string, store = new MemoryWriterCredentialStore()) {
    const context = new Context();
    new SessionStore(context);
    const persistence = new SessionPersistenceTeleport(context, {
      baseUrl: "http://unused.invalid", deviceId, credentialDir: join(root, deviceId),
    }, { client, credentialStore: store });
    contexts.push(context);
    return { ctx: context, backend: persistence };
  }

  it("materializes an empty session, returns immutable slices, and enforces handle lifetime", async () => {
    const writer = await backend.create(header);
    await writer.flush();
    expect(await backend.stat(id)).toMatchObject({ header, eventCount: 0 });
    const initial = (await backend.stat(id))!.revision;
    const reader = await backend.open(id, "read");
    await expect(backend.create(header)).rejects.toBeInstanceOf(SessionAlreadyExistsError);
    await expect(backend.open(id, "write")).rejects.toBeInstanceOf(SessionAlreadyOwnedError);
    await expect(reader.append([])).rejects.toBeInstanceOf(SessionReadOnlyError);
    await expect(reader.flush()).rejects.toBeInstanceOf(SessionReadOnlyError);
    const batch = [event(0), event(1)];
    const append = writer.append(batch);
    (batch[0]!.data as { turn: number }).turn = 999;
    await append;
    expect((await reader.read()).events).toEqual([event(0), event(1)]);
    expect((await reader.read(1, 1)).events).toEqual([event(1)]);
    expect((await reader.read(99)).events).toEqual([]);
    const detached = await reader.read();
    expect(detached.eventState).toBe("detached");
    (detached.events[0]!.data as { turn: number }).turn = 42;
    expect((await reader.read()).events).toEqual([event(0), event(1)]);
    expect((await backend.stat(id))!.revision).not.toBe(initial);
    expect(await backend.list()).toHaveLength(1);
    await expect(reader.read(-1)).rejects.toThrow();
    await reader.close();
    await reader.close();
    await expect(reader.read()).rejects.toBeInstanceOf(SessionHandleClosedError);
    await writer.close();
    const reopened = await backend.open(id, "write");
    await reopened.append([event(2)]);
    await reopened.close();
  });

  it("routes real SessionStore events and flush, retaining an exact response-loss batch", async () => {
    const writer = await backend.create(header);
    const session = ctx.sessions.create(id, { meta: { createdAt: 1 } });
    const append = client.append.bind(client);
    const spy = vi.spyOn(client, "append").mockImplementationOnce(async (request) => {
      await append(request);
      throw new Error("response lost after commit");
    });
    session.append("turn/start", { turn: 1 });
    await expect(ctx.sessions.flush(session)).rejects.toThrow("response lost");
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await expect(ctx.sessions.flush(session)).resolves.toBe(true);
    expect((await writer.read()).events.map((e) => e.type)).toEqual(["turn/start", "turn/end"]);
    expect(spy.mock.calls[0]![0].idempotencyKey).toBe(spy.mock.calls[1]![0].idempotencyKey);
    expect(spy).toHaveBeenCalledTimes(3);
    await writer.close();
  });

  it("drains accepted live events on Cordis disposal and releases the OS writer lock", async () => {
    await backend.create(header);
    const session = ctx.sessions.create(id, { meta: { createdAt: 1 } });
    session.append("turn/start", { turn: 1 });
    await ctx.fiber.dispose();
    expect((await client.snapshot(id)).events).toHaveLength(1);
    const replacement = setup("device-a", credentials).backend;
    const handle = await replacement.open(id, "write");
    await handle.close();
  });

  it("finishes a durability barrier when cancellation arrives after its write starts", async () => {
    const writer = await backend.create(header);
    const session = ctx.sessions.create(id, { meta: { createdAt: 1 } });
    const controller = new AbortController();
    const append = client.append.bind(client);
    vi.spyOn(client, "append").mockImplementationOnce(async (request) => {
      const result = await append(request);
      controller.abort(new Error("cancelled after commit"));
      return result;
    });
    session.append("turn/start", { turn: 1 });
    await expect(writer.flush({ signal: controller.signal })).resolves.toBeUndefined();
    expect((await writer.read()).events).toHaveLength(1);
    await writer.close();
  });

  it("pauses automatic writes after failure until an explicit flush retries the retained batch", async () => {
    const writer = await backend.create(header);
    const session = ctx.sessions.create(id, { meta: { createdAt: 1 } });
    const spy = vi.spyOn(client, "append").mockRejectedValueOnce(new Error("temporary network failure"));
    session.append("turn/start", { turn: 1 });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spy).toHaveBeenCalledTimes(1);
    await ctx.sessions.flush(session);
    expect((await writer.read()).events).toHaveLength(2);
    expect(spy.mock.calls[0]![0].idempotencyKey).toBe(spy.mock.calls[1]![0].idempotencyKey);
    await writer.close();
  });

  it("blocks a second writer with the same credential directory and fences the old device on handoff", async () => {
    const writer = await backend.create(header);
    const duplicate = setup("device-a", credentials).backend;
    await expect(duplicate.open(id, "write")).rejects.toBeInstanceOf(SessionAlreadyOwnedError);
    const remote = setup("device-b").backend;
    await expect(remote.open(id, "write")).rejects.toBeInstanceOf(SessionAlreadyOwnedError);
    const before = (await backend.stat(id))!.revision;
    const handoff = await backend.createHandoff(id);
    await remote.acceptHandoff(handoff.code);
    expect((await backend.stat(id))!.revision).toBe(before);
    await expect(writer.flush()).rejects.toBeInstanceOf(SessionOwnershipLostError);
    await expect(writer.append([event(0)])).rejects.toBeInstanceOf(SessionOwnershipLostError);
    const current = await remote.open(id, "write");
    await current.append([event(0)]);
    expect((await writer.read()).events).toEqual([event(0)]);
    await current.close();
    await writer.close();
    await expect(backend.open(id, "write")).rejects.toBeInstanceOf(SessionOwnershipLostError);
  });

  it("preserves a real JSONL fork's inherited cut through export, import, and restore", async () => {
    const jsonlContext = new Context();
    new SessionStore(jsonlContext);
    contexts.push(jsonlContext);
    const jsonl = new JsonlPersistence(jsonlContext, { root: join(root, "jsonl") });
    const parent = jsonlContext.sessions.create(SessionId("parent"));
    parent.append("turn/start", { turn: 1 });
    parent.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    const child = jsonlContext.sessions.fork(parent, SessionSeq(1), SessionId("fork"));
    const handle = await jsonl.create(child.header, { inheritedEventCount: child.inheritedEventCount });
    await handle.append(child.snapshotEvents());
    await handle.flush();
    await handle.close();
    const bundle = await exportSessionImportBundle(jsonl, child.id);
    expect(bundle.inheritedEventCount).toBe(2);
    const importer = new SessionImporter(client, credentials, new MemoryImportReceiptStore(), { deviceId: "device-a" });
    await importer.apply(bundle);
    expect(await importer.dryRun(bundle)).toMatchObject({ targetStatus: "already-present" });
    const restored = await backend.open(child.id, "write");
    expect(restored.inheritedEventCount).toBe(child.inheritedEventCount);
    const read = await restored.read();
    expect(Session.fromRestore(child.id, [...read.events], restored.header, restored.inheritedEventCount, read.eventState).inheritedEventCount).toBe(2);
    await restored.close();
  });

  it("supports empty imports and rollback and closes capture handles even after a failed read", async () => {
    const writer = await backend.create(header);
    await writer.close();
    const bundle = await exportSessionImportBundle(backend, id);
    bundle.header = { ...header, id: "empty-import" };
    const importer = new SessionImporter(client, credentials, new MemoryImportReceiptStore(), { deviceId: "device-a" });
    await expect(importer.apply(bundle)).resolves.toMatchObject({ nextSeq: 0 });
    await expect(importer.rollback("empty-import", "test rollback")).resolves.toMatchObject({ rolledBack: true });
    const close = vi.fn(async () => {});
    await expect(exportSessionImportBundle({ open: async () => ({ header, inheritedEventCount: 0,
      read: async () => { throw new Error("capture read failed"); }, close }) }, id)).rejects.toThrow("capture read failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("refuses retired formats and unknown required events, and honors pre-aborted operations", async () => {
    await expect(backend.create({ ...header, version: 0 } as unknown as SessionHeader)).rejects.toBeInstanceOf(SessionFormatUnsupportedError);
    const writer = await backend.create(header);
    const unknown = { ...event(0), type: "future/required" } as unknown as SessionEvent;
    await expect(writer.append([unknown])).rejects.toBeInstanceOf(SessionFormatUnsupportedError);
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(writer.append([event(0)], { signal })).rejects.toThrow("cancelled");
    await expect(backend.open(id, "read", { signal })).rejects.toThrow("cancelled");
    expect((await writer.read()).events).toEqual([]);
    await writer.append([{ ...unknown, ignorable: true }]);
    await writer.close();
  });
});
