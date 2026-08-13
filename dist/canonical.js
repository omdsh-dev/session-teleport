import { createHash, randomBytes } from "node:crypto";
import { TeleportError } from "./types.js";
function canonicalJson(value) {
  return encode(value, /* @__PURE__ */ new Set());
}
function encode(value, ancestors) {
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
      const object = value;
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
        const record = value;
        const entries = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${encode(record[key], ancestors)}`);
        return `{${entries.join(",")}}`;
      } finally {
        ancestors.delete(object);
      }
    }
    default:
      throw new TeleportError("BAD_REQUEST", `unsupported JSON value: ${typeof value}`);
  }
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function secret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}
function asJsonValue(value) {
  return JSON.parse(canonicalJson(value));
}
export {
  asJsonValue,
  canonicalJson,
  secret,
  sha256
};
//# sourceMappingURL=canonical.js.map
