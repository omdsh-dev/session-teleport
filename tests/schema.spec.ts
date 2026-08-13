import { afterEach, describe, expect, it } from "vitest";
import { initializeSchema, SCHEMA_VERSION } from "../src/schema.js";
import { PgliteDatabase } from "./pglite.js";

describe("Teleport schema lifecycle", () => {
  const databases: PgliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  it("creates the current schema with order-preserving JSON events", async () => {
    const database = trackedDatabase();
    await initializeSchema(database);
    const version = await database.query<{ value: string }>(
      "SELECT value FROM teleport_schema_meta WHERE key = 'schema_version'",
    );
    const type = await eventColumnType(database);
    expect(version.rows[0]?.value).toBe(String(SCHEMA_VERSION));
    expect(type).toBe("json");
  });

  it("migrates an empty v1 JSONB event table to the current schema", async () => {
    const database = trackedDatabase();
    await initializeSchema(database);
    await database.query(
      "ALTER TABLE teleport_events ALTER COLUMN event TYPE JSONB USING event::jsonb",
    );
    await database.query(
      "UPDATE teleport_schema_meta SET value = '1' WHERE key = 'schema_version'",
    );

    await initializeSchema(database);
    expect(await eventColumnType(database)).toBe("json");
    const version = await database.query<{ value: string }>(
      "SELECT value FROM teleport_schema_meta WHERE key = 'schema_version'",
    );
    expect(version.rows[0]?.value).toBe(String(SCHEMA_VERSION));
  });

  it("adds writer audit while migrating a v2 store", async () => {
    const database = trackedDatabase();
    await initializeSchema(database);
    await database.query("DROP TABLE teleport_writer_audit");
    await database.query(
      "UPDATE teleport_schema_meta SET value = '2' WHERE key = 'schema_version'",
    );

    await initializeSchema(database);
    const version = await database.query<{ value: string }>(
      "SELECT value FROM teleport_schema_meta WHERE key = 'schema_version'",
    );
    const auditTable = await database.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM information_schema.tables
        WHERE table_name = 'teleport_writer_audit'`,
    );
    expect(version.rows[0]?.value).toBe(String(SCHEMA_VERSION));
    expect(Number(auditTable.rows[0]?.count)).toBe(1);
  });

  it("adds import rollback audit while migrating a v3 store", async () => {
    const database = trackedDatabase();
    await initializeSchema(database);
    await database.query("DROP TABLE teleport_import_rollback_audit");
    await database.query(
      "UPDATE teleport_schema_meta SET value = '3' WHERE key = 'schema_version'",
    );

    await initializeSchema(database);
    const version = await database.query<{ value: string }>(
      "SELECT value FROM teleport_schema_meta WHERE key = 'schema_version'",
    );
    const auditTable = await database.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM information_schema.tables
        WHERE table_name = 'teleport_import_rollback_audit'`,
    );
    expect(version.rows[0]?.value).toBe(String(SCHEMA_VERSION));
    expect(Number(auditTable.rows[0]?.count)).toBe(1);
  });

  it("refuses a populated v1 JSONB store because key order cannot be recovered", async () => {
    const database = trackedDatabase();
    await initializeSchema(database);
    await database.query(
      "ALTER TABLE teleport_events ALTER COLUMN event TYPE JSONB USING event::jsonb",
    );
    await database.query(
      `INSERT INTO teleport_sessions
        (session_id, header, writer_device_id, writer_token_hash)
       VALUES ('legacy', '{}'::jsonb, 'device', 'hash')`,
    );
    await database.query(
      `INSERT INTO teleport_events (session_id, seq, event)
       VALUES ('legacy', 0, '{"z":1,"a":2}'::jsonb)`,
    );
    await database.query(
      "UPDATE teleport_schema_meta SET value = '1' WHERE key = 'schema_version'",
    );

    await expect(initializeSchema(database)).rejects.toThrow(/cannot be migrated losslessly/);
    const version = await database.query<{ value: string }>(
      "SELECT value FROM teleport_schema_meta WHERE key = 'schema_version'",
    );
    expect(version.rows[0]?.value).toBe("1");
  });

  it("fails loud on a schema version from a newer incompatible build", async () => {
    const database = trackedDatabase();
    await initializeSchema(database);
    await database.query(
      "UPDATE teleport_schema_meta SET value = '999' WHERE key = 'schema_version'",
    );
    await expect(initializeSchema(database)).rejects.toThrow(/version 999 is incompatible/);
  });

  function trackedDatabase(): PgliteDatabase {
    const database = new PgliteDatabase();
    databases.push(database);
    return database;
  }
});

async function eventColumnType(database: PgliteDatabase): Promise<string | undefined> {
  const result = await database.query<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = 'teleport_events' AND column_name = 'event'`,
  );
  return result.rows[0]?.data_type;
}
