#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { TeleportClient } from "./client.js";
import { FileWriterCredentialStore } from "./credential-store.js";

const [command, value] = process.argv.slice(2);
if (value === undefined || (command !== "create-handoff" && command !== "accept-handoff")) {
  usage();
  process.exitCode = 2;
} else {
  const baseUrl = process.env.DSH_TELEPORT_URL ?? "http://127.0.0.1:43127";
  const apiToken = process.env.DSH_TELEPORT_API_TOKEN;
  const deviceId =
    process.env.DSH_TELEPORT_DEVICE_ID ?? process.env.HOSTNAME ?? "local-device";
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const credentialDir =
    process.env.DSH_TELEPORT_CREDENTIAL_DIR ?? join(dshHome, "session-teleport", "writers");
  const client = new TeleportClient(baseUrl, apiToken);
  const credentials = new FileWriterCredentialStore(credentialDir);

  try {
    if (command === "create-handoff") {
      const writer = await credentials.get(value);
      if (writer === undefined) {
        throw new Error(`this device has no writer credential for session "${value}"`);
      }
      if (writer.deviceId !== deviceId) {
        throw new Error(
          `writer credential belongs to device "${writer.deviceId}", current device is "${deviceId}"`,
        );
      }
      const handoff = await client.createHandoff({ sessionId: value, writer });
      process.stdout.write(`${JSON.stringify({
        sessionId: value,
        code: handoff.code,
        expiresAt: handoff.expiresAt,
      })}\n`);
    } else {
      const accepted = await client.acceptHandoff({ code: value, deviceId });
      await credentials.put(accepted.sessionId, accepted.writer);
      process.stdout.write(`${JSON.stringify({
        sessionId: accepted.sessionId,
        deviceId,
        writerEpoch: accepted.writer.writerEpoch,
        revision: accepted.revision,
        nextSeq: accepted.nextSeq,
      })}\n`);
    }
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function usage(): void {
  process.stderr.write(
    "usage: dsh-teleport-device create-handoff <session-id> | accept-handoff <code>\n",
  );
}
