import type { SqlDatabase } from "./database.js";
import type { AcceptHandoffRequest, AcceptHandoffResult, AppendRequest, AppendResult, CreateHandoffRequest, CreateHandoffResult, MaterializeSessionRequest, MaterializeSessionResult, RecoverWriterRequest, RecoverWriterResult, RollbackSessionImportRequest, RollbackSessionImportResult, SessionHead, CreateSessionRequest, CreateSessionResult, SessionSnapshot, WriterAuditEntry } from "./types.js";
export interface TeleportAuthorityOptions {
    now?: () => number;
    defaultHandoffTtlMs?: number;
    maxHandoffTtlMs?: number;
}
export declare class TeleportAuthority {
    private readonly database;
    private readonly changes;
    private readonly now;
    private readonly defaultHandoffTtlMs;
    private readonly maxHandoffTtlMs;
    constructor(database: SqlDatabase, options?: TeleportAuthorityOptions);
    checkHealth(): Promise<void>;
    createSession(request: CreateSessionRequest): Promise<CreateSessionResult>;
    materializeSession(request: MaterializeSessionRequest): Promise<MaterializeSessionResult>;
    append(request: AppendRequest): Promise<AppendResult>;
    snapshot(sessionId: string, afterSeq?: number): Promise<SessionSnapshot>;
    head(sessionId: string): Promise<SessionHead>;
    listHeads(): Promise<SessionHead[]>;
    createHandoff(request: CreateHandoffRequest): Promise<CreateHandoffResult>;
    acceptHandoff(request: AcceptHandoffRequest): Promise<AcceptHandoffResult>;
    recoverWriter(request: RecoverWriterRequest): Promise<RecoverWriterResult>;
    /**
     * Remove a freshly imported Session while the old backend is still the
     * rollback authority. Any append, handoff or recovery closes this window.
     */
    rollbackImport(request: RollbackSessionImportRequest): Promise<RollbackSessionImportResult>;
    listWriterAudit(sessionId: string, limit?: number): Promise<WriterAuditEntry[]>;
    subscribe(sessionId: string, listener: (kind: "created" | "events" | "writer") => void): () => void;
    private emit;
}
