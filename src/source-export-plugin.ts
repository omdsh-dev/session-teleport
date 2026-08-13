import {
  captureSessionBundle,
  writeCaptureStatus,
  type SessionCaptureResult,
} from "./source-capture.js";
import type { SessionSnapshotSource } from "./importer.js";

export interface SourceExportPluginConfig {
  sessionId: string;
  outputPath: string;
  statusPath: string;
  nonce: string;
}

interface SourceExportContext {
  sessionPersistence: SessionSnapshotSource & { name?: string };
}

/**
 * One-shot, read-only overlay used by `dsh-teleport-import capture`.
 *
 * This function intentionally has no Cordis or DSH runtime import. Attaching
 * `inject` directly to the default-exported function lets an old profile load
 * the temporary overlay without installing this package's optional peers.
 */
export async function apply(
  ctx: SourceExportContext,
  config: SourceExportPluginConfig,
): Promise<void> {
  const source = ctx.sessionPersistence;
  const sourceBackend = source.name ?? "unknown";
  let result: SessionCaptureResult;
  try {
    if (sourceBackend === "session-persistence-teleport") {
      throw new Error("capture source is already the Teleport authority");
    }
    result = await captureSessionBundle(
      source,
      config.sessionId,
      config.outputPath,
      sourceBackend,
    );
    await writeCaptureStatus(config.statusPath, {
      version: 1,
      nonce: config.nonce,
      ok: true,
      result,
    });
  } catch (error: unknown) {
    await writeCaptureStatus(config.statusPath, {
      version: 1,
      nonce: config.nonce,
      ok: false,
      error: safeErrorCode(error),
    });
    throw error;
  }
}

apply.inject = ["sessionPersistence"];

export default apply;

function safeErrorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
  ) {
    return `source Session capture failed (${error.code})`;
  }
  return "source Session capture failed; inspect the source profile locally";
}
