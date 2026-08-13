#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalJson, secret, sha256 } from "./canonical.js";
import { TeleportClient, TeleportRemoteError } from "./client.js";
import { FileWriterCredentialStore } from "./credential-store.js";
const [command, sessionId, ...rest] = process.argv.slice(2);
if (sessionId === void 0 || command !== "recover-writer" && command !== "writer-audit") {
  usage();
  process.exitCode = 2;
} else {
  try {
    const baseUrl = process.env.DSH_TELEPORT_URL ?? "http://127.0.0.1:43127";
    const apiToken = process.env.DSH_TELEPORT_API_TOKEN;
    const adminToken = process.env.DSH_TELEPORT_ADMIN_TOKEN;
    const deviceId = process.env.DSH_TELEPORT_DEVICE_ID ?? process.env.HOSTNAME ?? "local-device";
    const actorId = process.env.DSH_TELEPORT_ADMIN_ACTOR ?? deviceId;
    const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    const credentialDir = process.env.DSH_TELEPORT_CREDENTIAL_DIR ?? join(dshHome, "session-teleport", "writers");
    if (adminToken === void 0 || adminToken.length === 0) {
      throw new Error("DSH_TELEPORT_ADMIN_TOKEN is required");
    }
    const client = new TeleportClient(baseUrl, apiToken, adminToken);
    if (command === "writer-audit") {
      process.stdout.write(`${JSON.stringify(await client.writerAudit(sessionId), null, 2)}
`);
    } else {
      const reason = rest.join(" ").trim();
      if (reason.length === 0) {
        throw new Error("recover-writer requires a reason");
      }
      const head = await client.head(sessionId);
      const writerToken = secret();
      const request = {
        sessionId,
        expectedRevision: head.revision,
        expectedWriterEpoch: head.writerEpoch,
        deviceId,
        writerToken,
        actorId,
        reason,
        idempotencyKey: `admin-recovery-${sha256(
          canonicalJson({
            sessionId,
            revision: head.revision,
            writerEpoch: head.writerEpoch,
            deviceId,
            actorId,
            reason,
            writerTokenHash: sha256(writerToken)
          })
        )}`
      };
      const recovered = await recoverWithOneRetry(client, request);
      const credentials = new FileWriterCredentialStore(credentialDir);
      await credentials.put(sessionId, recovered.writer);
      process.stdout.write(
        `${JSON.stringify({
          sessionId,
          deviceId,
          writerEpoch: recovered.writer.writerEpoch,
          revision: recovered.revision,
          nextSeq: recovered.nextSeq,
          idempotentReplay: recovered.idempotentReplay
        })}
`
      );
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  }
}
async function recoverWithOneRetry(client, request) {
  try {
    return await client.recoverWriter(request);
  } catch (error) {
    if (error instanceof TeleportRemoteError) throw error;
    return client.recoverWriter(request);
  }
}
function usage() {
  process.stderr.write(
    "usage: dsh-teleport-admin recover-writer <session-id> <reason> | writer-audit <session-id>\n"
  );
}
//# sourceMappingURL=admin-cli.js.map
