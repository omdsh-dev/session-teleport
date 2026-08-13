#!/usr/bin/env node
import { TeleportAuthority } from "./authority.js";
import { PostgresDatabase } from "./database.js";
import { initializeSchema } from "./schema.js";
import { createTeleportServer } from "./server.js";
const connectionString = process.env.DATABASE_URL;
if (connectionString === void 0 || connectionString.length === 0) {
  throw new Error("DATABASE_URL is required");
}
const host = process.env.TELEPORT_HOST ?? "127.0.0.1";
const port = Number(process.env.TELEPORT_PORT ?? "43127");
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
  throw new Error("TELEPORT_PORT must be an integer between 0 and 65535");
}
const apiToken = process.env.TELEPORT_API_TOKEN;
const adminToken = process.env.TELEPORT_ADMIN_TOKEN;
if (apiToken === void 0 && host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
  throw new Error("TELEPORT_API_TOKEN is required when binding outside loopback");
}
if (adminToken !== void 0 && adminToken === apiToken) {
  throw new Error("TELEPORT_ADMIN_TOKEN must differ from TELEPORT_API_TOKEN");
}
const database = new PostgresDatabase(connectionString, {
  connectionTimeoutMillis: milliseconds("TELEPORT_DB_CONNECT_TIMEOUT_MS", 5e3),
  queryTimeoutMillis: milliseconds("TELEPORT_DB_QUERY_TIMEOUT_MS", 3e4),
  statementTimeoutMillis: milliseconds("TELEPORT_DB_STATEMENT_TIMEOUT_MS", 3e4),
  idleInTransactionTimeoutMillis: milliseconds("TELEPORT_DB_IDLE_TX_TIMEOUT_MS", 3e4),
  onIdleClientError: (error) => {
    console.error(`PostgreSQL idle connection lost; the pool will reconnect: ${error.message}`);
  }
});
await initializeSchema(database);
const authority = new TeleportAuthority(database);
const app = createTeleportServer(authority, {
  ...apiToken === void 0 ? {} : { apiToken },
  ...adminToken === void 0 ? {} : { adminToken },
  maxBodyBytes: bytes("TELEPORT_MAX_BODY_BYTES", 4 * 1024 * 1024),
  publicBaseUrl: process.env.TELEPORT_PUBLIC_URL ?? `http://${host}:${port}`
});
const listening = await app.listen(host, port);
console.log(`dsh-session-teleport listening on ${listening.url}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await database.close();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
function milliseconds(name, fallback) {
  const raw = process.env[name];
  if (raw === void 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
function bytes(name, fallback) {
  const raw = process.env[name];
  if (raw === void 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
//# sourceMappingURL=cli.js.map
