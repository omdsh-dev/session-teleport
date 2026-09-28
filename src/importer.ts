import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, secret, sha256 } from "./canonical.js";
import { TeleportRemoteError } from "./client.js";
import type { WriterCredentialStore } from "./credential-store.js";
import {
  SESSION_IMPORT_FORMAT,
  TeleportError,
  type ApplySessionImportResult,
  type JsonValue,
  type MaterializeSessionRequest,
  type MaterializeSessionResult,
  type RollbackSessionImportRequest,
  type RollbackSessionImportResult,
  type SessionImportBundle,
  type SessionImportPlan,
  type SessionImportReceipt,
  type SessionSnapshot,
  type TeleportEvent,
} from "./types.js";

export interface SessionImportClient {
  snapshot(sessionId: string, afterSeq?: number): Promise<SessionSnapshot>;
  materializeSession(request: MaterializeSessionRequest): Promise<MaterializeSessionResult>;
  rollbackImport(request: RollbackSessionImportRequest): Promise<RollbackSessionImportResult>;
}

export interface SessionSnapshotSource {
  /** Current DSH handle seam; kept structural so the overlay has no runtime peers. */
  open?(sessionId: string, access: "read", options?: { signal?: AbortSignal }): Promise<{
    header: unknown;
    inheritedEventCount: number;
    read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly unknown[] }>;
    close(): Promise<void>;
  }>;
  /** Legacy source profiles can still export an archival bundle. */
  inspect?(sessionId: string, signal?: AbortSignal): Promise<{ meta: unknown; events: readonly unknown[] }>;
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
export function createSessionImportBundle(
  header: unknown,
  events: readonly unknown[],
  inheritedEventCount?: number,
): SessionImportBundle {
  return parseSessionImportBundle({
    format: SESSION_IMPORT_FORMAT,
    header,
    events,
    ...(inheritedEventCount === undefined ? {} : { inheritedEventCount }),
  });
}

/** Read one consistent Session through the existing persistence seam. */
export async function exportSessionImportBundle(
  source: SessionSnapshotSource,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionImportBundle> {
  assertIdentifier(sessionId, "sessionId");
  signal?.throwIfAborted();
  let bundle: SessionImportBundle;
  if (source.open !== undefined) {
    const options = signal === undefined ? {} : { signal };
    const handle = await source.open(sessionId, "read", options);
    try {
      const snapshot = await handle.read(0, undefined, options);
      signal?.throwIfAborted();
      bundle = createSessionImportBundle(handle.header, snapshot.events, handle.inheritedEventCount);
    } finally {
      await handle.close();
    }
  } else if (source.inspect !== undefined) {
    const snapshot = await source.inspect(sessionId, signal);
    signal?.throwIfAborted();
    bundle = createSessionImportBundle(snapshot.meta, snapshot.events);
  } else {
    throw new TypeError("source persistence supports neither open nor inspect");
  }
  if (sessionIdOf(bundle) !== sessionId) {
    throw new TeleportError(
      "BAD_REQUEST",
      `source returned session "${sessionIdOf(bundle)}" while exporting "${sessionId}"`,
    );
  }
  return bundle;
}

/** Strictly validate identity, JSON shape and the exact contiguous event prefix. */
export function parseSessionImportBundle(value: unknown): SessionImportBundle {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TeleportError("BAD_REQUEST", "import bundle must be an object");
  }
  const candidate = value as Partial<SessionImportBundle>;
  if (candidate.format !== SESSION_IMPORT_FORMAT) {
    throw new TeleportError(
      "BAD_REQUEST",
      `import bundle format must be ${SESSION_IMPORT_FORMAT}`,
    );
  }
  if (
    candidate.header === null ||
    typeof candidate.header !== "object" ||
    Array.isArray(candidate.header)
  ) {
    throw new TeleportError("BAD_REQUEST", "import bundle header must be an object");
  }
  const sessionId = (candidate.header as Record<string, unknown>).id;
  assertIdentifier(sessionId, "import bundle header.id");
  if (!Array.isArray(candidate.events)) {
    throw new TeleportError("BAD_REQUEST", "import bundle events must be an array");
  }
  for (const [index, value] of candidate.events.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TeleportError("BAD_REQUEST", `events[${index}] must be an object`);
    }
    const event = value as Partial<TeleportEvent>;
    assertIdentifier(event.type, `events[${index}].type`);
    safeNonNegative(event.seq, `events[${index}].seq`);
    safeNonNegative(event.time, `events[${index}].time`);
    if (event.seq !== index) {
      throw new TeleportError(
        "BAD_REQUEST",
        `events must be the full contiguous prefix: expected seq ${index}, got ${event.seq}`,
      );
    }
    if (!("data" in event)) {
      throw new TeleportError("BAD_REQUEST", `events[${index}].data is required`);
    }
    if (event.sourceEventSeqs !== undefined) {
      if (!Array.isArray(event.sourceEventSeqs)) {
        throw new TeleportError(
          "BAD_REQUEST",
          `events[${index}].sourceEventSeqs must be an array`,
        );
      }
      for (const [sourceIndex, sourceSeq] of event.sourceEventSeqs.entries()) {
        safeNonNegative(sourceSeq, `events[${index}].sourceEventSeqs[${sourceIndex}]`);
      }
    }
  }
  const seeded = (candidate.header as Record<string, unknown>).isSeeded === true;
  if (seeded && candidate.inheritedEventCount === undefined) {
    throw new TeleportError("BAD_REQUEST", "seeded import requires inheritedEventCount");
  }
  if (candidate.inheritedEventCount !== undefined) {
    safeNonNegative(candidate.inheritedEventCount, "inheritedEventCount");
    if ((!seeded && candidate.inheritedEventCount !== 0) || candidate.inheritedEventCount > candidate.events.length) {
      throw new TeleportError("BAD_REQUEST", "inheritedEventCount does not match the imported prefix");
    }
  }
  canonicalJson(candidate.header);
  canonicalJson(candidate.events);
  return structuredClone({
    format: SESSION_IMPORT_FORMAT,
    header: candidate.header,
    events: candidate.events,
    ...(seeded ? { inheritedEventCount: candidate.inheritedEventCount! } : {}),
  });
}

export function sessionImportDigest(bundle: SessionImportBundle): string {
  const parsed = parseSessionImportBundle(bundle);
  return sha256(
    canonicalJson({
      format: parsed.format,
      header: parsed.header,
      ...(parsed.inheritedEventCount === undefined ? {} : { inheritedEventCount: parsed.inheritedEventCount }),
      // PostgreSQL JSON preserves event-object key order. Bind the digest to
      // each original envelope encoding while keeping JSONB header order neutral.
      eventJson: parsed.events.map((event) => JSON.stringify(event)),
    }),
  );
}

export class SessionImporter {
  private readonly deviceId: string;
  private readonly actorId: string;
  private readonly now: () => number;

  constructor(
    private readonly client: SessionImportClient,
    private readonly credentials: WriterCredentialStore,
    private readonly receipts: ImportReceiptStore,
    options: SessionImporterOptions,
  ) {
    assertIdentifier(options.deviceId, "deviceId");
    this.deviceId = options.deviceId;
    this.actorId = options.actorId ?? options.deviceId;
    assertIdentifier(this.actorId, "actorId");
    this.now = options.now ?? Date.now;
  }

  /** Read-only source/target validation. No credential, receipt or target writes. */
  async dryRun(value: unknown): Promise<SessionImportPlan> {
    const bundle = parseSessionImportBundle(value);
    const sessionId = sessionIdOf(bundle);
    const digest = sessionImportDigest(bundle);
    let targetStatus: SessionImportPlan["targetStatus"] = "ready";
    try {
      const target = await this.client.snapshot(sessionId);
      targetStatus = snapshotDigest(target) === digest ? "already-present" : "conflict";
    } catch (error: unknown) {
      if (!(error instanceof TeleportRemoteError && error.code === "NOT_FOUND")) throw error;
    }
    return {
      sessionId,
      digest,
      eventCount: bundle.events.length,
      nextSeq: bundle.events.length,
      bundleBytes: Buffer.byteLength(JSON.stringify(bundle)),
      targetStatus,
    };
  }

  /** Import the exact prefix atomically and verify it by reading it back. */
  async apply(value: unknown): Promise<ApplySessionImportResult> {
    const bundle = parseSessionImportBundle(value);
    const plan = await this.dryRun(bundle);
    if (plan.targetStatus === "conflict") {
      throw new TeleportError(
        "SESSION_EXISTS",
        `target session "${plan.sessionId}" exists with different content`,
      );
    }

    const previousReceipt = await this.receipts.get(plan.sessionId);
    if (previousReceipt !== undefined && previousReceipt.digest !== plan.digest) {
      throw new TeleportError(
        "IDEMPOTENCY_CONFLICT",
        `local import receipt for "${plan.sessionId}" belongs to different content`,
      );
    }
    if (previousReceipt !== undefined && plan.targetStatus === "ready") {
      throw new TeleportError(
        "IMPORT_NOT_ROLLBACKABLE",
        `local receipt exists but target session "${plan.sessionId}" is absent; finish rollback cleanup before re-importing`,
      );
    }
    let writer = await this.credentials.get(plan.sessionId);
    if (writer !== undefined) {
      if (writer.deviceId !== this.deviceId || writer.writerEpoch !== 1) {
        throw new TeleportError(
          "WRITER_FENCED",
          `local writer credential for "${plan.sessionId}" cannot resume this import`,
        );
      }
    } else {
      if (plan.targetStatus === "already-present") {
        throw new TeleportError(
          "SESSION_EXISTS",
          `target session "${plan.sessionId}" already exists; no local import credential can prove ownership`,
        );
      }
      writer = { deviceId: this.deviceId, writerEpoch: 1, writerToken: secret() };
      // Persist retry material before the remote commit. A response-loss retry
      // must reproduce the same writer authority.
      await this.credentials.put(plan.sessionId, writer);
    }

    // Bind the mutation to this import incarnation as well as its content.
    // Re-importing the same id/content after a completed rollback gets a new
    // writer token and cannot be mistaken for the old rollback audit (ABA).
    const idempotencyKey = `dsh-import-${plan.digest}-${sha256(writer.writerToken)}`;
    const result = await this.client.materializeSession({
      sessionId: plan.sessionId,
      header: bundle.header,
      ...(bundle.inheritedEventCount === undefined ? {} : { inheritedEventCount: bundle.inheritedEventCount }),
      deviceId: writer.deviceId,
      writerToken: writer.writerToken,
      idempotencyKey,
      events: bundle.events,
    });
    if (result.revision !== 1 || result.nextSeq !== plan.nextSeq) {
      throw new Error(
        `import commit returned unexpected head ${result.revision}/${result.nextSeq}`,
      );
    }

    const receipt: SessionImportReceipt = previousReceipt ?? {
      version: 1,
      sessionId: plan.sessionId,
      digest: plan.digest,
      idempotencyKey,
      revision: result.revision,
      nextSeq: result.nextSeq,
      writerEpoch: result.writer.writerEpoch,
      deviceId: result.writer.deviceId,
      createdAt: new Date(this.now()).toISOString(),
    };
    // Store the rollback identity before verification. If verification or its
    // response fails, the committed import remains safely reversible.
    await this.receipts.put(receipt);
    const verified = await this.dryRun(bundle);
    if (verified.targetStatus !== "already-present") {
      throw new Error(`import verification failed for session "${plan.sessionId}"`);
    }
    return {
      ...verified,
      targetStatus: "already-present",
      idempotentReplay: result.idempotentReplay,
    };
  }

  /** Roll back only an unchanged import, then remove local authority material. */
  async rollback(sessionId: string, reason: string): Promise<RollbackSessionImportResult> {
    assertIdentifier(sessionId, "sessionId");
    if (reason.trim().length === 0) {
      throw new TeleportError("BAD_REQUEST", "rollback reason is required");
    }
    const receipt = await this.receipts.get(sessionId);
    if (receipt === undefined) {
      throw new TeleportError("NOT_FOUND", `no local import receipt for "${sessionId}"`);
    }
    const result = await this.client.rollbackImport({
      sessionId,
      expectedRevision: receipt.revision,
      expectedNextSeq: receipt.nextSeq,
      expectedWriterEpoch: receipt.writerEpoch,
      importIdempotencyKey: receipt.idempotencyKey,
      actorId: this.actorId,
      reason: reason.trim(),
    });
    await this.credentials.delete(sessionId);
    await this.receipts.delete(sessionId);
    return result;
  }
}

export class FileImportReceiptStore implements ImportReceiptStore {
  constructor(private readonly directory: string) {
    if (directory.length === 0) throw new TypeError("receipt directory must not be empty");
  }

  async get(sessionId: string): Promise<SessionImportReceipt | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path(sessionId), "utf8");
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    try {
      return validateReceipt(JSON.parse(raw), sessionId);
    } catch (error: unknown) {
      throw new Error(`import receipt for session "${sessionId}" is invalid`, { cause: error });
    }
  }

  async put(receipt: SessionImportReceipt): Promise<void> {
    const value = validateReceipt(receipt, receipt.sessionId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(value.sessionId);
    const temporary = join(
      this.directory,
      `.${sha256(value.sessionId)}.${process.pid}.${secret(8)}.tmp`,
    );
    let renamed = false;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
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
        // Successful writes close before rename.
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

export class MemoryImportReceiptStore implements ImportReceiptStore {
  private readonly values = new Map<string, SessionImportReceipt>();

  async get(sessionId: string): Promise<SessionImportReceipt | undefined> {
    const value = this.values.get(sessionId);
    return value === undefined ? undefined : structuredClone(value);
  }

  async put(receipt: SessionImportReceipt): Promise<void> {
    this.values.set(receipt.sessionId, structuredClone(receipt));
  }

  async delete(sessionId: string): Promise<void> {
    this.values.delete(sessionId);
  }
}

function sessionIdOf(bundle: SessionImportBundle): string {
  return (bundle.header as Record<string, JsonValue>).id as string;
}

function snapshotDigest(snapshot: SessionSnapshot): string {
  return sessionImportDigest(
    createSessionImportBundle(snapshot.header, snapshot.events, snapshot.inheritedEventCount),
  );
}

function validateReceipt(value: unknown, expectedSessionId: string): SessionImportReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("receipt must be an object");
  }
  const receipt = value as Partial<SessionImportReceipt>;
  if (
    receipt.version !== 1 ||
    receipt.sessionId !== expectedSessionId ||
    typeof receipt.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.digest) ||
    !new RegExp(`^dsh-import-${receipt.digest}-[a-f0-9]{64}$`).test(
      receipt.idempotencyKey ?? "",
    ) ||
    receipt.revision !== 1 ||
    !Number.isSafeInteger(receipt.nextSeq) ||
    receipt.nextSeq! < 0 ||
    receipt.writerEpoch !== 1 ||
    typeof receipt.deviceId !== "string" ||
    receipt.deviceId.length === 0 ||
    typeof receipt.createdAt !== "string" ||
    !Number.isFinite(new Date(receipt.createdAt).getTime())
  ) {
    throw new TypeError("receipt fields are invalid");
  }
  return structuredClone(receipt as SessionImportReceipt);
}

function assertIdentifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TeleportError("BAD_REQUEST", `${name} must be a non-empty string <= 256 chars`);
  }
}

function safeNonNegative(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TeleportError("BAD_REQUEST", `${name} must be a non-negative safe integer`);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
