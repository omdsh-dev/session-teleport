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
  createSession(request) {
    return this.request("POST", "/v1/sessions", request);
  }
  materializeSession(request) {
    return this.request("POST", "/v1/sessions/materialize", request);
  }
  listHeads() {
    return this.request("GET", "/v1/sessions");
  }
  head(sessionId) {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/head`);
  }
  snapshot(sessionId, afterSeq = -1) {
    return this.request(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}?after=${afterSeq}`
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
  async request(method, path, body, admin = false) {
    if (admin && this.adminToken === void 0) {
      throw new Error("Teleport admin token is required for this operation");
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
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
