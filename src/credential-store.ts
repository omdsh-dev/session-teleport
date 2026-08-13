import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, secret, sha256 } from "./canonical.js";
import type { WriterCredentials } from "./types.js";

export interface WriterCredentialStore {
  get(sessionId: string): Promise<WriterCredentials | undefined>;
  put(sessionId: string, writer: WriterCredentials): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

interface CredentialDocument {
  version: 1;
  sessionId: string;
  writer: WriterCredentials;
}

/** One owner-only file per Session avoids cross-session lost updates. */
export class FileWriterCredentialStore implements WriterCredentialStore {
  constructor(private readonly directory: string) {
    if (directory.length === 0) throw new TypeError("credential directory must not be empty");
  }

  async get(sessionId: string): Promise<WriterCredentials | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path(sessionId), "utf8");
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error: unknown) {
      throw new Error(`writer credential for session "${sessionId}" is not valid JSON`, {
        cause: error,
      });
    }
    const document = validateDocument(value, sessionId);
    return structuredClone(document.writer);
  }

  async put(sessionId: string, writer: WriterCredentials): Promise<void> {
    const document = validateDocument({ version: 1, sessionId, writer }, sessionId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(sessionId);
    const temporary = join(
      this.directory,
      `.${sha256(sessionId)}.${process.pid}.${secret(8)}.tmp`,
    );
    let renamed = false;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(document)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
      renamed = true;
      const directoryHandle = await open(this.directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      try {
        await handle.close();
      } catch {
        // The successful path already closed the handle before atomic rename.
      }
      if (!renamed) {
        try {
          await unlink(temporary);
        } catch (error: unknown) {
          if (!isNodeError(error, "ENOENT")) throw error;
        }
      }
    }
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await unlink(this.path(sessionId));
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  private path(sessionId: string): string {
    return join(this.directory, `${sha256(sessionId)}.json`);
  }
}

export class MemoryWriterCredentialStore implements WriterCredentialStore {
  private readonly writers = new Map<string, WriterCredentials>();

  async get(sessionId: string): Promise<WriterCredentials | undefined> {
    const writer = this.writers.get(sessionId);
    return writer === undefined ? undefined : structuredClone(writer);
  }

  async put(sessionId: string, writer: WriterCredentials): Promise<void> {
    this.writers.set(sessionId, structuredClone(writer));
  }

  async delete(sessionId: string): Promise<void> {
    this.writers.delete(sessionId);
  }
}

function validateDocument(value: unknown, expectedSessionId: string): CredentialDocument {
  if (value === null || typeof value !== "object") {
    throw new Error(`writer credential for session "${expectedSessionId}" is not an object`);
  }
  const document = value as Partial<CredentialDocument>;
  if (document.version !== 1 || document.sessionId !== expectedSessionId) {
    throw new Error(`writer credential for session "${expectedSessionId}" has the wrong identity`);
  }
  const writer = document.writer;
  if (
    writer === undefined ||
    typeof writer.deviceId !== "string" ||
    writer.deviceId.length === 0 ||
    typeof writer.writerToken !== "string" ||
    writer.writerToken.length === 0 ||
    !Number.isSafeInteger(writer.writerEpoch) ||
    writer.writerEpoch < 1
  ) {
    throw new Error(`writer credential for session "${expectedSessionId}" is invalid`);
  }
  return {
    version: 1,
    sessionId: expectedSessionId,
    writer: structuredClone(writer),
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
