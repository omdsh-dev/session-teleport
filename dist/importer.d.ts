import type { WriterCredentialStore } from "./credential-store.js";
import { type ApplySessionImportResult, type MaterializeSessionRequest, type MaterializeSessionResult, type RollbackSessionImportRequest, type RollbackSessionImportResult, type SessionImportBundle, type SessionImportPlan, type SessionImportReceipt, type SessionSnapshot } from "./types.js";
export interface SessionImportClient {
    snapshot(sessionId: string, afterSeq?: number): Promise<SessionSnapshot>;
    materializeSession(request: MaterializeSessionRequest): Promise<MaterializeSessionResult>;
    rollbackImport(request: RollbackSessionImportRequest): Promise<RollbackSessionImportResult>;
}
export interface SessionSnapshotSource {
    /** Current DSH handle seam; kept structural so the overlay has no runtime peers. */
    open?(sessionId: string, access: "read", options?: {
        signal?: AbortSignal;
    }): Promise<{
        header: unknown;
        inheritedEventCount: number;
        read(offset?: number, length?: number, options?: {
            signal?: AbortSignal;
        }): Promise<{
            events: readonly unknown[];
        }>;
        close(): Promise<void>;
    }>;
    /** Legacy source profiles can still export an archival bundle. */
    inspect?(sessionId: string, signal?: AbortSignal): Promise<{
        meta: unknown;
        events: readonly unknown[];
    }>;
}
export interface ImportReceiptStore {
    get(sessionId: string): Promise<SessionImportReceipt | undefined>;
    put(receipt: SessionImportReceipt): Promise<void>;
    delete(sessionId: string): Promise<void>;
}
export interface SessionImporterOptions {
    deviceId: string;
    actorId?: string;
    now?: () => number;
}
/** Build a portable import file from a consistent storage read. */
export declare function createSessionImportBundle(header: unknown, events: readonly unknown[], inheritedEventCount?: number): SessionImportBundle;
/** Read one consistent Session through the existing persistence seam. */
export declare function exportSessionImportBundle(source: SessionSnapshotSource, sessionId: string, signal?: AbortSignal): Promise<SessionImportBundle>;
/** Strictly validate identity, JSON shape and the exact contiguous event prefix. */
export declare function parseSessionImportBundle(value: unknown): SessionImportBundle;
export declare function sessionImportDigest(bundle: SessionImportBundle): string;
export declare class SessionImporter {
    private readonly client;
    private readonly credentials;
    private readonly receipts;
    private readonly deviceId;
    private readonly actorId;
    private readonly now;
    constructor(client: SessionImportClient, credentials: WriterCredentialStore, receipts: ImportReceiptStore, options: SessionImporterOptions);
    /** Read-only source/target validation. No credential, receipt or target writes. */
    dryRun(value: unknown): Promise<SessionImportPlan>;
    /** Import the exact prefix atomically and verify it by reading it back. */
    apply(value: unknown): Promise<ApplySessionImportResult>;
    /** Roll back only an unchanged import, then remove local authority material. */
    rollback(sessionId: string, reason: string): Promise<RollbackSessionImportResult>;
}
export declare class FileImportReceiptStore implements ImportReceiptStore {
    private readonly directory;
    constructor(directory: string);
    get(sessionId: string): Promise<SessionImportReceipt | undefined>;
    put(receipt: SessionImportReceipt): Promise<void>;
    delete(sessionId: string): Promise<void>;
    private path;
}
export declare class MemoryImportReceiptStore implements ImportReceiptStore {
    private readonly values;
    get(sessionId: string): Promise<SessionImportReceipt | undefined>;
    put(receipt: SessionImportReceipt): Promise<void>;
    delete(sessionId: string): Promise<void>;
}
