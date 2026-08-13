import { spawn } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { secret } from "./canonical.js";
import {
  exportSessionImportBundle,
  parseSessionImportBundle,
  sessionImportDigest
} from "./importer.js";
async function captureSessionBundle(source, sessionId, outputPath, sourceBackend = "unknown", signal) {
  const bundle = await exportSessionImportBundle(source, sessionId, signal);
  const target = resolve(outputPath);
  const bundleBytes = await writeSessionImportBundle(target, bundle);
  return {
    sessionId,
    digest: sessionImportDigest(bundle),
    eventCount: bundle.events.length,
    nextSeq: bundle.events.length,
    bundleBytes,
    outputPath: target,
    sourceBackend
  };
}
async function writeSessionImportBundle(outputPath, value) {
  const bundle = parseSessionImportBundle(value);
  const target = resolve(outputPath);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 448 });
  const payload = `${JSON.stringify(bundle)}
`;
  const temporary = join(
    directory,
    `.${basename(target)}.${process.pid}.${secret(8)}.tmp`
  );
  let published = false;
  const handle = await open(temporary, "wx", 384);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    await link(temporary, target);
    published = true;
    await unlink(temporary);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return Buffer.byteLength(payload);
  } finally {
    try {
      await handle.close();
    } catch {
    }
    if (!published) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }
}
async function captureSessionFromProfile(options) {
  assertText(options.profile, "profile");
  assertText(options.sessionId, "sessionId");
  const timeoutMs = options.timeoutMs ?? 3e4;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1e3 || timeoutMs > 3e5) {
    throw new TypeError("capture timeout must be between 1000 and 300000 ms");
  }
  const outputPath = resolve(options.outputPath);
  await assertPathAbsent(outputPath);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-teleport-capture-"));
  await chmod(temporaryRoot, 448);
  const patchPath = join(temporaryRoot, "capture.patch.yml");
  const statusPath = join(temporaryRoot, "status.json");
  const stagedBundlePath = join(temporaryRoot, "bundle.session-import.json");
  const nonce = secret(24);
  const sourcePluginUrl = options.sourcePluginUrl ?? new URL("./source-export-plugin.js", import.meta.url).href;
  await writeFile(
    patchPath,
    capturePatch(sourcePluginUrl),
    { encoding: "utf8", mode: 384, flag: "wx" }
  );
  const environment = captureEnvironment(options.environment ?? process.env, {
    sessionId: options.sessionId,
    outputPath: stagedBundlePath,
    statusPath,
    nonce
  });
  const child = spawn(
    options.dshCommand ?? "dsh",
    [...options.dshArgsPrefix ?? [], "--profile", options.profile, "--patch", patchPath],
    {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const childState = observeChild(child);
  try {
    const status = await waitForCaptureStatus(
      child,
      statusPath,
      nonce,
      timeoutMs,
      childState.spawnError
    );
    if (!status.ok || status.result === void 0) {
      throw new Error(status.error ?? "DSH source capture failed");
    }
    const raw = await readFile(stagedBundlePath, "utf8");
    const bundle = parseSessionImportBundle(JSON.parse(raw));
    if (status.result.sessionId !== options.sessionId || status.result.outputPath !== stagedBundlePath || status.result.digest !== sessionImportDigest(bundle) || status.result.eventCount !== bundle.events.length || status.result.nextSeq !== bundle.events.length || status.result.bundleBytes !== Buffer.byteLength(raw) || typeof status.result.sourceBackend !== "string" || status.result.sourceBackend.length === 0 || status.result.sourceBackend.length > 256) {
      throw new Error("source capture status does not match the published bundle");
    }
    const bundleBytes = await writeSessionImportBundle(outputPath, bundle);
    return { ...status.result, outputPath, bundleBytes };
  } finally {
    await stopChild(child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
async function writeCaptureStatus(path, status) {
  const temporary = `${path}.${process.pid}.${secret(8)}.tmp`;
  const handle = await open(temporary, "wx", 384);
  let renamed = false;
  try {
    await handle.writeFile(`${JSON.stringify(status)}
`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    renamed = true;
  } finally {
    try {
      await handle.close();
    } catch {
    }
    if (!renamed) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }
}
function capturePatch(sourcePluginUrl) {
  return [
    "- insert:",
    "    - id: session-teleport-source-export",
    `      name: '${sourcePluginUrl.replaceAll("'", "''")}'`,
    "      config:",
    "        sessionId: !!js process.env.DSH_TELEPORT_CAPTURE_SESSION_ID",
    "        outputPath: !!js process.env.DSH_TELEPORT_CAPTURE_OUTPUT_PATH",
    "        statusPath: !!js process.env.DSH_TELEPORT_CAPTURE_STATUS_PATH",
    "        nonce: !!js process.env.DSH_TELEPORT_CAPTURE_NONCE",
    ""
  ].join("\n");
}
function captureEnvironment(source, values) {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (/(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|DATABASE_URL)/i.test(key)) {
      delete environment[key];
    }
  }
  environment.DSH_TELEMETRY_DISABLED = "1";
  environment.DSH_TELEPORT_CAPTURE_SESSION_ID = values.sessionId;
  environment.DSH_TELEPORT_CAPTURE_OUTPUT_PATH = values.outputPath;
  environment.DSH_TELEPORT_CAPTURE_STATUS_PATH = values.statusPath;
  environment.DSH_TELEPORT_CAPTURE_NONCE = values.nonce;
  return environment;
}
async function waitForCaptureStatus(child, statusPath, nonce, timeoutMs, spawnError) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(statusPath, "utf8");
      const status = parseCaptureStatus(JSON.parse(raw), nonce);
      return status;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    const failure = spawnError();
    if (failure !== void 0) throw failure;
    if (child.exitCode !== null) {
      throw new Error(`DSH source profile exited before capture (code ${child.exitCode})`);
    }
    await delay(25);
  }
  throw new Error(`DSH source capture timed out after ${timeoutMs} ms`);
}
function parseCaptureStatus(value, nonce) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capture status is invalid");
  }
  const status = value;
  if (status.version !== 1 || status.nonce !== nonce || typeof status.ok !== "boolean") {
    throw new Error("capture status identity is invalid");
  }
  return status;
}
function observeChild(child) {
  let failure;
  child.stdout?.on("data", () => {
  });
  child.stderr?.on("data", () => {
  });
  child.once("error", (error) => {
    failure = error;
  });
  return {
    spawnError: () => failure
  };
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gracefulClose = new Promise(
    (resolveExit) => child.once("close", () => resolveExit(true))
  );
  child.kill("SIGINT");
  const exited = await Promise.race([
    gracefulClose,
    delay(5e3).then(() => false)
  ]);
  if (!exited && child.exitCode === null) {
    const interruptedClose = new Promise(
      (resolveExit) => child.once("close", () => resolveExit(true))
    );
    child.kill("SIGINT");
    const interrupted = await Promise.race([
      interruptedClose,
      delay(500).then(() => false)
    ]);
    if (!interrupted && child.exitCode === null) {
      const forcedClose = new Promise(
        (resolveExit) => child.once("close", () => resolveExit())
      );
      child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) await forcedClose;
    }
  }
}
async function assertPathAbsent(path) {
  try {
    await lstat(path);
    throw new Error(`capture output already exists: ${path}`);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}
function assertText(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${name} must be a non-empty string <= 256 chars`);
  }
}
function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
function isNodeError(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
export {
  captureSessionBundle,
  captureSessionFromProfile,
  writeCaptureStatus,
  writeSessionImportBundle
};
//# sourceMappingURL=source-capture.js.map
