import { Pool } from "pg";
class PgExecutor {
  constructor(client) {
    this.client = client;
  }
  client;
  async query(text, values = []) {
    const result = await this.client.query(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }
}
class PostgresDatabase {
  pool;
  constructor(connectionString, options = {}) {
    this.pool = new Pool({
      connectionString,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5e3,
      query_timeout: options.queryTimeoutMillis ?? 3e4,
      statement_timeout: options.statementTimeoutMillis ?? 3e4,
      idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMillis ?? 3e4,
      application_name: options.applicationName ?? "dsh-session-teleport"
    });
    this.pool.on("error", (error) => options.onIdleClientError?.(error));
  }
  async query(text, values = []) {
    const result = await this.pool.query(text, [...values]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }
  async transaction(operation, options = {}) {
    const client = await this.pool.connect();
    const onClientError = (_error) => {
    };
    client.on("error", onClientError);
    try {
      const isolation = options.isolationLevel?.toUpperCase() ?? "READ COMMITTED";
      const readMode = options.readOnly ? " READ ONLY" : "";
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}${readMode}`);
      const result = await operation(new PgExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw error;
    } finally {
      client.off("error", onClientError);
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}
export {
  PostgresDatabase
};
//# sourceMappingURL=database.js.map
