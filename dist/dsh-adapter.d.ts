import { Context, Service } from "@deepseek-ai/cordis";
import { SessionPersistence, SessionPersistenceRevision, type PersistenceBackend, type SessionLocation, type SessionPersistenceSnapshot, type StoredPrefix, type StoredSuffix } from "@deepseek-ai/dsh-session-persistence";
import type { SessionEvent, SessionHeader, SessionId, SessionPreparation } from "@deepseek-ai/dsh-session";
import { type WriterCredentialStore } from "./credential-store.js";
import { TeleportClient } from "./client.js";
import type { CreateHandoffResult, WriterCredentials } from "./types.js";
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
/** DSH PersistenceBackend adapter over the Teleport HTTP authority. */
export declare class SessionPersistenceTeleport extends SessionPersistence implements PersistenceBackend<never> {
    readonly config: SessionPersistenceTeleportConfig;
    static inject: string[];
    readonly name = "session-persistence-teleport";
    readonly supportsRawArtifacts = false;
    private readonly client;
    private readonly credentials;
    private readonly coordinator;
    private readonly observedHeads;
    private readonly sourceIdentity;
    private readonly deviceId;
    constructor(ctx: Context, config: SessionPersistenceTeleportConfig, dependencies?: SessionPersistenceTeleportDependencies);
    protected [Service.init](): Promise<void>;
    locate(_meta: SessionHeader): SessionLocation | undefined;
    create(meta: SessionHeader): Promise<void>;
    append(id: SessionId, events: readonly SessionEvent[]): Promise<void>;
    prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation>;
    load(id: SessionId): Promise<{
        meta: SessionHeader;
        events: readonly SessionEvent[];
    }>;
    inspect(id: SessionId, signal?: AbortSignal): Promise<{
        meta: SessionHeader;
        events: readonly SessionEvent[];
    }>;
    readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{
        meta: SessionHeader;
        events: SessionEvent[];
    }>;
    loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined>;
    readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined>;
    loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined>;
    appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void>;
    commitRepair(meta: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void>;
    list(signal?: AbortSignal): Promise<SessionHeader[]>;
    listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]>;
    createHandoff(id: SessionId, ttlMs?: number): Promise<CreateHandoffResult>;
    acceptHandoff(code: string): Promise<WriterCredentials>;
    private appendExisting;
    private requireWriter;
    private assertLocalWriter;
    private observe;
    private revision;
}
export default SessionPersistenceTeleport;
