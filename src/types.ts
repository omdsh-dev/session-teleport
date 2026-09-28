export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Opaque DSH event envelope. Unknown/plugin event fields remain in `data`. */
export interface TeleportEvent {
  type: string;
  seq: number;
  time: number;
  data: JsonValue;
  sourceEventSeqs?: number[];
  surfaceOp?: JsonValue;
  [key: string]: JsonValue | number[] | undefined;
}

export const SESSION_IMPORT_FORMAT = "dsh-session-teleport/import-v1" as const;

/** Portable, backend-neutral snapshot produced from an existing Session. */
export interface SessionImportBundle {
  /** Exact fork prefix length, separate from the immutable DSH header. */
  inheritedEventCount?: number;
  format: typeof SESSION_IMPORT_FORMAT;
  header: JsonValue;
  events: TeleportEvent[];
}

export type SessionImportTargetStatus = "ready" | "already-present" | "conflict";

export interface SessionImportPlan {
  sessionId: string;
  digest: string;
  eventCount: number;
  nextSeq: number;
  bundleBytes: number;
  targetStatus: SessionImportTargetStatus;
}

export interface SessionImportReceipt {
  version: 1;
  sessionId: string;
  digest: string;
  idempotencyKey: string;
  revision: number;
  nextSeq: number;
  writerEpoch: number;
  deviceId: string;
  createdAt: string;
}

export interface ApplySessionImportResult extends SessionImportPlan {
  targetStatus: "already-present";
  idempotentReplay: boolean;
}

export interface RollbackSessionImportRequest {
  sessionId: string;
  expectedRevision: number;
  expectedNextSeq: number;
  expectedWriterEpoch: number;
  importIdempotencyKey: string;
  actorId: string;
  reason: string;
}

export interface RollbackSessionImportResult {
  sessionId: string;
  rolledBack: true;
  idempotentReplay: boolean;
}

export interface WriterCredentials {
  deviceId: string;
  writerEpoch: number;
  writerToken: string;
}

export interface CreateSessionRequest {
  /** Exact fork prefix length, separate from the immutable DSH header. */
  inheritedEventCount?: number;
  sessionId: string;
  header: JsonValue;
  deviceId: string;
}

export interface CreateSessionResult {
  sessionId: string;
  revision: number;
  nextSeq: number;
  writer: WriterCredentials;
}

/** Atomic first materialization used by the lazy-create adapter. */
export interface MaterializeSessionRequest {
  /** Exact fork prefix length, separate from the immutable DSH header. */
  inheritedEventCount?: number;
  sessionId: string;
  header: JsonValue;
  deviceId: string;
  writerToken: string;
  idempotencyKey: string;
  events: TeleportEvent[];
}

export interface MaterializeSessionResult extends CreateSessionResult {
  idempotentReplay: boolean;
}

export interface AppendRequest {
  sessionId: string;
  writer: WriterCredentials;
  expectedRevision: number;
  expectedNextSeq: number;
  idempotencyKey: string;
  events: TeleportEvent[];
}

export interface AppendResult {
  revision: number;
  nextSeq: number;
  idempotentReplay: boolean;
}

export interface SessionSnapshot {
  /** Exact fork prefix length, separate from the immutable DSH header. */
  inheritedEventCount?: number;
  sessionId: string;
  header: JsonValue;
  revision: number;
  nextSeq: number;
  writerEpoch: number;
  writerDeviceId?: string;
  events: TeleportEvent[];
}

export interface SessionHead {
  /** Exact fork prefix length, separate from the immutable DSH header. */
  inheritedEventCount?: number;
  sessionId: string;
  header: JsonValue;
  revision: number;
  nextSeq: number;
  writerEpoch: number;
  writerDeviceId?: string;
}

export interface CreateHandoffRequest {
  sessionId: string;
  writer: WriterCredentials;
  ttlMs?: number;
}

export interface CreateHandoffResult {
  code: string;
  expiresAt: string;
}

export interface AcceptHandoffRequest {
  code: string;
  deviceId: string;
}

export interface AcceptHandoffResult {
  sessionId: string;
  revision: number;
  nextSeq: number;
  writer: WriterCredentials;
}

export interface RecoverWriterRequest {
  sessionId: string;
  expectedRevision: number;
  expectedWriterEpoch: number;
  deviceId: string;
  writerToken: string;
  idempotencyKey: string;
  actorId: string;
  reason: string;
}

export interface RecoverWriterResult {
  sessionId: string;
  revision: number;
  nextSeq: number;
  writer: WriterCredentials;
  idempotentReplay: boolean;
}

export type WriterAuditAction = "handoff" | "admin_recovery";

export interface WriterAuditEntry {
  idempotencyKey: string;
  action: WriterAuditAction;
  actorId: string;
  reason: string;
  fromDeviceId?: string;
  toDeviceId: string;
  fromEpoch: number;
  toEpoch: number;
  revision: number;
  nextSeq: number;
  createdAt: string;
}

export type TeleportErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "SESSION_EXISTS"
  | "REVISION_CONFLICT"
  | "SEQ_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "WRITER_FENCED"
  | "IMPORT_NOT_ROLLBACKABLE"
  | "HANDOFF_EXPIRED"
  | "HANDOFF_CONSUMED";

export class TeleportError extends Error {
  constructor(
    readonly code: TeleportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TeleportError";
  }
}
