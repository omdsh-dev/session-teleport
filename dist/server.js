import { SCHEMA_VERSION } from "./schema.js";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { TeleportError } from "./types.js";
function createTeleportServer(authority, options = {}) {
  validateAuthentication(options);
  const maxBodyBytes = options.maxBodyBytes ?? 4 * 1024 * 1024;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/health") {
        try {
          await authority.checkHealth();
          sendJson(response, 200, { ok: true, database: "ready", schemaVersion: SCHEMA_VERSION });
        } catch {
          sendJson(response, 503, { ok: false, database: "unavailable" });
        }
        return;
      }
      authorize(request, options.apiToken);
      const url = new URL(request.url ?? "/", "http://localhost");
      const recoveryMatch = /^\/v1\/admin\/sessions\/([^/]+)\/recover-writer$/.exec(
        url.pathname
      );
      if (request.method === "POST" && recoveryMatch !== null) {
        authorizeAdmin(request, options.adminToken);
        const body = await jsonBody(request, maxBodyBytes);
        sendJson(
          response,
          200,
          await authority.recoverWriter({
            ...body,
            sessionId: decodeURIComponent(recoveryMatch[1])
          })
        );
        return;
      }
      const auditMatch = /^\/v1\/admin\/sessions\/([^/]+)\/writer-audit$/.exec(url.pathname);
      if (request.method === "GET" && auditMatch !== null) {
        authorizeAdmin(request, options.adminToken);
        sendJson(
          response,
          200,
          await authority.listWriterAudit(
            decodeURIComponent(auditMatch[1]),
            numberParameter(url.searchParams.get("limit"), 100)
          )
        );
        return;
      }
      const importRollbackMatch = /^\/v1\/admin\/sessions\/([^/]+)\/rollback-import$/.exec(url.pathname);
      if (request.method === "POST" && importRollbackMatch !== null) {
        authorizeAdmin(request, options.adminToken);
        const body = await jsonBody(request, maxBodyBytes);
        sendJson(
          response,
          200,
          await authority.rollbackImport({
            ...body,
            sessionId: decodeURIComponent(importRollbackMatch[1])
          })
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/sessions") {
        sendJson(response, 200, await authority.listHeads());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions/materialize") {
        sendJson(
          response,
          201,
          await authority.materializeSession(
            await jsonBody(request, maxBodyBytes)
          )
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        sendJson(
          response,
          201,
          await authority.createSession(
            await jsonBody(request, maxBodyBytes)
          )
        );
        return;
      }
      const headMatch = /^\/v1\/sessions\/([^/]+)\/head$/.exec(url.pathname);
      if (request.method === "GET" && headMatch !== null) {
        sendJson(
          response,
          200,
          await authority.head(decodeURIComponent(headMatch[1]))
        );
        return;
      }
      const snapshotMatch = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && snapshotMatch !== null) {
        const after = numberParameter(url.searchParams.get("after"), -1);
        sendJson(response, 200, await authority.snapshot(decodeURIComponent(snapshotMatch[1]), after));
        return;
      }
      const watchMatch = /^\/v1\/sessions\/([^/]+)\/watch$/.exec(url.pathname);
      if (request.method === "GET" && watchMatch !== null) {
        await watch(
          request,
          response,
          authority,
          decodeURIComponent(watchMatch[1]),
          numberParameter(url.searchParams.get("after"), -1)
        );
        return;
      }
      const appendMatch = /^\/v1\/sessions\/([^/]+)\/append$/.exec(url.pathname);
      if (request.method === "POST" && appendMatch !== null) {
        const body = await jsonBody(request, maxBodyBytes);
        sendJson(
          response,
          200,
          await authority.append({
            ...body,
            sessionId: decodeURIComponent(appendMatch[1])
          })
        );
        return;
      }
      const handoffMatch = /^\/v1\/sessions\/([^/]+)\/handoffs$/.exec(url.pathname);
      if (request.method === "POST" && handoffMatch !== null) {
        const body = await jsonBody(request, maxBodyBytes);
        const result = await authority.createHandoff({
          ...body,
          sessionId: decodeURIComponent(handoffMatch[1])
        });
        const base = options.publicBaseUrl?.replace(/\/$/, "");
        sendJson(response, 201, {
          ...result,
          ...base === void 0 ? {} : { acceptEndpoint: `${base}/v1/handoffs/${result.code}/accept` }
        });
        return;
      }
      const acceptMatch = /^\/v1\/handoffs\/([^/]+)\/accept$/.exec(url.pathname);
      if (request.method === "POST" && acceptMatch !== null) {
        const body = await jsonBody(request, maxBodyBytes);
        sendJson(
          response,
          200,
          await authority.acceptHandoff({
            ...body,
            code: decodeURIComponent(acceptMatch[1])
          })
        );
        return;
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "route not found" } });
    } catch (error) {
      sendError(response, error);
    }
  });
  return {
    server,
    listen: (host = "127.0.0.1", port = 0) => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        const address = server.address();
        resolve({ host, port: address.port, url: `http://${host}:${address.port}` });
      });
    }),
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error === void 0 ? resolve() : reject(error));
    })
  };
}
function validateAuthentication(options) {
  if (options.apiToken !== void 0 && options.apiToken.length === 0) {
    throw new TypeError("Teleport API token must not be empty");
  }
  if (options.adminToken !== void 0 && options.adminToken.length === 0) {
    throw new TypeError("Teleport admin token must not be empty");
  }
  if (options.adminToken !== void 0 && options.adminToken === options.apiToken) {
    throw new TypeError("Teleport admin token must differ from the API token");
  }
}
async function watch(request, response, authority, sessionId, afterSeq) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  let cursor = afterSeq;
  let chain = Promise.resolve();
  let closed = false;
  let unsubscribe = () => {
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  const publish = (kind) => {
    chain = chain.then(async () => {
      if (closed) return;
      const snapshot = await authority.snapshot(sessionId, cursor);
      if (snapshot.events.length > 0) cursor = snapshot.events.at(-1).seq;
      response.write(`event: ${kind}
data: ${JSON.stringify(snapshot)}

`);
    }).catch((error) => {
      if (!closed) {
        response.write(
          `event: error
data: ${JSON.stringify({ message: String(error) })}

`
        );
        cleanup();
        response.end();
      }
    });
  };
  const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15e3);
  unsubscribe = authority.subscribe(sessionId, (kind) => publish(kind));
  publish("snapshot");
  request.once("close", cleanup);
  response.once("close", cleanup);
}
function authorize(request, apiToken) {
  if (apiToken === void 0) return;
  if (!matchesSecret(request.headers.authorization, `Bearer ${apiToken}`)) {
    throw new HttpError(401, "UNAUTHORIZED", "missing or invalid bearer token");
  }
}
function authorizeAdmin(request, adminToken) {
  if (adminToken === void 0) {
    throw new HttpError(503, "ADMIN_DISABLED", "admin recovery is not configured");
  }
  const supplied = request.headers["x-teleport-admin-token"];
  if (typeof supplied !== "string" || !matchesSecret(supplied, adminToken)) {
    throw new HttpError(403, "ADMIN_FORBIDDEN", "missing or invalid admin token");
  }
}
function matchesSecret(supplied, expected) {
  if (supplied === void 0) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
async function jsonBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "BAD_JSON", "request body must be valid JSON");
  }
}
function numberParameter(value, fallback) {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, "BAD_REQUEST", "invalid number");
  return parsed;
}
function sendJson(response, status, value) {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}
function sendError(response, error) {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : void 0);
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof TeleportError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "BAD_REQUEST" ? 400 : error.code.startsWith("HANDOFF_") ? 410 : 409;
    sendJson(response, status, { error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(response, 500, { error: { code: "INTERNAL", message: "internal server error" } });
}
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
  status;
  code;
}
export {
  createTeleportServer
};
//# sourceMappingURL=server.js.map
