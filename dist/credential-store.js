import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, secret, sha256 } from "./canonical.js";
class FileWriterCredentialStore {
  constructor(directory) {
    this.directory = directory;
    if (directory.length === 0) throw new TypeError("credential directory must not be empty");
  }
  directory;
  async get(sessionId) {
    let raw;
    try {
      raw = await readFile(this.path(sessionId), "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return void 0;
      throw error;
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`writer credential for session "${sessionId}" is not valid JSON`, {
        cause: error
      });
    }
    const document = validateDocument(value, sessionId);
    return structuredClone(document.writer);
  }
  async put(sessionId, writer) {
    const document = validateDocument({ version: 1, sessionId, writer }, sessionId);
    await mkdir(this.directory, { recursive: true, mode: 448 });
    const target = this.path(sessionId);
    const temporary = join(
      this.directory,
      `.${sha256(sessionId)}.${process.pid}.${secret(8)}.tmp`
    );
    let renamed = false;
    const handle = await open(temporary, "wx", 384);
    try {
      await handle.writeFile(`${canonicalJson(document)}
`, "utf8");
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
      }
      if (!renamed) {
        try {
          await unlink(temporary);
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
        }
      }
    }
  }
  async delete(sessionId) {
    try {
      await unlink(this.path(sessionId));
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  path(sessionId) {
    return join(this.directory, `${sha256(sessionId)}.json`);
  }
}
class MemoryWriterCredentialStore {
  writers = /* @__PURE__ */ new Map();
  async get(sessionId) {
    const writer = this.writers.get(sessionId);
    return writer === void 0 ? void 0 : structuredClone(writer);
  }
  async put(sessionId, writer) {
    this.writers.set(sessionId, structuredClone(writer));
  }
  async delete(sessionId) {
    this.writers.delete(sessionId);
  }
}
function validateDocument(value, expectedSessionId) {
  if (value === null || typeof value !== "object") {
    throw new Error(`writer credential for session "${expectedSessionId}" is not an object`);
  }
  const document = value;
  if (document.version !== 1 || document.sessionId !== expectedSessionId) {
    throw new Error(`writer credential for session "${expectedSessionId}" has the wrong identity`);
  }
  const writer = document.writer;
  if (writer === void 0 || typeof writer.deviceId !== "string" || writer.deviceId.length === 0 || typeof writer.writerToken !== "string" || writer.writerToken.length === 0 || !Number.isSafeInteger(writer.writerEpoch) || writer.writerEpoch < 1) {
    throw new Error(`writer credential for session "${expectedSessionId}" is invalid`);
  }
  return {
    version: 1,
    sessionId: expectedSessionId,
    writer: structuredClone(writer)
  };
}
function isNodeError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
export {
  FileWriterCredentialStore,
  MemoryWriterCredentialStore
};
//# sourceMappingURL=credential-store.js.map
