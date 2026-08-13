import { Context } from "@deepseek-ai/cordis";
import {
  PersistenceCoordinator,
  SessionPersistence,
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
  type StoredSuffix,
} from "@deepseek-ai/dsh-session-persistence";
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionPreparation,
} from "@deepseek-ai/dsh-session";
import { canonicalJson, secret, sha256 } from "./canonical.js";
import {
  FileWriterCredentialStore,
  type WriterCredentialStore,
} from "./credential-store.js";
import { TeleportClient, TeleportRemoteError } from "./client.js";
import type {
  CreateHandoffResult,
  SessionHead,
  SessionSnapshot,
  TeleportEvent,
  WriterCredentials,
} from "./types.js";

export interface SessionPersistenceTeleportConfig {
  baseUrl: string;
  apiToken?: string;
  deviceId: string;
  credentialDir: string;
}

export interface SessionPersistenceTeleportDependencies {
  client?: TeleportClient;
  credentialStore?: WriterCredentialStore;
}

interface ObservedHead {
  revision: number;
  nextSeq: number;
}

/** DSH PersistenceBackend adapter over the Teleport HTTP authority. */
export class SessionPersistenceTeleport
  extends SessionPersistence
  implements PersistenceBackend<never>
{
  static inject = ["sessions"];

  override readonly name = "session-persistence-teleport";
  override readonly supportsRawArtifacts = false;

  private readonly client: TeleportClient;
  private readonly credentials: WriterCredentialStore;
  private readonly coordinator: PersistenceCoordinator<never>;
  private readonly observedHeads = new Map<string, ObservedHead>();
  private readonly sourceIdentity: string;
  private readonly deviceId: string;

  constructor(
    ctx: Context,
    readonly config: SessionPersistenceTeleportConfig,
    dependencies: SessionPersistenceTeleportDependencies = {},
  ) {
    validateConfig(config);
    super(ctx);
    this.deviceId = config.deviceId;
    const baseUrl = config.baseUrl.replace(/\/$/, "");
    this.sourceIdentity = sha256(baseUrl);
    this.client = dependencies.client ?? new TeleportClient(baseUrl, config.apiToken);
    this.credentials =
      dependencies.credentialStore ?? new FileWriterCredentialStore(config.credentialDir);
    this.coordinator = new PersistenceCoordinator<never>(this.ctx, this);
  }

  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined;
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta);
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events);
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal);
  }

  load(id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }> {
    return this.coordinator.load(id);
  }

  inspect(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }> {
    return this.coordinator.inspect(id, signal);
  }

  readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal);
  }

  async loadStored(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix<never> | undefined> {
    signal?.throwIfAborted();
    let snapshot: SessionSnapshot;
    try {
      snapshot = await this.client.snapshot(id);
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    signal?.throwIfAborted();
    this.observe(id, snapshot.revision, snapshot.nextSeq);
    return {
      meta: cloneHeader(snapshot.header),
      events: cloneEvents(snapshot.events),
      revision: this.revision(id, snapshot.revision),
    };
  }

  async readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted();
    let head: SessionHead;
    try {
      head = await this.client.head(id);
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    signal?.throwIfAborted();
    return this.revision(id, head.revision);
  }

  async loadStoredFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted();
    let snapshot: SessionSnapshot;
    try {
      snapshot = await this.client.snapshot(id, fromSeq - 1);
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    signal?.throwIfAborted();
    return {
      meta: cloneHeader(snapshot.header),
      events: cloneEvents(snapshot.events),
    };
  }

  async appendBatch(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    if (events.length === 0) return;
    const teleportEvents = cloneTeleportEvents(events);
    if (!isMaterialized) {
      let writer = await this.credentials.get(meta.id);
      if (writer === undefined) {
        writer = {
          deviceId: this.deviceId,
          writerEpoch: 1,
          writerToken: secret(),
        };
        // Persist the retry material before the remote commit. If the response
        // is lost, the next coordinator retry can reproduce the same authority.
        await this.credentials.put(meta.id, writer);
      }
      this.assertLocalWriter(meta.id, writer);
      const result = await this.client.materializeSession({
        sessionId: meta.id,
        header: structuredClone(meta) as never,
        deviceId: writer.deviceId,
        writerToken: writer.writerToken,
        idempotencyKey: mutationKey("materialize", meta.id, 0, 0, {
          header: meta,
          events: teleportEvents,
        }),
        events: teleportEvents,
      });
      this.observe(meta.id, result.revision, result.nextSeq);
      return;
    }
    await this.appendExisting(meta.id, teleportEvents);
  }

  async commitRepair(
    meta: SessionHeader,
    _tornMarker: undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    if (closers.length === 0) return;
    await this.appendExisting(meta.id, cloneTeleportEvents(closers));
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted();
    const heads = await this.client.listHeads();
    signal?.throwIfAborted();
    return heads.map((head) => cloneHeader(head.header));
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted();
    const heads = await this.client.listHeads();
    signal?.throwIfAborted();
    return heads.map((head) => ({
      header: cloneHeader(head.header),
      revision: this.revision(head.sessionId, head.revision),
    }));
  }

  async createHandoff(id: SessionId, ttlMs?: number): Promise<CreateHandoffResult> {
    const writer = await this.requireWriter(id);
    return this.client.createHandoff({
      sessionId: id,
      writer,
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
  }

  async acceptHandoff(code: string): Promise<WriterCredentials> {
    const accepted = await this.client.acceptHandoff({ code, deviceId: this.deviceId });
    await this.credentials.put(accepted.sessionId, accepted.writer);
    this.observe(accepted.sessionId, accepted.revision, accepted.nextSeq);
    return structuredClone(accepted.writer);
  }

  private async appendExisting(id: SessionId, events: TeleportEvent[]): Promise<void> {
    const writer = await this.requireWriter(id);
    const observed = this.observedHeads.get(id);
    if (observed === undefined) {
      throw new Error(
        `session "${id}" has no observed Teleport head; load it before appending`,
      );
    }
    const nextSeq = events[0]!.seq;
    if (observed.nextSeq !== nextSeq) {
      throw new Error(
        `Teleport head changed for "${id}": observed next seq ${observed.nextSeq}, append starts at ${nextSeq}`,
      );
    }
    const result = await this.client.append({
      sessionId: id,
      writer,
      expectedRevision: observed.revision,
      expectedNextSeq: observed.nextSeq,
      idempotencyKey: mutationKey(
        "append",
        id,
        observed.revision,
        observed.nextSeq,
        events,
      ),
      events,
    });
    this.observe(id, result.revision, result.nextSeq);
  }

  private async requireWriter(id: SessionId): Promise<WriterCredentials> {
    const writer = await this.credentials.get(id);
    if (writer === undefined) {
      throw new Error(
        `this device has no writer credential for session "${id}"; accept a Teleport handoff before appending`,
      );
    }
    this.assertLocalWriter(id, writer);
    return writer;
  }

  private assertLocalWriter(id: SessionId, writer: WriterCredentials): void {
    if (writer.deviceId !== this.deviceId) {
      throw new Error(
        `writer credential for session "${id}" belongs to device "${writer.deviceId}", not "${this.deviceId}"`,
      );
    }
  }

  private observe(id: string, revision: number, nextSeq: number): void {
    this.observedHeads.set(id, { revision, nextSeq });
  }

  private revision(id: string, revision: number): SessionPersistenceRevision {
    return SessionPersistenceRevision(
      `teleport:${this.sourceIdentity}:session:${id}:revision:${revision}`,
    );
  }
}

function mutationKey(
  kind: "materialize" | "append",
  sessionId: string,
  revision: number,
  nextSeq: number,
  value: unknown,
): string {
  return `dsh-${kind}-${sha256(canonicalJson({ sessionId, revision, nextSeq, value }))}`;
}

function cloneHeader(value: unknown): SessionHeader {
  return structuredClone(value) as SessionHeader;
}

function cloneEvents(value: readonly TeleportEvent[]): SessionEvent[] {
  return structuredClone(value) as unknown as SessionEvent[];
}

function cloneTeleportEvents(value: readonly SessionEvent[]): TeleportEvent[] {
  return structuredClone(value) as unknown as TeleportEvent[];
}

function isNotFound(error: unknown): boolean {
  return error instanceof TeleportRemoteError && error.code === "NOT_FOUND";
}

function validateConfig(config: SessionPersistenceTeleportConfig): void {
  if (typeof config.baseUrl !== "string" || config.baseUrl.length === 0) {
    throw new TypeError("Teleport baseUrl is required");
  }
  if (typeof config.deviceId !== "string" || config.deviceId.length === 0) {
    throw new TypeError("Teleport deviceId is required");
  }
  if (typeof config.credentialDir !== "string" || config.credentialDir.length === 0) {
    throw new TypeError("Teleport credentialDir is required");
  }
}

export default SessionPersistenceTeleport;
