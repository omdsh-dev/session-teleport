import { mkdir, open as openFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";
import {
  SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionHandleClosedError,
  SessionOwnershipLostError, SessionPersistence, SessionPersistenceNotFoundError,
  SessionPersistenceRevision, SessionReadOnlyError, assertContiguous, assertStoredId,
  assertVersion, materializeAppendBatch, materializeCreateHeader, validateStoredEvents,
  type SessionAccess, type SessionHandle, type SessionHandleAppendOptions,
  type SessionHandleFlushOptions, type SessionHandleReadOptions, type SessionHandleReadResult,
  type SessionPersistenceCreateOptions, type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions, type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
} from "@deepseek-ai/dsh-session-persistence";
import {
  SessionLogOffset, type SessionEvent, type SessionHeader, type SessionId,
} from "@deepseek-ai/dsh-session";
import { SCHEMA_VERSION } from "./schema.js";
import { canonicalJson, secret, sha256 } from "./canonical.js";
import { FileWriterCredentialStore, type WriterCredentialStore } from "./credential-store.js";
import { TeleportClient, TeleportRemoteError } from "./client.js";
import type { CreateHandoffResult, JsonValue, SessionHead, TeleportEvent, WriterCredentials } from "./types.js";

export interface SessionPersistenceTeleportConfig {
  baseUrl: string;
  apiToken?: string;
  deviceId: string;
  credentialDir: string;
  healthTimeoutMs?: number;
}

export interface SessionPersistenceTeleportDependencies {
  client?: TeleportClient;
  credentialStore?: WriterCredentialStore;
}

/** DSH 0.2 handle-based persistence over the PostgreSQL authority. */
export class SessionPersistenceTeleport extends SessionPersistence {
  static inject = ["sessions"];
  override readonly name = "session-persistence-teleport";
  private readonly client: TeleportClient;
  private readonly credentials: WriterCredentialStore;
  private readonly writers = new Map<SessionId, TeleportHandle | null>();
  private readonly handles = new Set<TeleportHandle>();
  private readonly sourceIdentity = secret();

  constructor(ctx: Context, readonly config: SessionPersistenceTeleportConfig,
    dependencies: SessionPersistenceTeleportDependencies = {}) {
    validateConfig(config);
    super(ctx);
    this.client = dependencies.client ?? new TeleportClient(config.baseUrl, config.apiToken);
    this.credentials = dependencies.credentialStore ?? new FileWriterCredentialStore(config.credentialDir);
    this.ctx.on("session/event", (session, event) => {
      this.writers.get(session.id)?.enqueue(event, (error) => {
        this.ctx.logger.warn(`Teleport background write failed for ${session.id}; buffered events retained: ${String(error)}`);
      });
    });
    this.ctx.on("session/flush", (session) => this.writers.get(session.id)?.flush());
    this.ctx.on("session/disposed", (session) => {
      this.writers.get(session.id)?.close().catch((error: unknown) => {
        this.ctx.logger.warn(`Teleport close failed for ${session.id}: ${String(error)}`);
      });
    });
    this.ctx.effect(() => async () => {
      const results = await Promise.allSettled([...this.handles].map((handle) => handle.close()));
      throwFailures(results, "Teleport handle teardown failed");
    }, "Teleport open handles");
  }

  protected async [Service.init](): Promise<void> {
    await this.client.health(AbortSignal.timeout(this.config.healthTimeoutMs ?? 5_000), SCHEMA_VERSION);
  }

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const meta = materializeCreateHeader(header);
    assertVersion(meta);
    const inheritedEventCount = inheritedCount(meta, options?.inheritedEventCount);
    if (this.writers.has(meta.id)) throw new SessionAlreadyExistsError(meta.id);
    this.writers.set(meta.id, null);
    let lock: FileHandle | undefined;
    try {
      lock = await this.acquireLock(meta.id);
      if (await this.stat(meta.id, options)) throw new SessionAlreadyExistsError(meta.id);
      options?.signal?.throwIfAborted();
      let writer = await this.credentials.get(meta.id);
      if (writer === undefined) {
        writer = { deviceId: this.config.deviceId, writerEpoch: 1, writerToken: secret() };
        // Save retry/recovery material before the remote transaction commits.
        await this.credentials.put(meta.id, writer);
      }
      this.assertDevice(meta.id, writer);
      const result = await this.client.materializeSession({
        sessionId: meta.id, header: meta as unknown as JsonValue, inheritedEventCount,
        deviceId: writer.deviceId, writerToken: writer.writerToken,
        idempotencyKey: `dsh-create-${sha256(canonicalJson({ meta, inheritedEventCount, token: writer.writerToken }))}`,
        events: [],
      });
      return this.adopt(new TeleportHandle(this.client, meta, inheritedEventCount, "write",
        result.revision, 0, writer, lock, (handle) => this.release(handle)));
    } catch (error) {
      this.writers.delete(meta.id);
      await lock?.close();
      if (remoteCode(error, "SESSION_EXISTS")) throw new SessionAlreadyExistsError(meta.id);
      throw error;
    }
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    if (access !== "read" && access !== "write") throw new TypeError("invalid session access");
    if (access === "write") {
      if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id);
      this.writers.set(id, null);
    }
    let lock: FileHandle | undefined;
    try {
      if (access === "write") lock = await this.acquireLock(id);
      const stored = await this.client.snapshot(id, -1, options?.signal);
      const meta = storedHeader(id, stored);
      const cut = inheritedCount(meta, stored.inheritedEventCount);
      validateStoredEvents(meta, cloneEvents(stored.events));
      assertContiguous(id, stored.events as unknown as SessionEvent[], 0);
      if (stored.events.length !== stored.nextSeq) throw new Error(`Incomplete Teleport log for ${id}`);
      options?.signal?.throwIfAborted();
      const writer = access === "write" ? await this.requireWriter(id) : undefined;
      if (writer !== undefined && (writer.writerEpoch !== stored.writerEpoch || writer.deviceId !== stored.writerDeviceId)) {
        throw new SessionOwnershipLostError(id);
      }
      return this.adopt(new TeleportHandle(this.client, meta, cut, access, stored.revision,
        stored.nextSeq, writer, lock, (handle) => this.release(handle)));
    } catch (error) {
      if (access === "write") this.writers.delete(id);
      await lock?.close();
      if (remoteCode(error, "NOT_FOUND")) throw new SessionPersistenceNotFoundError(id);
      throw error;
    }
  }

  async flush(): Promise<void> {
    const results = await Promise.allSettled([...this.writers.values()].map(async (handle) => {
      try { await handle?.flush(); }
      catch (error) {
        if (error instanceof SessionHandleClosedError) await handle?.close();
        else throw error;
      }
    }));
    throwFailures(results, "Teleport flush failed");
  }

  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    try { return this.snapshot(await this.client.head(id, options?.signal)); }
    catch (error) { if (remoteCode(error, "NOT_FOUND")) return undefined; throw error; }
  }

  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    return (await this.client.listHeads(options?.signal)).map((head) => this.snapshot(head));
  }

  async createHandoff(id: SessionId, ttlMs?: number): Promise<CreateHandoffResult> {
    await this.writers.get(id)?.flush();
    return this.client.createHandoff({ sessionId: id, writer: await this.requireWriter(id),
      ...(ttlMs === undefined ? {} : { ttlMs }) });
  }

  async acceptHandoff(code: string): Promise<WriterCredentials> {
    const result = await this.client.acceptHandoff({ code, deviceId: this.config.deviceId });
    await this.credentials.put(result.sessionId, result.writer);
    return structuredClone(result.writer);
  }

  private snapshot(head: SessionHead): SessionPersistenceSnapshot {
    return { header: structuredClone(head.header) as unknown as SessionHeader,
      revision: SessionPersistenceRevision(`teleport:${this.sourceIdentity}:${head.sessionId}:${head.revision}`),
      eventCount: head.nextSeq };
  }

  private adopt(handle: TeleportHandle): TeleportHandle {
    this.handles.add(handle);
    if (handle.access === "write") this.writers.set(handle.id, handle);
    return handle;
  }

  private release(handle: TeleportHandle): void {
    this.handles.delete(handle);
    if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id);
  }

  private async requireWriter(id: string): Promise<WriterCredentials> {
    const writer = await this.credentials.get(id);
    if (writer === undefined) throw new SessionAlreadyOwnedError(id as SessionId);
    this.assertDevice(id, writer);
    return writer;
  }

  private assertDevice(id: string, writer: WriterCredentials): void {
    if (writer.deviceId !== this.config.deviceId) throw new SessionOwnershipLostError(id as SessionId);
  }

  private async acquireLock(id: SessionId): Promise<FileHandle> {
    // The OS releases this lock on process exit. Never unlink its stable inode.
    // All profiles on one device must share credentialDir; device authority is
    // separately fenced by PostgreSQL when a handoff changes the writer epoch.
    const directory = join(this.config.credentialDir, "locks");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = await openFile(join(directory, `${sha256(id)}.lock`), "a", 0o600);
    try { await tryLockExclusive(lock.fd); return lock; }
    catch (error) {
      await lock.close();
      if (error instanceof Error && "code" in error && ["EAGAIN", "EWOULDBLOCK"].includes(String(error.code))) {
        throw new SessionAlreadyOwnedError(id);
      }
      throw error;
    }
  }
}

class TeleportHandle implements SessionHandle {
  readonly id: SessionId;
  readonly header: SessionHeader;
  private chain: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private lost = false;
  private pending: SessionEvent[] = [];
  private retryBatch: SessionEvent[] | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private automaticPaused = false;
  private reportBackgroundError: ((error: unknown) => void) | undefined;
  private observedLength: number;

  constructor(private readonly client: TeleportClient, header: SessionHeader,
    readonly inheritedEventCount: SessionLogOffset, readonly access: SessionAccess,
    private revision: number, private cursor: number, private readonly writer: WriterCredentials | undefined,
    private readonly lock: FileHandle | undefined, private readonly release: (handle: TeleportHandle) => void) {
    this.id = header.id;
    this.header = freezeHeader(header);
    this.observedLength = cursor;
  }

  read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
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

  append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    // Snapshot synchronously, before the queued write can observe caller mutation.
    let batch: readonly SessionEvent[];
    try { this.assertOpen("append"); batch = materializeAppendBatch(events); }
    catch (error) { return Promise.reject(error); }
    return this.run("append", async () => {
      this.assertWritable("append");
      options?.signal?.throwIfAborted();
      await this.drain();
      await this.persist(batch);
    });
  }

  flush(options?: SessionHandleFlushOptions): Promise<void> {
    return this.run("flush", async () => {
      this.assertWritable("flush");
      options?.signal?.throwIfAborted();
      await this.drain();
      // Every append already commits a PostgreSQL transaction. Check that this
      // handle still owns the writer even when the barrier has no events.
      const head = await this.client.head(this.id);
      if (head.writerEpoch !== this.writer!.writerEpoch || head.writerDeviceId !== this.writer!.deviceId) {
        this.lost = true;
        throw new SessionOwnershipLostError(this.id);
      }
      this.automaticPaused = false;
      this.scheduleBackground();
    });
  }

  enqueue(event: SessionEvent, onError: (error: unknown) => void): void {
    if (this.closing !== undefined || this.lost) return;
    this.pending.push(...materializeAppendBatch([event]));
    this.reportBackgroundError = onError;
    this.scheduleBackground();
  }

  private scheduleBackground(): void {
    if (this.pending.length === 0 || this.automaticPaused || this.closing !== undefined || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Pause automatic retries on failure; an explicit flush retries the exact
      // retained batch and resumes the automatic path only after success.
      void this.flush().catch((error: unknown) => {
        this.automaticPaused = true;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        this.reportBackgroundError?.(error);
      });
    }, 200);
    this.timer.unref();
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.closing = this.chain.then(async () => {
      try { if (this.access === "write") await this.drain(); }
      finally { try { await this.lock?.close(); } finally { this.release(this); } }
    });
    return this.closing;
  }

  [Symbol.asyncDispose](): Promise<void> { return this.close(); }

  private run<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try { this.assertOpen(operation); } catch (error) { return Promise.reject(error); }
    const result = this.chain.then(work);
    this.chain = result.then(() => {}, () => {});
    return result;
  }

  private assertOpen(operation: string): void {
    if (this.closing !== undefined) throw new SessionHandleClosedError(this.id, operation);
  }

  private assertWritable(operation: string): void {
    if (this.access !== "write") throw new SessionReadOnlyError(this.id, operation);
    if (this.lost) throw new SessionOwnershipLostError(this.id);
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      // Preserve a failed request's exact batch and idempotency identity, even
      // if more live events arrive after a commit whose response was lost.
      const batch = this.retryBatch ??= this.pending.slice();
      await this.persist(batch);
      this.pending.splice(0, batch.length);
      this.retryBatch = undefined;
    }
  }

  private async persist(batch: readonly SessionEvent[]): Promise<void> {
    this.assertWritable("append");
    if (batch.length === 0) return;
    assertContiguous(this.id, batch, this.cursor);
    // Validate required vocabulary and the exact records being written, too.
    validateStoredEvents(this.header, [...batch]);
    try {
      const result = await this.client.append({ sessionId: this.id, writer: this.writer!,
        expectedRevision: this.revision, expectedNextSeq: this.cursor,
        idempotencyKey: `dsh-append-${sha256(canonicalJson({ id: this.id, revision: this.revision, cursor: this.cursor, batch }))}`,
        events: structuredClone(batch) as unknown as TeleportEvent[] });
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

function storedHeader(id: SessionId, stored: SessionHead): SessionHeader {
  const header = structuredClone(stored.header) as unknown as SessionHeader;
  assertVersion(header);
  const meta = materializeCreateHeader(header);
  assertStoredId(id, meta);
  return meta;
}

function inheritedCount(header: SessionHeader, value?: number): SessionLogOffset {
  if (typeof header.isSeeded !== "boolean") throw new TypeError("session header requires isSeeded");
  if (header.isSeeded && value === undefined) throw new TypeError("seeded sessions require inheritedEventCount");
  const count = SessionLogOffset(value ?? 0);
  if (!header.isSeeded && count !== 0) throw new TypeError("unseeded sessions require inheritedEventCount=0");
  return count;
}

function cloneEvents(events: TeleportEvent[]): SessionEvent[] {
  return structuredClone(events) as unknown as SessionEvent[];
}

function remoteCode(error: unknown, code: string): boolean {
  return error instanceof TeleportRemoteError && error.code === code;
}

function throwFailures(results: PromiseSettledResult<unknown>[], message: string): void {
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason as unknown);
  if (failures.length) throw new AggregateError(failures, message);
}

function validateConfig(config: SessionPersistenceTeleportConfig): void {
  for (const key of ["baseUrl", "deviceId", "credentialDir"] as const) {
    if (typeof config[key] !== "string" || config[key].trim().length === 0) throw new TypeError(`${key} must not be empty`);
  }
  if (config.healthTimeoutMs !== undefined && (!Number.isSafeInteger(config.healthTimeoutMs) || config.healthTimeoutMs <= 0)) {
    throw new TypeError("healthTimeoutMs must be a positive safe integer");
  }
}

export default SessionPersistenceTeleport;

function freezeHeader(header: SessionHeader): SessionHeader {
  const pending: object[] = [header];
  while (pending.length) {
    const value = pending.pop()!;
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(value);
  }
  return header;
}
