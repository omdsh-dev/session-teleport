import type { WriterCredentials } from "./types.js";
export interface WriterCredentialStore {
    get(sessionId: string): Promise<WriterCredentials | undefined>;
    put(sessionId: string, writer: WriterCredentials): Promise<void>;
    delete(sessionId: string): Promise<void>;
}
/** One owner-only file per Session avoids cross-session lost updates. */
export declare class FileWriterCredentialStore implements WriterCredentialStore {
    private readonly directory;
    constructor(directory: string);
    get(sessionId: string): Promise<WriterCredentials | undefined>;
    put(sessionId: string, writer: WriterCredentials): Promise<void>;
    delete(sessionId: string): Promise<void>;
    private path;
}
export declare class MemoryWriterCredentialStore implements WriterCredentialStore {
    private readonly writers;
    get(sessionId: string): Promise<WriterCredentials | undefined>;
    put(sessionId: string, writer: WriterCredentials): Promise<void>;
    delete(sessionId: string): Promise<void>;
}
