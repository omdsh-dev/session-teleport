import { Context, Service } from "@deepseek-ai/cordis";
import { SessionPersistence, type SessionAccess, type SessionHandle, type SessionPersistenceCreateOptions, type SessionPersistenceListOptions, type SessionPersistenceOpenOptions, type SessionPersistenceSnapshot, type SessionPersistenceStatOptions } from "@deepseek-ai/dsh-session-persistence";
import { type SessionHeader, type SessionId } from "@deepseek-ai/dsh-session";
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
/** DSH 0.2 handle-based persistence over the PostgreSQL authority. */
export declare class SessionPersistenceTeleport extends SessionPersistence {
    readonly config: SessionPersistenceTeleportConfig;
    static inject: string[];
    readonly name = "session-persistence-teleport";
    private readonly client;
    private readonly credentials;
    private readonly writers;
    private readonly handles;
    private readonly sourceIdentity;
    constructor(ctx: Context, config: SessionPersistenceTeleportConfig, dependencies?: SessionPersistenceTeleportDependencies);
    protected [Service.init](): Promise<void>;
    create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle>;
    open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle>;
    flush(): Promise<void>;
    stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined>;
    list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]>;
    createHandoff(id: SessionId, ttlMs?: number): Promise<CreateHandoffResult>;
    acceptHandoff(code: string): Promise<WriterCredentials>;
    private snapshot;
    private adopt;
    private release;
    private requireWriter;
    private assertDevice;
    private acquireLock;
}
export default SessionPersistenceTeleport;
