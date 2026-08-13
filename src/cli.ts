#!/usr/bin/env node
import { TeleportAuthority } from "./authority.js";
import { PostgresDatabase } from "./database.js";
import { initializeSchema } from "./schema.js";
import { createTeleportServer } from "./server.js";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("DATABASE_URL is required");
}
const host = process.env.TELEPORT_HOST ?? "127.0.0.1";
const port = Number(process.env.TELEPORT_PORT ?? "43127");
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
  throw new Error("TELEPORT_PORT must be an integer between 0 and 65535");
}
const apiToken = process.env.TELEPORT_API_TOKEN;
const adminToken = process.env.TELEPORT_ADMIN_TOKEN;
if (apiToken === undefined && host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
  throw new Error("TELEPORT_API_TOKEN is required when binding outside loopback");
}
if (adminToken !== undefined && adminToken === apiToken) {
  throw new Error("TELEPORT_ADMIN_TOKEN must differ from TELEPORT_API_TOKEN");
}

const database = new PostgresDatabase(connectionString, {
  connectionTimeoutMillis: milliseconds("TELEPORT_DB_CONNECT_TIMEOUT_MS", 5_000),
  queryTimeoutMillis: milliseconds("TELEPORT_DB_QUERY_TIMEOUT_MS", 30_000),
  statementTimeoutMillis: milliseconds("TELEPORT_DB_STATEMENT_TIMEOUT_MS", 30_000),
  idleInTransactionTimeoutMillis: milliseconds("TELEPORT_DB_IDLE_TX_TIMEOUT_MS", 30_000),
  onIdleClientError: (error) => {
    console.error(`PostgreSQL idle connection lost; the pool will reconnect: ${error.message}`);
  },
});
await initializeSchema(database);
const authority = new TeleportAuthority(database);
const app = createTeleportServer(authority, {
  ...(apiToken === undefined ? {} : { apiToken }),
  ...(adminToken === undefined ? {} : { adminToken }),
  maxBodyBytes: bytes("TELEPORT_MAX_BODY_BYTES", 4 * 1024 * 1024),
  publicBaseUrl: process.env.TELEPORT_PUBLIC_URL ?? `http://${host}:${port}`,
});
const listening = await app.listen(host, port);
console.log(`dsh-session-teleport listening on ${listening.url}`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await app.close();
  await database.close();
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

function milliseconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function bytes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
