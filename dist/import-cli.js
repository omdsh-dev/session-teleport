#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TeleportClient } from "./client.js";
import { FileWriterCredentialStore } from "./credential-store.js";
import { FileImportReceiptStore, SessionImporter } from "./importer.js";
import { captureSessionFromProfile } from "./source-capture.js";
const [command, value, ...rest] = process.argv.slice(2);
if (value === void 0 || !["capture", "dry-run", "apply", "rollback"].includes(command ?? "")) {
  usage();
  process.exitCode = 2;
} else {
  try {
    if (command === "capture") {
      const [sessionId, outputPath, ...extra] = rest;
      if (sessionId === void 0 || outputPath === void 0 || extra.length > 0) {
        throw new Error("capture requires <source-profile> <session-id> <bundle.json>");
      }
      if (!outputPath.endsWith(".session-import.json")) {
        throw new Error("capture output must end with .session-import.json");
      }
      const dshArgsPrefix = parseJsonStringArray(
        process.env.DSH_TELEPORT_DSH_ARGS_JSON,
        "DSH_TELEPORT_DSH_ARGS_JSON"
      );
      const result = await captureSessionFromProfile({
        profile: value,
        sessionId,
        outputPath,
        dshArgsPrefix,
        environment: process.env,
        ...process.env.DSH_TELEPORT_DSH_COMMAND === void 0 ? {} : { dshCommand: process.env.DSH_TELEPORT_DSH_COMMAND }
      });
      process.stdout.write(`${JSON.stringify(result)}
`);
      process.exitCode = 0;
    } else {
      const baseUrl = process.env.DSH_TELEPORT_URL ?? "http://127.0.0.1:43127";
      const apiToken = process.env.DSH_TELEPORT_API_TOKEN;
      const adminToken = process.env.DSH_TELEPORT_ADMIN_TOKEN;
      const deviceId = process.env.DSH_TELEPORT_DEVICE_ID ?? process.env.HOSTNAME ?? "local-device";
      const actorId = process.env.DSH_TELEPORT_ADMIN_ACTOR ?? deviceId;
      const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
      const credentialDir = process.env.DSH_TELEPORT_CREDENTIAL_DIR ?? join(dshHome, "session-teleport", "writers");
      const receiptDir = process.env.DSH_TELEPORT_IMPORT_RECEIPT_DIR ?? join(dshHome, "session-teleport", "imports");
      if (command === "rollback" && (adminToken === void 0 || adminToken.length === 0)) {
        throw new Error("DSH_TELEPORT_ADMIN_TOKEN is required for rollback");
      }
      const importer = new SessionImporter(
        new TeleportClient(baseUrl, apiToken, adminToken),
        new FileWriterCredentialStore(credentialDir),
        new FileImportReceiptStore(receiptDir),
        { deviceId, actorId }
      );
      if (command === "rollback") {
        const reason = rest.join(" ").trim();
        if (reason.length === 0) throw new Error("rollback requires a reason");
        process.stdout.write(`${JSON.stringify(await importer.rollback(value, reason))}
`);
      } else {
        const bundle = await readBundle(value);
        const result = command === "dry-run" ? await importer.dryRun(bundle) : await importer.apply(bundle);
        process.stdout.write(`${JSON.stringify(result)}
`);
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  }
}
function parseJsonStringArray(value2, name) {
  if (value2 === void 0 || value2.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(value2);
  } catch (error) {
    throw new Error(`${name} must be a JSON string array`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return parsed;
}
async function readBundle(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read import bundle "${path}"`, { cause: error });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`import bundle "${path}" is not valid JSON`, { cause: error });
  }
}
function usage() {
  process.stderr.write(
    "usage: dsh-teleport-import capture <source-profile> <session-id> <bundle.json> | dry-run <bundle.json> | apply <bundle.json> | rollback <session-id> <reason>\n"
  );
}
//# sourceMappingURL=import-cli.js.map
