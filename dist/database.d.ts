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
    transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>, options?: TransactionOptions): Promise<T>;
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
export declare class PostgresDatabase implements SqlDatabase {
    private readonly pool;
    constructor(connectionString: string, options?: PostgresDatabaseOptions);
    query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
    transaction<T>(operation: (transaction: SqlExecutor) => Promise<T>, options?: TransactionOptions): Promise<T>;
    close(): Promise<void>;
}
