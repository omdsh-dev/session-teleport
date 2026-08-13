import {
  captureSessionBundle,
  writeCaptureStatus
} from "./source-capture.js";
async function apply(ctx, config) {
  const source = ctx.sessionPersistence;
  const sourceBackend = source.name ?? "unknown";
  let result;
  try {
    if (sourceBackend === "session-persistence-teleport") {
      throw new Error("capture source is already the Teleport authority");
    }
    result = await captureSessionBundle(
      source,
      config.sessionId,
      config.outputPath,
      sourceBackend
    );
    await writeCaptureStatus(config.statusPath, {
      version: 1,
      nonce: config.nonce,
      ok: true,
      result
    });
  } catch (error) {
    await writeCaptureStatus(config.statusPath, {
      version: 1,
      nonce: config.nonce,
      ok: false,
      error: safeErrorCode(error)
    });
    throw error;
  }
}
apply.inject = ["sessionPersistence"];
var source_export_plugin_default = apply;
function safeErrorCode(error) {
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) {
    return `source Session capture failed (${error.code})`;
  }
  return "source Session capture failed; inspect the source profile locally";
}
export {
  apply,
  source_export_plugin_default as default
};
//# sourceMappingURL=source-export-plugin.js.map
