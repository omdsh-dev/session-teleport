class TeleportRemoteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "TeleportRemoteError";
  }
  status;
  code;
}
class TeleportClient {
  constructor(baseUrl, apiToken, adminToken) {
    this.apiToken = apiToken;
    this.adminToken = adminToken;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  apiToken;
  adminToken;
  baseUrl;
  async health(signal, requiredSchemaVersion) {
    const response = await fetch(`${this.baseUrl}/health`, {
      ...signal === void 0 ? {} : { signal }
    });
    if (response.ok) {
      if (requiredSchemaVersion === void 0) {
        await response.arrayBuffer();
      } else {
        const body = await response.json();
        if (body.schemaVersion !== requiredSchemaVersion) {
          throw new TeleportRemoteError(
            409,
            "SCHEMA_INCOMPATIBLE",
            `Teleport authority must run schema ${requiredSchemaVersion}; upgrade the service with the adapter`
          );
        }
      }
      return;
    }
    let message = `Teleport service returned HTTP ${response.status}`;
    try {
      const payload = await response.json();
      message = payload.error?.message ?? message;
    } catch {
    }
    throw new TeleportRemoteError(response.status, "HEALTH_CHECK_FAILED", message);
  }
  createSession(request) {
    return this.request("POST", "/v1/sessions", request);
  }
  materializeSession(request) {
    return this.request("POST", "/v1/sessions/materialize", request);
  }
  listHeads(signal) {
    return this.request("GET", "/v1/sessions", void 0, false, signal);
  }
  head(sessionId, signal) {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/head`, void 0, false, signal);
  }
  snapshot(sessionId, afterSeq = -1, signal) {
    return this.request(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}?after=${afterSeq}`,
      void 0,
      false,
      signal
    );
  }
  append(request) {
    const { sessionId, ...body } = request;
    return this.request(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/append`,
      body
    );
  }
  createHandoff(request) {
    const { sessionId, ...body } = request;
    return this.request(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/handoffs`,
      body
    );
  }
  acceptHandoff(request) {
    const { code, ...body } = request;
    return this.request(
      "POST",
      `/v1/handoffs/${encodeURIComponent(code)}/accept`,
      body
    );
  }
  recoverWriter(request) {
    const { sessionId, ...body } = request;
    return this.request(
      "POST",
      `/v1/admin/sessions/${encodeURIComponent(sessionId)}/recover-writer`,
      body,
      true
    );
  }
  writerAudit(sessionId, limit = 100) {
    return this.request(
      "GET",
      `/v1/admin/sessions/${encodeURIComponent(sessionId)}/writer-audit?limit=${limit}`,
      void 0,
      true
    );
  }
  rollbackImport(request) {
    const { sessionId, ...body } = request;
    return this.request(
      "POST",
      `/v1/admin/sessions/${encodeURIComponent(sessionId)}/rollback-import`,
      body,
      true
    );
  }
  watchUrl(sessionId, afterSeq = -1) {
    return `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/watch?after=${afterSeq}`;
  }
  async request(method, path, body, admin = false, signal) {
    if (admin && this.adminToken === void 0) {
      throw new Error("Teleport admin token is required for this operation");
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      ...signal === void 0 ? {} : { signal },
      headers: {
        ...this.apiToken === void 0 ? {} : { authorization: `Bearer ${this.apiToken}` },
        ...admin ? { "x-teleport-admin-token": this.adminToken } : {},
        ...body === void 0 ? {} : { "content-type": "application/json" }
      },
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = "error" in payload ? payload.error : void 0;
      throw new TeleportRemoteError(
        response.status,
        error?.code ?? "REMOTE_ERROR",
        error?.message ?? `Teleport service returned HTTP ${response.status}`
      );
    }
    return payload;
  }
}
export {
  TeleportClient,
  TeleportRemoteError
};
//# sourceMappingURL=client.js.map
