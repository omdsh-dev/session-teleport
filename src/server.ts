import { SCHEMA_VERSION } from "./schema.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { TeleportAuthority } from "./authority.js";
import type {
  AcceptHandoffRequest,
  AppendRequest,
  CreateHandoffRequest,
  CreateSessionRequest,
  RecoverWriterRequest,
  RollbackSessionImportRequest,
} from "./types.js";
import { TeleportError } from "./types.js";

export interface TeleportServerOptions {
  apiToken?: string;
  adminToken?: string;
  maxBodyBytes?: number;
  publicBaseUrl?: string;
}

export interface RunningTeleportServer {
  server: Server;
  listen(host?: string, port?: number): Promise<{ host: string; port: number; url: string }>;
  close(): Promise<void>;
}

export function createTeleportServer(
  authority: TeleportAuthority,
  options: TeleportServerOptions = {},
): RunningTeleportServer {
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
        url.pathname,
      );
      if (request.method === "POST" && recoveryMatch !== null) {
        authorizeAdmin(request, options.adminToken);
        const body = await jsonBody<Record<string, unknown>>(request, maxBodyBytes);
        sendJson(
          response,
          200,
          await authority.recoverWriter({
            ...body,
            sessionId: decodeURIComponent(recoveryMatch[1]!),
          } as unknown as RecoverWriterRequest),
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
            decodeURIComponent(auditMatch[1]!),
            numberParameter(url.searchParams.get("limit"), 100),
          ),
        );
        return;
      }

      const importRollbackMatch =
        /^\/v1\/admin\/sessions\/([^/]+)\/rollback-import$/.exec(url.pathname);
      if (request.method === "POST" && importRollbackMatch !== null) {
        authorizeAdmin(request, options.adminToken);
        const body = await jsonBody<Record<string, unknown>>(request, maxBodyBytes);
        sendJson(
          response,
          200,
          await authority.rollbackImport({
            ...body,
            sessionId: decodeURIComponent(importRollbackMatch[1]!),
          } as unknown as RollbackSessionImportRequest),
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
            await jsonBody(request, maxBodyBytes),
          ),
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        sendJson(
          response,
          201,
          await authority.createSession(
            await jsonBody<CreateSessionRequest>(request, maxBodyBytes),
          ),
        );
        return;
      }

      const headMatch = /^\/v1\/sessions\/([^/]+)\/head$/.exec(url.pathname);
      if (request.method === "GET" && headMatch !== null) {
        sendJson(
          response,
          200,
          await authority.head(decodeURIComponent(headMatch[1]!)),
        );
        return;
      }

      const snapshotMatch = /^\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && snapshotMatch !== null) {
        const after = numberParameter(url.searchParams.get("after"), -1);
        sendJson(response, 200, await authority.snapshot(decodeURIComponent(snapshotMatch[1]!), after));
        return;
      }

      const watchMatch = /^\/v1\/sessions\/([^/]+)\/watch$/.exec(url.pathname);
      if (request.method === "GET" && watchMatch !== null) {
        await watch(
          request,
          response,
          authority,
          decodeURIComponent(watchMatch[1]!),
          numberParameter(url.searchParams.get("after"), -1),
        );
        return;
      }

      const appendMatch = /^\/v1\/sessions\/([^/]+)\/append$/.exec(url.pathname);
      if (request.method === "POST" && appendMatch !== null) {
        const body = await jsonBody<Record<string, unknown>>(request, maxBodyBytes);
        sendJson(
          response,
          200,
          await authority.append({
            ...body,
            sessionId: decodeURIComponent(appendMatch[1]!),
          } as unknown as AppendRequest),
        );
        return;
      }

      const handoffMatch = /^\/v1\/sessions\/([^/]+)\/handoffs$/.exec(url.pathname);
      if (request.method === "POST" && handoffMatch !== null) {
        const body = await jsonBody<Record<string, unknown>>(request, maxBodyBytes);
        const result = await authority.createHandoff({
          ...body,
          sessionId: decodeURIComponent(handoffMatch[1]!),
        } as unknown as CreateHandoffRequest);
        const base = options.publicBaseUrl?.replace(/\/$/, "");
        sendJson(response, 201, {
          ...result,
          ...(base === undefined
            ? {}
            : { acceptEndpoint: `${base}/v1/handoffs/${result.code}/accept` }),
        });
        return;
      }

      const acceptMatch = /^\/v1\/handoffs\/([^/]+)\/accept$/.exec(url.pathname);
      if (request.method === "POST" && acceptMatch !== null) {
        const body = await jsonBody<Record<string, unknown>>(request, maxBodyBytes);
        sendJson(
          response,
          200,
          await authority.acceptHandoff({
            ...body,
            code: decodeURIComponent(acceptMatch[1]!),
          } as unknown as AcceptHandoffRequest),
        );
        return;
      }

      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "route not found" } });
    } catch (error: unknown) {
      sendError(response, error);
    }
  });

  return {
    server,
    listen: (host = "127.0.0.1", port = 0) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address() as AddressInfo;
          resolve({ host, port: address.port, url: `http://${host}:${address.port}` });
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

function validateAuthentication(options: TeleportServerOptions): void {
  if (options.apiToken !== undefined && options.apiToken.length === 0) {
    throw new TypeError("Teleport API token must not be empty");
  }
  if (options.adminToken !== undefined && options.adminToken.length === 0) {
    throw new TypeError("Teleport admin token must not be empty");
  }
  if (options.adminToken !== undefined && options.adminToken === options.apiToken) {
    throw new TypeError("Teleport admin token must differ from the API token");
  }
}

async function watch(
  request: IncomingMessage,
  response: ServerResponse,
  authority: TeleportAuthority,
  sessionId: string,
  afterSeq: number,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let cursor = afterSeq;
  let chain = Promise.resolve();
  let closed = false;
  let unsubscribe = () => {};
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  const publish = (kind: string) => {
    chain = chain
      .then(async () => {
        if (closed) return;
        const snapshot = await authority.snapshot(sessionId, cursor);
        if (snapshot.events.length > 0) cursor = snapshot.events.at(-1)!.seq;
        response.write(`event: ${kind}\ndata: ${JSON.stringify(snapshot)}\n\n`);
      })
      .catch((error: unknown) => {
        if (!closed) {
          response.write(
            `event: error\ndata: ${JSON.stringify({ message: String(error) })}\n\n`,
          );
          cleanup();
          response.end();
        }
      });
  };
  const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
  unsubscribe = authority.subscribe(sessionId, (kind) => publish(kind));
  publish("snapshot");
  request.once("close", cleanup);
  response.once("close", cleanup);
}

function authorize(request: IncomingMessage, apiToken: string | undefined): void {
  if (apiToken === undefined) return;
  if (!matchesSecret(request.headers.authorization, `Bearer ${apiToken}`)) {
    throw new HttpError(401, "UNAUTHORIZED", "missing or invalid bearer token");
  }
}

function authorizeAdmin(request: IncomingMessage, adminToken: string | undefined): void {
  if (adminToken === undefined) {
    throw new HttpError(503, "ADMIN_DISABLED", "admin recovery is not configured");
  }
  const supplied = request.headers["x-teleport-admin-token"];
  if (typeof supplied !== "string" || !matchesSecret(supplied, adminToken)) {
    throw new HttpError(403, "ADMIN_FORBIDDEN", "missing or invalid admin token");
  }
}

function matchesSecret(supplied: string | undefined, expected: string): boolean {
  if (supplied === undefined) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function jsonBody<T = unknown>(request: IncomingMessage, maxBytes: number): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "BAD_JSON", "request body must be valid JSON");
  }
}

function numberParameter(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, "BAD_REQUEST", "invalid number");
  return parsed;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof TeleportError) {
    const status =
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "BAD_REQUEST"
          ? 400
          : error.code.startsWith("HANDOFF_")
            ? 410
            : 409;
    sendJson(response, status, { error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(response, 500, { error: { code: "INTERNAL", message: "internal server error" } });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
