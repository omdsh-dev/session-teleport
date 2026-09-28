import type { AcceptHandoffRequest, AcceptHandoffResult, AppendRequest, AppendResult, CreateHandoffRequest, CreateHandoffResult, CreateSessionRequest, CreateSessionResult, MaterializeSessionRequest, MaterializeSessionResult, RecoverWriterRequest, RecoverWriterResult, RollbackSessionImportRequest, RollbackSessionImportResult, SessionHead, SessionSnapshot, WriterAuditEntry } from "./types.js";
export declare class TeleportRemoteError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
/** Typed HTTP client shared by the DSH adapter and administrative CLI. */
export declare class TeleportClient {
    private readonly apiToken?;
    private readonly adminToken?;
    private readonly baseUrl;
    constructor(baseUrl: string, apiToken?: string | undefined, adminToken?: string | undefined);
    health(signal?: AbortSignal, requiredSchemaVersion?: number): Promise<void>;
    createSession(request: CreateSessionRequest): Promise<CreateSessionResult>;
    materializeSession(request: MaterializeSessionRequest): Promise<MaterializeSessionResult>;
    listHeads(signal?: AbortSignal): Promise<SessionHead[]>;
    head(sessionId: string, signal?: AbortSignal): Promise<SessionHead>;
    snapshot(sessionId: string, afterSeq?: number, signal?: AbortSignal): Promise<SessionSnapshot>;
    append(request: AppendRequest): Promise<AppendResult>;
    createHandoff(request: CreateHandoffRequest): Promise<CreateHandoffResult>;
    acceptHandoff(request: AcceptHandoffRequest): Promise<AcceptHandoffResult>;
    recoverWriter(request: RecoverWriterRequest): Promise<RecoverWriterResult>;
    writerAudit(sessionId: string, limit?: number): Promise<WriterAuditEntry[]>;
    rollbackImport(request: RollbackSessionImportRequest): Promise<RollbackSessionImportResult>;
    watchUrl(sessionId: string, afterSeq?: number): string;
    private request;
}
