import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, secret, sha256 } from "./canonical.js";
import { TeleportRemoteError } from "./client.js";
import {
  SESSION_IMPORT_FORMAT,
  TeleportError
} from "./types.js";
function createSessionImportBundle(header, events, inheritedEventCount) {
  return parseSessionImportBundle({
    format: SESSION_IMPORT_FORMAT,
    header,
    events,
    ...inheritedEventCount === void 0 ? {} : { inheritedEventCount }
  });
}
async function exportSessionImportBundle(source, sessionId, signal) {
  assertIdentifier(sessionId, "sessionId");
  signal?.throwIfAborted();
  let bundle;
  if (source.open !== void 0) {
    const options = signal === void 0 ? {} : { signal };
    const handle = await source.open(sessionId, "read", options);
    try {
      const snapshot = await handle.read(0, void 0, options);
      signal?.throwIfAborted();
      bundle = createSessionImportBundle(handle.header, snapshot.events, handle.inheritedEventCount);
    } finally {
      await handle.close();
    }
  } else if (source.inspect !== void 0) {
    const snapshot = await source.inspect(sessionId, signal);
    signal?.throwIfAborted();
    bundle = createSessionImportBundle(snapshot.meta, snapshot.events);
  } else {
    throw new TypeError("source persistence supports neither open nor inspect");
  }
  if (sessionIdOf(bundle) !== sessionId) {
    throw new TeleportError(
      "BAD_REQUEST",
      `source returned session "${sessionIdOf(bundle)}" while exporting "${sessionId}"`
    );
  }
  return bundle;
}
function parseSessionImportBundle(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TeleportError("BAD_REQUEST", "import bundle must be an object");
  }
  const candidate = value;
  if (candidate.format !== SESSION_IMPORT_FORMAT) {
    throw new TeleportError(
      "BAD_REQUEST",
      `import bundle format must be ${SESSION_IMPORT_FORMAT}`
    );
  }
  if (candidate.header === null || typeof candidate.header !== "object" || Array.isArray(candidate.header)) {
    throw new TeleportError("BAD_REQUEST", "import bundle header must be an object");
  }
  const sessionId = candidate.header.id;
  assertIdentifier(sessionId, "import bundle header.id");
  if (!Array.isArray(candidate.events)) {
    throw new TeleportError("BAD_REQUEST", "import bundle events must be an array");
  }
  for (const [index, value2] of candidate.events.entries()) {
    if (value2 === null || typeof value2 !== "object" || Array.isArray(value2)) {
      throw new TeleportError("BAD_REQUEST", `events[${index}] must be an object`);
    }
    const event = value2;
    assertIdentifier(event.type, `events[${index}].type`);
    safeNonNegative(event.seq, `events[${index}].seq`);
    safeNonNegative(event.time, `events[${index}].time`);
    if (event.seq !== index) {
      throw new TeleportError(
        "BAD_REQUEST",
        `events must be the full contiguous prefix: expected seq ${index}, got ${event.seq}`
      );
    }
    if (!("data" in event)) {
      throw new TeleportError("BAD_REQUEST", `events[${index}].data is required`);
    }
    if (event.sourceEventSeqs !== void 0) {
      if (!Array.isArray(event.sourceEventSeqs)) {
        throw new TeleportError(
          "BAD_REQUEST",
          `events[${index}].sourceEventSeqs must be an array`
        );
      }
      for (const [sourceIndex, sourceSeq] of event.sourceEventSeqs.entries()) {
        safeNonNegative(sourceSeq, `events[${index}].sourceEventSeqs[${sourceIndex}]`);
      }
    }
  }
  const seeded = candidate.header.isSeeded === true;
  if (seeded && candidate.inheritedEventCount === void 0) {
    throw new TeleportError("BAD_REQUEST", "seeded import requires inheritedEventCount");
  }
  if (candidate.inheritedEventCount !== void 0) {
    safeNonNegative(candidate.inheritedEventCount, "inheritedEventCount");
    if (!seeded && candidate.inheritedEventCount !== 0 || candidate.inheritedEventCount > candidate.events.length) {
      throw new TeleportError("BAD_REQUEST", "inheritedEventCount does not match the imported prefix");
    }
  }
  canonicalJson(candidate.header);
  canonicalJson(candidate.events);
  return structuredClone({
    format: SESSION_IMPORT_FORMAT,
    header: candidate.header,
    events: candidate.events,
    ...seeded ? { inheritedEventCount: candidate.inheritedEventCount } : {}
  });
}
function sessionImportDigest(bundle) {
  const parsed = parseSessionImportBundle(bundle);
  return sha256(
    canonicalJson({
      format: parsed.format,
      header: parsed.header,
      ...parsed.inheritedEventCount === void 0 ? {} : { inheritedEventCount: parsed.inheritedEventCount },
      // PostgreSQL JSON preserves event-object key order. Bind the digest to
      // each original envelope encoding while keeping JSONB header order neutral.
      eventJson: parsed.events.map((event) => JSON.stringify(event))
    })
  );
}
class SessionImporter {
  constructor(client, credentials, receipts, options) {
    this.client = client;
    this.credentials = credentials;
    this.receipts = receipts;
    assertIdentifier(options.deviceId, "deviceId");
    this.deviceId = options.deviceId;
    this.actorId = options.actorId ?? options.deviceId;
    assertIdentifier(this.actorId, "actorId");
    this.now = options.now ?? Date.now;
  }
  client;
  credentials;
  receipts;
  deviceId;
  actorId;
  now;
  /** Read-only source/target validation. No credential, receipt or target writes. */
  async dryRun(value) {
    const bundle = parseSessionImportBundle(value);
    const sessionId = sessionIdOf(bundle);
    const digest = sessionImportDigest(bundle);
    let targetStatus = "ready";
    try {
      const target = await this.client.snapshot(sessionId);
      targetStatus = snapshotDigest(target) === digest ? "already-present" : "conflict";
    } catch (error) {
      if (!(error instanceof TeleportRemoteError && error.code === "NOT_FOUND")) throw error;
    }
    return {
      sessionId,
      digest,
      eventCount: bundle.events.length,
      nextSeq: bundle.events.length,
      bundleBytes: Buffer.byteLength(JSON.stringify(bundle)),
      targetStatus
    };
  }
  /** Import the exact prefix atomically and verify it by reading it back. */
  async apply(value) {
    const bundle = parseSessionImportBundle(value);
    const plan = await this.dryRun(bundle);
    if (plan.targetStatus === "conflict") {
      throw new TeleportError(
        "SESSION_EXISTS",
        `target session "${plan.sessionId}" exists with different content`
      );
    }
    const previousReceipt = await this.receipts.get(plan.sessionId);
    if (previousReceipt !== void 0 && previousReceipt.digest !== plan.digest) {
      throw new TeleportError(
        "IDEMPOTENCY_CONFLICT",
        `local import receipt for "${plan.sessionId}" belongs to different content`
      );
    }
    if (previousReceipt !== void 0 && plan.targetStatus === "ready") {
      throw new TeleportError(
        "IMPORT_NOT_ROLLBACKABLE",
        `local receipt exists but target session "${plan.sessionId}" is absent; finish rollback cleanup before re-importing`
      );
    }
    let writer = await this.credentials.get(plan.sessionId);
    if (writer !== void 0) {
      if (writer.deviceId !== this.deviceId || writer.writerEpoch !== 1) {
        throw new TeleportError(
          "WRITER_FENCED",
          `local writer credential for "${plan.sessionId}" cannot resume this import`
        );
      }
    } else {
      if (plan.targetStatus === "already-present") {
        throw new TeleportError(
          "SESSION_EXISTS",
          `target session "${plan.sessionId}" already exists; no local import credential can prove ownership`
        );
      }
      writer = { deviceId: this.deviceId, writerEpoch: 1, writerToken: secret() };
      await this.credentials.put(plan.sessionId, writer);
    }
    const idempotencyKey = `dsh-import-${plan.digest}-${sha256(writer.writerToken)}`;
    const result = await this.client.materializeSession({
      sessionId: plan.sessionId,
      header: bundle.header,
      ...bundle.inheritedEventCount === void 0 ? {} : { inheritedEventCount: bundle.inheritedEventCount },
      deviceId: writer.deviceId,
      writerToken: writer.writerToken,
      idempotencyKey,
      events: bundle.events
    });
    if (result.revision !== 1 || result.nextSeq !== plan.nextSeq) {
      throw new Error(
        `import commit returned unexpected head ${result.revision}/${result.nextSeq}`
      );
    }
    const receipt = previousReceipt ?? {
      version: 1,
      sessionId: plan.sessionId,
      digest: plan.digest,
      idempotencyKey,
      revision: result.revision,
      nextSeq: result.nextSeq,
      writerEpoch: result.writer.writerEpoch,
      deviceId: result.writer.deviceId,
      createdAt: new Date(this.now()).toISOString()
    };
    await this.receipts.put(receipt);
    const verified = await this.dryRun(bundle);
    if (verified.targetStatus !== "already-present") {
      throw new Error(`import verification failed for session "${plan.sessionId}"`);
    }
    return {
      ...verified,
      targetStatus: "already-present",
      idempotentReplay: result.idempotentReplay
    };
  }
  /** Roll back only an unchanged import, then remove local authority material. */
  async rollback(sessionId, reason) {
    assertIdentifier(sessionId, "sessionId");
    if (reason.trim().length === 0) {
      throw new TeleportError("BAD_REQUEST", "rollback reason is required");
    }
    const receipt = await this.receipts.get(sessionId);
    if (receipt === void 0) {
      throw new TeleportError("NOT_FOUND", `no local import receipt for "${sessionId}"`);
    }
    const result = await this.client.rollbackImport({
      sessionId,
      expectedRevision: receipt.revision,
      expectedNextSeq: receipt.nextSeq,
      expectedWriterEpoch: receipt.writerEpoch,
      importIdempotencyKey: receipt.idempotencyKey,
      actorId: this.actorId,
      reason: reason.trim()
    });
    await this.credentials.delete(sessionId);
    await this.receipts.delete(sessionId);
    return result;
  }
}
class FileImportReceiptStore {
  constructor(directory) {
    this.directory = directory;
    if (directory.length === 0) throw new TypeError("receipt directory must not be empty");
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
    try {
      return validateReceipt(JSON.parse(raw), sessionId);
    } catch (error) {
      throw new Error(`import receipt for session "${sessionId}" is invalid`, { cause: error });
    }
  }
  async put(receipt) {
    const value = validateReceipt(receipt, receipt.sessionId);
    await mkdir(this.directory, { recursive: true, mode: 448 });
    const target = this.path(value.sessionId);
    const temporary = join(
      this.directory,
      `.${sha256(value.sessionId)}.${process.pid}.${secret(8)}.tmp`
    );
    let renamed = false;
    const handle = await open(temporary, "wx", 384);
    try {
      await handle.writeFile(`${canonicalJson(value)}
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
class MemoryImportReceiptStore {
  values = /* @__PURE__ */ new Map();
  async get(sessionId) {
    const value = this.values.get(sessionId);
    return value === void 0 ? void 0 : structuredClone(value);
  }
  async put(receipt) {
    this.values.set(receipt.sessionId, structuredClone(receipt));
  }
  async delete(sessionId) {
    this.values.delete(sessionId);
  }
}
function sessionIdOf(bundle) {
  return bundle.header.id;
}
function snapshotDigest(snapshot) {
  return sessionImportDigest(
    createSessionImportBundle(snapshot.header, snapshot.events, snapshot.inheritedEventCount)
  );
}
function validateReceipt(value, expectedSessionId) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("receipt must be an object");
  }
  const receipt = value;
  if (receipt.version !== 1 || receipt.sessionId !== expectedSessionId || typeof receipt.digest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.digest) || !new RegExp(`^dsh-import-${receipt.digest}-[a-f0-9]{64}$`).test(
    receipt.idempotencyKey ?? ""
  ) || receipt.revision !== 1 || !Number.isSafeInteger(receipt.nextSeq) || receipt.nextSeq < 0 || receipt.writerEpoch !== 1 || typeof receipt.deviceId !== "string" || receipt.deviceId.length === 0 || typeof receipt.createdAt !== "string" || !Number.isFinite(new Date(receipt.createdAt).getTime())) {
    throw new TypeError("receipt fields are invalid");
  }
  return structuredClone(receipt);
}
function assertIdentifier(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TeleportError("BAD_REQUEST", `${name} must be a non-empty string <= 256 chars`);
  }
}
function safeNonNegative(value, name) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TeleportError("BAD_REQUEST", `${name} must be a non-negative safe integer`);
  }
}
function isNodeError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
export {
  FileImportReceiptStore,
  MemoryImportReceiptStore,
  SessionImporter,
  createSessionImportBundle,
  exportSessionImportBundle,
  parseSessionImportBundle,
  sessionImportDigest
};
//# sourceMappingURL=importer.js.map
