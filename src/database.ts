import { Pool, type PoolClient, type QueryResultRow } from "pg";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface TransactionOptions {
  isolationLevel?: "read committed" | "repeatable read" | "serializable";
  readOnly?: boolean;
}

export interface SqlDatabase extends SqlExecutor {
  transaction<T>(
    operation: (transaction: SqlExecutor) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  close(): Promise<void>;
}

export interface PostgresDatabaseOptions {
  connectionTimeoutMillis?: number;
  queryTimeoutMillis?: number;
  statementTimeoutMillis?: number;
  idleInTransactionTimeoutMillis?: number;
  applicationName?: string;
  onIdleClientError?: (error: Error) => void;
}

class PgExecutor implements SqlExecutor {
  constructor(private readonly client: PoolClient) {}

  async query<T = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.client.query<T & QueryResultRow>(text, [...values]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }
}

export class PostgresDatabase implements SqlDatabase {
  private readonly pool: Pool;

  constructor(connectionString: string, options: PostgresDatabaseOptions = {}) {
    this.pool = new Pool({
      connectionString,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
      query_timeout: options.queryTimeoutMillis ?? 30_000,
      statement_timeout: options.statementTimeoutMillis ?? 30_000,
      idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMillis ?? 30_000,
      application_name: options.applicationName ?? "dsh-session-teleport",
    });
    // node-postgres emits an `error` event when an idle pooled connection dies.
    // Without a listener, a routine database restart terminates the Node process.
    this.pool.on("error", (error) => options.onIdleClientError?.(error));
  }

  async query<T = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.pool.query<T & QueryResultRow>(text, [...values]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  async transaction<T>(
    operation: (transaction: SqlExecutor) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const client = await this.pool.connect();
    // A checked-out client can lose its socket while application code is between
    // queries. Keep that EventEmitter error from becoming an uncaught exception;
    // the next query/COMMIT still rejects and drives the transaction rollback path.
    const onClientError = (_error: Error): void => {};
    client.on("error", onClientError);
    try {
      const isolation = options.isolationLevel?.toUpperCase() ?? "READ COMMITTED";
      const readMode = options.readOnly ? " READ ONLY" : "";
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}${readMode}`);
      const result = await operation(new PgExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original database error.
      }
      throw error;
    } finally {
      client.off("error", onClientError);
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
