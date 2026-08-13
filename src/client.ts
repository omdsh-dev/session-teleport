import type {
  AcceptHandoffRequest,
  AcceptHandoffResult,
  AppendRequest,
  AppendResult,
  CreateHandoffRequest,
  CreateHandoffResult,
  CreateSessionRequest,
  CreateSessionResult,
  MaterializeSessionRequest,
  MaterializeSessionResult,
  RecoverWriterRequest,
  RecoverWriterResult,
  RollbackSessionImportRequest,
  RollbackSessionImportResult,
  SessionHead,
  SessionSnapshot,
  WriterAuditEntry,
} from "./types.js";

export class TeleportRemoteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TeleportRemoteError";
  }
}

/** Typed HTTP client shared by the DSH adapter and administrative CLI. */
export class TeleportClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiToken?: string,
    private readonly adminToken?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async health(signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${this.baseUrl}/health`, {
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.ok) {
      await response.arrayBuffer();
      return;
    }
    let message = `Teleport service returned HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      message = payload.error?.message ?? message;
    } catch {
      // Preserve the status-only diagnostic when an intermediary returns
      // non-JSON content.
    }
    throw new TeleportRemoteError(response.status, "HEALTH_CHECK_FAILED", message);
  }

  createSession(request: CreateSessionRequest): Promise<CreateSessionResult> {
    return this.request("POST", "/v1/sessions", request);
  }

  materializeSession(request: MaterializeSessionRequest): Promise<MaterializeSessionResult> {
    return this.request("POST", "/v1/sessions/materialize", request);
  }

  listHeads(): Promise<SessionHead[]> {
    return this.request("GET", "/v1/sessions");
  }

  head(sessionId: string): Promise<SessionHead> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/head`);
  }

  snapshot(sessionId: string, afterSeq = -1): Promise<SessionSnapshot> {
    return this.request(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}?after=${afterSeq}`,
    );
  }

  append(request: AppendRequest): Promise<AppendResult> {
    const { sessionId, ...body } = request;
    return this.request(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/append`,
      body,
    );
  }

  createHandoff(request: CreateHandoffRequest): Promise<CreateHandoffResult> {
    const { sessionId, ...body } = request;
    return this.request(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/handoffs`,
      body,
    );
  }

  acceptHandoff(request: AcceptHandoffRequest): Promise<AcceptHandoffResult> {
    const { code, ...body } = request;
    return this.request(
      "POST",
      `/v1/handoffs/${encodeURIComponent(code)}/accept`,
      body,
    );
  }

  recoverWriter(request: RecoverWriterRequest): Promise<RecoverWriterResult> {
    const { sessionId, ...body } = request;
    return this.request(
      "POST",
      `/v1/admin/sessions/${encodeURIComponent(sessionId)}/recover-writer`,
      body,
      true,
    );
  }

  writerAudit(sessionId: string, limit = 100): Promise<WriterAuditEntry[]> {
    return this.request(
      "GET",
      `/v1/admin/sessions/${encodeURIComponent(sessionId)}/writer-audit?limit=${limit}`,
      undefined,
      true,
    );
  }

  rollbackImport(
    request: RollbackSessionImportRequest,
  ): Promise<RollbackSessionImportResult> {
    const { sessionId, ...body } = request;
    return this.request(
      "POST",
      `/v1/admin/sessions/${encodeURIComponent(sessionId)}/rollback-import`,
      body,
      true,
    );
  }

  watchUrl(sessionId: string, afterSeq = -1): string {
    return `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/watch?after=${afterSeq}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    admin = false,
  ): Promise<T> {
    if (admin && this.adminToken === undefined) {
      throw new Error("Teleport admin token is required for this operation");
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(this.apiToken === undefined ? {} : { authorization: `Bearer ${this.apiToken}` }),
        ...(admin ? { "x-teleport-admin-token": this.adminToken! } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json()) as
      | T
      | { error?: { code?: string; message?: string } };
    if (!response.ok) {
      const error = "error" in (payload as object)
        ? (payload as { error?: { code?: string; message?: string } }).error
        : undefined;
      throw new TeleportRemoteError(
        response.status,
        error?.code ?? "REMOTE_ERROR",
        error?.message ?? `Teleport service returned HTTP ${response.status}`,
      );
    }
    return payload as T;
  }
}
