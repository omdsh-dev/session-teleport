import type { JsonValue } from "./types.js";
/** Stable JSON encoding used for request digests and JSONB parameters. */
export declare function canonicalJson(value: unknown): string;
export declare function sha256(value: string): string;
export declare function secret(bytes?: number): string;
export declare function asJsonValue(value: unknown): JsonValue;
