import { type SessionSnapshotSource } from "./importer.js";
export interface SessionCaptureResult {
    sessionId: string;
    digest: string;
    eventCount: number;
    nextSeq: number;
    bundleBytes: number;
    outputPath: string;
    sourceBackend: string;
}
export interface CaptureStatus {
    version: 1;
    nonce: string;
    ok: boolean;
    result?: SessionCaptureResult;
    error?: string;
}
export interface ProfileCaptureOptions {
    profile: string;
    sessionId: string;
    outputPath: string;
    dshCommand?: string;
    dshArgsPrefix?: readonly string[];
    timeoutMs?: number;
    environment?: NodeJS.ProcessEnv;
    sourcePluginUrl?: string;
}
/** Export one consistent inspect() result to a no-clobber owner-only file. */
export declare function captureSessionBundle(source: SessionSnapshotSource, sessionId: string, outputPath: string, sourceBackend?: string, signal?: AbortSignal): Promise<SessionCaptureResult>;
/** Publish a sensitive bundle atomically without ever replacing an existing path. */
export declare function writeSessionImportBundle(outputPath: string, value: unknown): Promise<number>;
/**
 * Boot an existing DSH profile with a temporary read-only overlay. The source
 * backend remains authoritative and untouched; only the requested bundle is
 * written locally.
 */
export declare function captureSessionFromProfile(options: ProfileCaptureOptions): Promise<SessionCaptureResult>;
export declare function writeCaptureStatus(path: string, status: CaptureStatus): Promise<void>;
