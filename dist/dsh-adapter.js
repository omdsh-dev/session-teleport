import { mkdir, open as openFile } from "node:fs/promises";
import { join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";
import {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
  assertContiguous,
  assertStoredId,
  assertVersion,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents
} from "@deepseek-ai/dsh-session-persistence";
import {
  SessionLogOffset
} from "@deepseek-ai/dsh-session";
import { SCHEMA_VERSION } from "./schema.js";
import { canonicalJson, secret, sha256 } from "./canonical.js";
import { FileWriterCredentialStore } from "./credential-store.js";
import { TeleportClient, TeleportRemoteError } from "./client.js";
class SessionPersistenceTeleport extends SessionPersistence {
  constructor(ctx, config, dependencies = {}) {
    validateConfig(config);
    super(ctx);
    this.config = config;
    this.client = dependencies.client ?? new TeleportClient(config.baseUrl, config.apiToken);
    this.credentials = dependencies.credentialStore ?? new FileWriterCredentialStore(config.credentialDir);
    this.ctx.on("session/event", (session, event) => {
      this.writers.get(session.id)?.enqueue(event, (error) => {
        this.ctx.logger.warn(`Teleport background write failed for ${session.id}; buffered events retained: ${String(error)}`);
      });
    });
    this.ctx.on("session/flush", (session) => this.writers.get(session.id)?.flush());
    this.ctx.on("session/disposed", (session) => {
      this.writers.get(session.id)?.close().catch((error) => {
        this.ctx.logger.warn(`Teleport close failed for ${session.id}: ${String(error)}`);
      });
    });
    this.ctx.effect(() => async () => {
      const results = await Promise.allSettled([...this.handles].map((handle) => handle.close()));
      throwFailures(results, "Teleport handle teardown failed");
    }, "Teleport open handles");
  }
  config;
  static inject = ["sessions"];
  name = "session-persistence-teleport";
  client;
  credentials;
  writers = /* @__PURE__ */ new Map();
  handles = /* @__PURE__ */ new Set();
  sourceIdentity = secret();
  async [Service.init]() {
    await this.client.health(AbortSignal.timeout(this.config.healthTimeoutMs ?? 5e3), SCHEMA_VERSION);
  }
  async create(header, options) {
    options?.signal?.throwIfAborted();
    const meta = materializeCreateHeader(header);
    assertVersion(meta);
    const inheritedEventCount = inheritedCount(meta, options?.inheritedEventCount);
    if (this.writers.has(meta.id)) throw new SessionAlreadyExistsError(meta.id);
    this.writers.set(meta.id, null);
    let lock;
    try {
      lock = await this.acquireLock(meta.id);
      if (await this.stat(meta.id, options)) throw new SessionAlreadyExistsError(meta.id);
      options?.signal?.throwIfAborted();
      let writer = await this.credentials.get(meta.id);
      if (writer === void 0) {
        writer = { deviceId: this.config.deviceId, writerEpoch: 1, writerToken: secret() };
        await this.credentials.put(meta.id, writer);
      }
      this.assertDevice(meta.id, writer);
      const result = await this.client.materializeSession({
        sessionId: meta.id,
        header: meta,
        inheritedEventCount,
        deviceId: writer.deviceId,
        writerToken: writer.writerToken,
        idempotencyKey: `dsh-create-${sha256(canonicalJson({ meta, inheritedEventCount, token: writer.writerToken }))}`,
        events: []
      });
      return this.adopt(new TeleportHandle(
        this.client,
        meta,
        inheritedEventCount,
        "write",
        result.revision,
        0,
        writer,
        lock,
        (handle) => this.release(handle)
      ));
    } catch (error) {
      this.writers.delete(meta.id);
      await lock?.close();
      if (remoteCode(error, "SESSION_EXISTS")) throw new SessionAlreadyExistsError(meta.id);
      throw error;
    }
  }
  async open(id, access, options) {
    options?.signal?.throwIfAborted();
    if (access !== "read" && access !== "write") throw new TypeError("invalid session access");
    if (access === "write") {
      if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id);
      this.writers.set(id, null);
    }
    let lock;
    try {
      if (access === "write") lock = await this.acquireLock(id);
      const stored = await this.client.snapshot(id, -1, options?.signal);
      const meta = storedHeader(id, stored);
      const cut = inheritedCount(meta, stored.inheritedEventCount);
      validateStoredEvents(meta, cloneEvents(stored.events));
      assertContiguous(id, stored.events, 0);
      if (stored.events.length !== stored.nextSeq) throw new Error(`Incomplete Teleport log for ${id}`);
      options?.signal?.throwIfAborted();
      const writer = access === "write" ? await this.requireWriter(id) : void 0;
      if (writer !== void 0 && (writer.writerEpoch !== stored.writerEpoch || writer.deviceId !== stored.writerDeviceId)) {
        throw new SessionOwnershipLostError(id);
      }
      return this.adopt(new TeleportHandle(
        this.client,
        meta,
        cut,
        access,
        stored.revision,
        stored.nextSeq,
        writer,
        lock,
        (handle) => this.release(handle)
      ));
    } catch (error) {
      if (access === "write") this.writers.delete(id);
      await lock?.close();
      if (remoteCode(error, "NOT_FOUND")) throw new SessionPersistenceNotFoundError(id);
      throw error;
    }
  }
  async flush() {
    const results = await Promise.allSettled([...this.writers.values()].map(async (handle) => {
      try {
        await handle?.flush();
      } catch (error) {
        if (error instanceof SessionHandleClosedError) await handle?.close();
        else throw error;
      }
    }));
    throwFailures(results, "Teleport flush failed");
  }
  async stat(id, options) {
    try {
      return this.snapshot(await this.client.head(id, options?.signal));
    } catch (error) {
      if (remoteCode(error, "NOT_FOUND")) return void 0;
      throw error;
    }
  }
  async list(options) {
    return (await this.client.listHeads(options?.signal)).map((head) => this.snapshot(head));
  }
  async createHandoff(id, ttlMs) {
    await this.writers.get(id)?.flush();
    return this.client.createHandoff({
      sessionId: id,
      writer: await this.requireWriter(id),
      ...ttlMs === void 0 ? {} : { ttlMs }
    });
  }
  async acceptHandoff(code) {
    const result = await this.client.acceptHandoff({ code, deviceId: this.config.deviceId });
    await this.credentials.put(result.sessionId, result.writer);
    return structuredClone(result.writer);
  }
  snapshot(head) {
    return {
      header: structuredClone(head.header),
      revision: SessionPersistenceRevision(`teleport:${this.sourceIdentity}:${head.sessionId}:${head.revision}`),
      eventCount: head.nextSeq
    };
  }
  adopt(handle) {
    this.handles.add(handle);
    if (handle.access === "write") this.writers.set(handle.id, handle);
    return handle;
  }
  release(handle) {
    this.handles.delete(handle);
    if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id);
  }
  async requireWriter(id) {
    const writer = await this.credentials.get(id);
    if (writer === void 0) throw new SessionAlreadyOwnedError(id);
    this.assertDevice(id, writer);
    return writer;
  }
  assertDevice(id, writer) {
    if (writer.deviceId !== this.config.deviceId) throw new SessionOwnershipLostError(id);
  }
  async acquireLock(id) {
    const directory = join(this.config.credentialDir, "locks");
    await mkdir(directory, { recursive: true, mode: 448 });
    const lock = await openFile(join(directory, `${sha256(id)}.lock`), "a", 384);
    try {
      await tryLockExclusive(lock.fd);
      return lock;
    } catch (error) {
      await lock.close();
      if (error instanceof Error && "code" in error && ["EAGAIN", "EWOULDBLOCK"].includes(String(error.code))) {
        throw new SessionAlreadyOwnedError(id);
      }
      throw error;
    }
  }
}
class TeleportHandle {
  constructor(client, header, inheritedEventCount, access, revision, cursor, writer, lock, release) {
    this.client = client;
    this.inheritedEventCount = inheritedEventCount;
    this.access = access;
    this.revision = revision;
    this.cursor = cursor;
    this.writer = writer;
    this.lock = lock;
    this.release = release;
    this.id = header.id;
    this.header = freezeHeader(header);
    this.observedLength = cursor;
  }
  client;
  inheritedEventCount;
  access;
  revision;
  cursor;
  writer;
  lock;
  release;
  id;
  header;
  chain = Promise.resolve();
  closing;
  lost = false;
  pending = [];
  retryBatch;
  timer;
  automaticPaused = false;
  reportBackgroundError;
  observedLength;
  read(offset = 0, length = Number.MAX_SAFE_INTEGER, options) {
    return this.run("read", async () => {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
        throw new TypeError("read offset and length must be non-negative safe integers");
      }
      const stored = await this.client.snapshot(this.id, -1, options?.signal);
      const meta = storedHeader(this.id, stored);
      if (canonicalJson(meta) !== canonicalJson(this.header) || inheritedCount(meta, stored.inheritedEventCount) !== this.inheritedEventCount) {
        throw new Error(`Teleport metadata changed for ${this.id}`);
      }
      const events = validateStoredEvents(meta, cloneEvents(stored.events));
      assertContiguous(this.id, events, 0);
      if (events.length < this.observedLength || events.length !== stored.nextSeq) {
        throw new Error(`Teleport log shrank or is incomplete for ${this.id}`);
      }
      this.observedLength = events.length;
      return { events: events.slice(offset, offset + length), eventState: "detached" };
    });
  }
  append(events, options) {
    let batch;
    try {
      this.assertOpen("append");
      batch = materializeAppendBatch(events);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.run("append", async () => {
      this.assertWritable("append");
      options?.signal?.throwIfAborted();
      await this.drain();
      await this.persist(batch);
    });
  }
  flush(options) {
    return this.run("flush", async () => {
      this.assertWritable("flush");
      options?.signal?.throwIfAborted();
      await this.drain();
      const head = await this.client.head(this.id);
      if (head.writerEpoch !== this.writer.writerEpoch || head.writerDeviceId !== this.writer.deviceId) {
        this.lost = true;
        throw new SessionOwnershipLostError(this.id);
      }
      this.automaticPaused = false;
      this.scheduleBackground();
    });
  }
  enqueue(event, onError) {
    if (this.closing !== void 0 || this.lost) return;
    this.pending.push(...materializeAppendBatch([event]));
    this.reportBackgroundError = onError;
    this.scheduleBackground();
  }
  scheduleBackground() {
    if (this.pending.length === 0 || this.automaticPaused || this.closing !== void 0 || this.timer !== void 0) return;
    this.timer = setTimeout(() => {
      this.timer = void 0;
      void this.flush().catch((error) => {
        this.automaticPaused = true;
        if (this.timer !== void 0) clearTimeout(this.timer);
        this.timer = void 0;
        this.reportBackgroundError?.(error);
      });
    }, 200);
    this.timer.unref();
  }
  close() {
    if (this.closing !== void 0) return this.closing;
    if (this.timer !== void 0) clearTimeout(this.timer);
    this.closing = this.chain.then(async () => {
      try {
        if (this.access === "write") await this.drain();
      } finally {
        try {
          await this.lock?.close();
        } finally {
          this.release(this);
        }
      }
    });
    return this.closing;
  }
  [Symbol.asyncDispose]() {
    return this.close();
  }
  run(operation, work) {
    try {
      this.assertOpen(operation);
    } catch (error) {
      return Promise.reject(error);
    }
    const result = this.chain.then(work);
    this.chain = result.then(() => {
    }, () => {
    });
    return result;
  }
  assertOpen(operation) {
    if (this.closing !== void 0) throw new SessionHandleClosedError(this.id, operation);
  }
  assertWritable(operation) {
    if (this.access !== "write") throw new SessionReadOnlyError(this.id, operation);
    if (this.lost) throw new SessionOwnershipLostError(this.id);
  }
  async drain() {
    while (this.pending.length > 0) {
      const batch = this.retryBatch ??= this.pending.slice();
      await this.persist(batch);
      this.pending.splice(0, batch.length);
      this.retryBatch = void 0;
    }
  }
  async persist(batch) {
    this.assertWritable("append");
    if (batch.length === 0) return;
    assertContiguous(this.id, batch, this.cursor);
    validateStoredEvents(this.header, [...batch]);
    try {
      const result = await this.client.append({
        sessionId: this.id,
        writer: this.writer,
        expectedRevision: this.revision,
        expectedNextSeq: this.cursor,
        idempotencyKey: `dsh-append-${sha256(canonicalJson({ id: this.id, revision: this.revision, cursor: this.cursor, batch }))}`,
        events: structuredClone(batch)
      });
      this.revision = result.revision;
      this.cursor = result.nextSeq;
      this.observedLength = Math.max(this.observedLength, this.cursor);
    } catch (error) {
      if (remoteCode(error, "WRITER_FENCED") || remoteCode(error, "REVISION_CONFLICT") || remoteCode(error, "SEQ_CONFLICT")) {
        this.lost = true;
        throw new SessionOwnershipLostError(this.id);
      }
      throw error;
    }
  }
}
function storedHeader(id, stored) {
  const header = structuredClone(stored.header);
  assertVersion(header);
  const meta = materializeCreateHeader(header);
  assertStoredId(id, meta);
  return meta;
}
function inheritedCount(header, value) {
  if (typeof header.isSeeded !== "boolean") throw new TypeError("session header requires isSeeded");
  if (header.isSeeded && value === void 0) throw new TypeError("seeded sessions require inheritedEventCount");
  const count = SessionLogOffset(value ?? 0);
  if (!header.isSeeded && count !== 0) throw new TypeError("unseeded sessions require inheritedEventCount=0");
  return count;
}
function cloneEvents(events) {
  return structuredClone(events);
}
function remoteCode(error, code) {
  return error instanceof TeleportRemoteError && error.code === code;
}
function throwFailures(results, message) {
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, message);
}
function validateConfig(config) {
  for (const key of ["baseUrl", "deviceId", "credentialDir"]) {
    if (typeof config[key] !== "string" || config[key].trim().length === 0) throw new TypeError(`${key} must not be empty`);
  }
  if (config.healthTimeoutMs !== void 0 && (!Number.isSafeInteger(config.healthTimeoutMs) || config.healthTimeoutMs <= 0)) {
    throw new TypeError("healthTimeoutMs must be a positive safe integer");
  }
}
var dsh_adapter_default = SessionPersistenceTeleport;
function freezeHeader(header) {
  const pending = [header];
  while (pending.length) {
    const value = pending.pop();
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(value);
  }
  return header;
}
export {
  SessionPersistenceTeleport,
  dsh_adapter_default as default
};
//# sourceMappingURL=dsh-adapter.js.map
