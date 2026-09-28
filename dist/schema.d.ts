import type { SqlDatabase } from "./database.js";
export declare const SCHEMA_VERSION = 5;
export declare function initializeSchema(database: SqlDatabase): Promise<void>;
