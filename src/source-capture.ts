import { spawn, type ChildProcess } from "node:child_process";
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
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { secret } from "./canonical.js";
import {
  exportSessionImportBundle,
  parseSessionImportBundle,
  sessionImportDigest,
  type SessionSnapshotSource,
} from "./importer.js";

export interface SessionCaptureResult {
  sessionId: string;
  digest: string;
  eventCount: number;
  nextSeq: number;
  bundleBytes: number;
  outputPath: string;
  sourceBackend: string;
}

export interface CaptureStatus {
  version: 1;
  nonce: string;
  ok: boolean;
  result?: SessionCaptureResult;
  error?: string;
}

export interface ProfileCaptureOptions {
  profile: string;
  sessionId: string;
  outputPath: string;
  dshCommand?: string;
  dshArgsPrefix?: readonly string[];
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  sourcePluginUrl?: string;
}

/** Export one consistent storage read to a no-clobber owner-only file. */
export async function captureSessionBundle(
  source: SessionSnapshotSource,
  sessionId: string,
  outputPath: string,
  sourceBackend = "unknown",
  signal?: AbortSignal,
): Promise<SessionCaptureResult> {
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
    sourceBackend,
  };
}

/** Publish a sensitive bundle atomically without ever replacing an existing path. */
export async function writeSessionImportBundle(
  outputPath: string,
  value: unknown,
): Promise<number> {
  const bundle = parseSessionImportBundle(value);
  const target = resolve(outputPath);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(bundle)}\n`;
  const temporary = join(
    directory,
    `.${basename(target)}.${process.pid}.${secret(8)}.tmp`,
  );
  let published = false;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    // link(2) is an atomic, no-replace publish on the same filesystem.
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
      // The successful path closes before publish.
    }
    if (!published) {
      try {
        await unlink(temporary);
      } catch (error: unknown) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }
}

/**
 * Boot an existing DSH profile with a temporary read-only overlay. The source
 * backend remains authoritative and untouched; only the requested bundle is
 * written locally.
 */
export async function captureSessionFromProfile(
  options: ProfileCaptureOptions,
): Promise<SessionCaptureResult> {
  assertText(options.profile, "profile");
  assertText(options.sessionId, "sessionId");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new TypeError("capture timeout must be between 1000 and 300000 ms");
  }
  const outputPath = resolve(options.outputPath);
  await assertPathAbsent(outputPath);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-teleport-capture-"));
  await chmod(temporaryRoot, 0o700);
  const patchPath = join(temporaryRoot, "capture.patch.yml");
  const statusPath = join(temporaryRoot, "status.json");
  const stagedBundlePath = join(temporaryRoot, "bundle.session-import.json");
  const nonce = secret(24);
  const sourcePluginUrl =
    options.sourcePluginUrl ?? new URL("./source-export-plugin.js", import.meta.url).href;
  await writeFile(
    patchPath,
    capturePatch(sourcePluginUrl),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );

  const environment = captureEnvironment(options.environment ?? process.env, {
    sessionId: options.sessionId,
    outputPath: stagedBundlePath,
    statusPath,
    nonce,
  });
  const child = spawn(
    options.dshCommand ?? "dsh",
    [...(options.dshArgsPrefix ?? []), "--profile", options.profile, "--patch", patchPath],
    {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const childState = observeChild(child);

  try {
    const status = await waitForCaptureStatus(
      child,
      statusPath,
      nonce,
      timeoutMs,
      childState.spawnError,
    );
    if (!status.ok || status.result === undefined) {
      throw new Error(status.error ?? "DSH source capture failed");
    }
    const raw = await readFile(stagedBundlePath, "utf8");
    const bundle = parseSessionImportBundle(JSON.parse(raw) as unknown);
    if (
      status.result.sessionId !== options.sessionId ||
      status.result.outputPath !== stagedBundlePath ||
      status.result.digest !== sessionImportDigest(bundle) ||
      status.result.eventCount !== bundle.events.length ||
      status.result.nextSeq !== bundle.events.length ||
      status.result.bundleBytes !== Buffer.byteLength(raw) ||
      typeof status.result.sourceBackend !== "string" ||
      status.result.sourceBackend.length === 0 ||
      status.result.sourceBackend.length > 256
    ) {
      throw new Error("source capture status does not match the published bundle");
    }
    const bundleBytes = await writeSessionImportBundle(outputPath, bundle);
    return { ...status.result, outputPath, bundleBytes };
  } finally {
    // Child output is deliberately not echoed: a profile's boot diagnostics
    // can contain deployment credentials. The structured status carries the
    // operation error without copying arbitrary logs across the trust seam.
    await stopChild(child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function writeCaptureStatus(path: string, status: CaptureStatus): Promise<void> {
  const temporary = `${path}.${process.pid}.${secret(8)}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    await handle.writeFile(`${JSON.stringify(status)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    renamed = true;
  } finally {
    try {
      await handle.close();
    } catch {
      // The successful path closes before rename.
    }
    if (!renamed) {
      try {
        await unlink(temporary);
      } catch (error: unknown) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }
}

function capturePatch(sourcePluginUrl: string): string {
  return [
    "- insert:",
    "    - id: session-teleport-source-export",
    `      name: '${sourcePluginUrl.replaceAll("'", "''")}'`,
    "      config:",
    "        sessionId: !!js process.env.DSH_TELEPORT_CAPTURE_SESSION_ID",
    "        outputPath: !!js process.env.DSH_TELEPORT_CAPTURE_OUTPUT_PATH",
    "        statusPath: !!js process.env.DSH_TELEPORT_CAPTURE_STATUS_PATH",
    "        nonce: !!js process.env.DSH_TELEPORT_CAPTURE_NONCE",
    "",
  ].join("\n");
}

function captureEnvironment(
  source: NodeJS.ProcessEnv,
  values: { sessionId: string; outputPath: string; statusPath: string; nonce: string },
): NodeJS.ProcessEnv {
  const environment = { ...source };
  // The read-only source boot does not need target-authority or
  // package-manager credentials. Scrub by category so alternative package
  // sources do not need an ever-growing explicit denylist.
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

async function waitForCaptureStatus(
  child: ChildProcess,
  statusPath: string,
  nonce: string,
  timeoutMs: number,
  spawnError: () => Error | undefined,
): Promise<CaptureStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(statusPath, "utf8");
      const status = parseCaptureStatus(JSON.parse(raw) as unknown, nonce);
      return status;
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    const failure = spawnError();
    if (failure !== undefined) throw failure;
    if (child.exitCode !== null) {
      throw new Error(`DSH source profile exited before capture (code ${child.exitCode})`);
    }
    await delay(25);
  }
  throw new Error(`DSH source capture timed out after ${timeoutMs} ms`);
}

function parseCaptureStatus(value: unknown, nonce: string): CaptureStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capture status is invalid");
  }
  const status = value as Partial<CaptureStatus>;
  if (status.version !== 1 || status.nonce !== nonce || typeof status.ok !== "boolean") {
    throw new Error("capture status identity is invalid");
  }
  return status as CaptureStatus;
}

function observeChild(
  child: ChildProcess,
): { spawnError: () => Error | undefined } {
  let failure: Error | undefined;
  // Drain both pipes without retaining profile logs, which may be sensitive.
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  child.once("error", (error) => {
    failure = error;
  });
  return {
    spawnError: () => failure,
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gracefulClose = new Promise<boolean>((resolveExit) =>
    child.once("close", () => resolveExit(true)),
  );
  child.kill("SIGINT");
  const exited = await Promise.race([
    gracefulClose,
    delay(5_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    const interruptedClose = new Promise<boolean>((resolveExit) =>
      child.once("close", () => resolveExit(true)),
    );
    // DSH treats a repeated interrupt as the explicit force-exit request.
    child.kill("SIGINT");
    const interrupted = await Promise.race([
      interruptedClose,
      delay(500).then(() => false),
    ]);
    if (!interrupted && child.exitCode === null) {
      const forcedClose = new Promise<void>((resolveExit) =>
        child.once("close", () => resolveExit()),
      );
      child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) await forcedClose;
    }
  }
}

async function assertPathAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`capture output already exists: ${path}`);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

function assertText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${name} must be a non-empty string <= 256 chars`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
