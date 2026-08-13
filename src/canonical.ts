import { createHash, randomBytes } from "node:crypto";
import type { JsonValue } from "./types.js";
import { TeleportError } from "./types.js";

/** Stable JSON encoding used for request digests and JSONB parameters. */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>());
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TeleportError("BAD_REQUEST", "JSON numbers must be finite");
      }
      return JSON.stringify(value);
    case "object": {
      const object = value as object;
      if (ancestors.has(object)) {
        throw new TeleportError("BAD_REQUEST", "JSON values must not contain cycles");
      }
      ancestors.add(object);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => encode(item, ancestors)).join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TeleportError("BAD_REQUEST", "only plain JSON objects are supported");
        }
        const record = value as Record<string, unknown>;
        const entries = Object.keys(record)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${encode(record[key], ancestors)}`);
        return `{${entries.join(",")}}`;
      } finally {
        ancestors.delete(object);
      }
    }
    default:
      throw new TeleportError("BAD_REQUEST", `unsupported JSON value: ${typeof value}`);
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}
