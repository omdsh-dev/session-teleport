import { PGlite } from "@electric-sql/pglite";
import type {
  QueryResult,
  SqlDatabase,
  SqlExecutor,
  TransactionOptions,
} from "../src/database.js";

class PgliteExecutor implements SqlExecutor {
  constructor(private readonly client: Pick<PGlite, "query">) {}

  async query<T = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    const result = await this.client.query<T>(text, [...values]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }
}

export class PgliteDatabase implements SqlDatabase {
  readonly client = new PGlite();

  query<T = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return new PgliteExecutor(this.client).query<T>(text, values);
  }

  transaction<T>(
    operation: (transaction: SqlExecutor) => Promise<T>,
    _options: TransactionOptions = {},
  ): Promise<T> {
    return this.client.transaction((transaction) => operation(new PgliteExecutor(transaction)));
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
