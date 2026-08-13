import { Service } from "@deepseek-ai/cordis";
import {
  PersistenceCoordinator,
  SessionPersistence,
  SessionPersistenceRevision
} from "@deepseek-ai/dsh-session-persistence";
import { canonicalJson, secret, sha256 } from "./canonical.js";
import {
  FileWriterCredentialStore
} from "./credential-store.js";
import { TeleportClient, TeleportRemoteError } from "./client.js";
class SessionPersistenceTeleport extends SessionPersistence {
  constructor(ctx, config, dependencies = {}) {
    validateConfig(config);
    super(ctx);
    this.config = config;
    this.deviceId = config.deviceId;
    const baseUrl = config.baseUrl.replace(/\/$/, "");
    this.sourceIdentity = sha256(baseUrl);
    this.client = dependencies.client ?? new TeleportClient(baseUrl, config.apiToken);
    this.credentials = dependencies.credentialStore ?? new FileWriterCredentialStore(config.credentialDir);
    this.coordinator = new PersistenceCoordinator(this.ctx, this);
  }
  config;
  static inject = ["sessions"];
  name = "session-persistence-teleport";
  supportsRawArtifacts = false;
  client;
  credentials;
  coordinator;
  observedHeads = /* @__PURE__ */ new Map();
  sourceIdentity;
  deviceId;
  async [Service.init]() {
    const timeoutMs = this.config.healthTimeoutMs ?? 5e3;
    try {
      await this.client.health(AbortSignal.timeout(timeoutMs));
    } catch (error) {
      throw new Error(
        `Teleport service health check failed for ${this.config.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
  locate(_meta) {
    return void 0;
  }
  create(meta) {
    return this.coordinator.create(meta);
  }
  append(id, events) {
    return this.coordinator.append(id, events);
  }
  prepare(id, signal) {
    return this.coordinator.prepare(id, signal);
  }
  load(id) {
    return this.coordinator.load(id);
  }
  inspect(id, signal) {
    return this.coordinator.inspect(id, signal);
  }
  readFrom(id, fromSeq, signal) {
    return this.coordinator.readFrom(id, fromSeq, signal);
  }
  async loadStored(id, signal) {
    signal?.throwIfAborted();
    let snapshot;
    try {
      snapshot = await this.client.snapshot(id);
    } catch (error) {
      if (isNotFound(error)) return void 0;
      throw error;
    }
    signal?.throwIfAborted();
    this.observe(id, snapshot.revision, snapshot.nextSeq);
    return {
      meta: cloneHeader(snapshot.header),
      events: cloneEvents(snapshot.events),
      revision: this.revision(id, snapshot.revision)
    };
  }
  async readStoredRevision(id, signal) {
    signal?.throwIfAborted();
    let head;
    try {
      head = await this.client.head(id);
    } catch (error) {
      if (isNotFound(error)) return void 0;
      throw error;
    }
    signal?.throwIfAborted();
    return this.revision(id, head.revision);
  }
  async loadStoredFrom(id, fromSeq, signal) {
    signal?.throwIfAborted();
    let snapshot;
    try {
      snapshot = await this.client.snapshot(id, fromSeq - 1);
    } catch (error) {
      if (isNotFound(error)) return void 0;
      throw error;
    }
    signal?.throwIfAborted();
    return {
      meta: cloneHeader(snapshot.header),
      events: cloneEvents(snapshot.events)
    };
  }
  async appendBatch(meta, events, isMaterialized) {
    if (events.length === 0) return;
    const teleportEvents = cloneTeleportEvents(events);
    if (!isMaterialized) {
      let writer = await this.credentials.get(meta.id);
      if (writer === void 0) {
        writer = {
          deviceId: this.deviceId,
          writerEpoch: 1,
          writerToken: secret()
        };
        await this.credentials.put(meta.id, writer);
      }
      this.assertLocalWriter(meta.id, writer);
      const result = await this.client.materializeSession({
        sessionId: meta.id,
        header: structuredClone(meta),
        deviceId: writer.deviceId,
        writerToken: writer.writerToken,
        idempotencyKey: mutationKey("materialize", meta.id, 0, 0, {
          header: meta,
          events: teleportEvents
        }),
        events: teleportEvents
      });
      this.observe(meta.id, result.revision, result.nextSeq);
      return;
    }
    await this.appendExisting(meta.id, teleportEvents);
  }
  async commitRepair(meta, _tornMarker, closers) {
    if (closers.length === 0) return;
    await this.appendExisting(meta.id, cloneTeleportEvents(closers));
  }
  async list(signal) {
    signal?.throwIfAborted();
    const heads = await this.client.listHeads();
    signal?.throwIfAborted();
    return heads.map((head) => cloneHeader(head.header));
  }
  async listSnapshots(signal) {
    signal?.throwIfAborted();
    const heads = await this.client.listHeads();
    signal?.throwIfAborted();
    return heads.map((head) => ({
      header: cloneHeader(head.header),
      revision: this.revision(head.sessionId, head.revision)
    }));
  }
  async createHandoff(id, ttlMs) {
    const writer = await this.requireWriter(id);
    return this.client.createHandoff({
      sessionId: id,
      writer,
      ...ttlMs === void 0 ? {} : { ttlMs }
    });
  }
  async acceptHandoff(code) {
    const accepted = await this.client.acceptHandoff({ code, deviceId: this.deviceId });
    await this.credentials.put(accepted.sessionId, accepted.writer);
    this.observe(accepted.sessionId, accepted.revision, accepted.nextSeq);
    return structuredClone(accepted.writer);
  }
  async appendExisting(id, events) {
    const writer = await this.requireWriter(id);
    const observed = this.observedHeads.get(id);
    if (observed === void 0) {
      throw new Error(
        `session "${id}" has no observed Teleport head; load it before appending`
      );
    }
    const nextSeq = events[0].seq;
    if (observed.nextSeq !== nextSeq) {
      throw new Error(
        `Teleport head changed for "${id}": observed next seq ${observed.nextSeq}, append starts at ${nextSeq}`
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
        events
      ),
      events
    });
    this.observe(id, result.revision, result.nextSeq);
  }
  async requireWriter(id) {
    const writer = await this.credentials.get(id);
    if (writer === void 0) {
      throw new Error(
        `this device has no writer credential for session "${id}"; accept a Teleport handoff before appending`
      );
    }
    this.assertLocalWriter(id, writer);
    return writer;
  }
  assertLocalWriter(id, writer) {
    if (writer.deviceId !== this.deviceId) {
      throw new Error(
        `writer credential for session "${id}" belongs to device "${writer.deviceId}", not "${this.deviceId}"`
      );
    }
  }
  observe(id, revision, nextSeq) {
    this.observedHeads.set(id, { revision, nextSeq });
  }
  revision(id, revision) {
    return SessionPersistenceRevision(
      `teleport:${this.sourceIdentity}:session:${id}:revision:${revision}`
    );
  }
}
function mutationKey(kind, sessionId, revision, nextSeq, value) {
  return `dsh-${kind}-${sha256(canonicalJson({ sessionId, revision, nextSeq, value }))}`;
}
function cloneHeader(value) {
  return structuredClone(value);
}
function cloneEvents(value) {
  return structuredClone(value);
}
function cloneTeleportEvents(value) {
  return structuredClone(value);
}
function isNotFound(error) {
  return error instanceof TeleportRemoteError && error.code === "NOT_FOUND";
}
function validateConfig(config) {
  if (typeof config.baseUrl !== "string" || config.baseUrl.length === 0) {
    throw new TypeError("Teleport baseUrl is required");
  }
  if (typeof config.deviceId !== "string" || config.deviceId.length === 0) {
    throw new TypeError("Teleport deviceId is required");
  }
  if (typeof config.credentialDir !== "string" || config.credentialDir.length === 0) {
    throw new TypeError("Teleport credentialDir is required");
  }
  if (config.healthTimeoutMs !== void 0 && (!Number.isSafeInteger(config.healthTimeoutMs) || config.healthTimeoutMs <= 0)) {
    throw new TypeError("Teleport healthTimeoutMs must be a positive integer");
  }
}
var dsh_adapter_default = SessionPersistenceTeleport;
export {
  SessionPersistenceTeleport,
  dsh_adapter_default as default
};
//# sourceMappingURL=dsh-adapter.js.map
