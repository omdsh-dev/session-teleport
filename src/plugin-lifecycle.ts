import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const TELEPORT_PACKAGE = "@mattheliu/session-teleport";
const TELEPORT_REPOSITORY = "github:omdsh-dev/session-teleport";
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type PluginLifecycleAction =
  | "install"
  | "upgrade"
  | "uninstall"
  | "doctor";
export type CheckStatus = "pass" | "warn" | "fail";

export interface PluginLifecycleOptions {
  action: PluginLifecycleAction;
  profile: string;
  revision?: string;
  apply?: boolean;
  profileStopped?: boolean;
  cutoverSafe?: boolean;
  offline?: boolean;
  environment?: Readonly<Record<string, string | undefined>>;
  dshCommand?: string;
  dshArgsPrefix?: readonly string[];
}

export interface LifecycleCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface PluginLifecycleResult {
  action: PluginLifecycleAction;
  profile: string;
  applied: boolean;
  restartRequired: boolean;
  previousSpec?: string;
  currentSpec?: string;
  checks: LifecycleCheck[];
  notes: string[];
}

interface CommandOutput {
  stdout: string;
  stderr: string;
}

interface ProfileState {
  dependency?: string;
  bundles: string[];
  config: string;
}

/**
 * Plan or apply one controlled DSH profile plugin lifecycle operation.
 * Install/uninstall can change the authority when the target profile carries
 * DSH_TELEPORT_ENABLE=1; upgrade preserves the selected authority but still
 * requires the profile to be stopped. No operation deletes writer credentials,
 * import receipts, or PostgreSQL data.
 */
export async function runPluginLifecycle(
  options: PluginLifecycleOptions,
): Promise<PluginLifecycleResult> {
  validateProfile(options.profile);
  const environment = { ...process.env, ...options.environment };
  const dshHome = resolveDshHome(environment);
  const command =
    options.dshCommand ?? environment.DSH_TELEPORT_DSH_COMMAND ?? "dsh";
  const prefix =
    options.dshArgsPrefix ??
    parseArgsPrefix(environment.DSH_TELEPORT_DSH_ARGS_JSON);
  const runDsh = (args: readonly string[], timeoutMs = 300_000) =>
    runCommand(command, [...prefix, ...args], environment, timeoutMs);

  if (options.action === "doctor") {
    const checks = await doctor(
      options.profile,
      dshHome,
      environment,
      runDsh,
      options.offline === true,
    );
    return {
      action: "doctor",
      profile: options.profile,
      applied: false,
      restartRequired: false,
      checks,
      notes: ["doctor never changes the profile, credentials, or database"],
    };
  }

  const revision =
    options.action === "uninstall"
      ? undefined
      : requireRevision(options.revision);
  const desiredSpec =
    revision === undefined ? undefined : `${TELEPORT_REPOSITORY}#${revision}`;
  const before = await readProfileState(
    dshHome,
    options.profile,
    runDsh,
    false,
  );
  const previousSpec = before?.dependency;
  validateTransition(options.action, previousSpec);

  const plan = lifecyclePlan(
    options.action,
    options.profile,
    previousSpec,
    desiredSpec,
  );
  if (options.apply !== true) {
    return {
      action: options.action,
      profile: options.profile,
      applied: false,
      restartRequired: true,
      ...(previousSpec === undefined ? {} : { previousSpec }),
      ...(desiredSpec === undefined ? {} : { currentSpec: desiredSpec }),
      checks: [],
      notes: plan,
    };
  }

  if (options.profileStopped !== true) {
    throw new Error(
      "refusing to mutate a running profile; pass --profile-stopped after stopping it",
    );
  }
  if (
    (options.action === "install" || options.action === "uninstall") &&
    options.cutoverSafe !== true
  ) {
    throw new Error(
      "this may change the Session authority when DSH_TELEPORT_ENABLE=1; pass --cutover-safe only after migration/cutover is verified",
    );
  }

  const releaseLock = await acquireLifecycleLock(dshHome, options.profile);
  try {
    try {
      if (options.action === "install" || options.action === "upgrade") {
        await runDsh([
          "plugin",
          "--profile",
          options.profile,
          "add",
          desiredSpec!,
        ]);
      } else {
        await runDsh([
          "plugin",
          "--profile",
          options.profile,
          "remove",
          TELEPORT_PACKAGE,
        ]);
      }
    } catch (mutationError: unknown) {
      const changedDependency =
        (await readProfileDependency(dshHome, options.profile)) !==
        previousSpec;
      const rollbackError = changedDependency
        ? await rollbackMutation(
            options.action,
            options.profile,
            previousSpec,
            runDsh,
          )
        : undefined;
      if (rollbackError === undefined) {
        throw new Error(
          changedDependency
            ? `plugin manager failed and the previous dependency was restored: ${errorMessage(mutationError)}`
            : `plugin manager failed before changing the profile dependency: ${errorMessage(mutationError)}`,
          { cause: mutationError },
        );
      }
      throw new Error(
        `plugin manager failed; automatic rollback also failed (${errorMessage(rollbackError)}): ${errorMessage(mutationError)}`,
        { cause: mutationError },
      );
    }

    let checks: LifecycleCheck[];
    try {
      checks = await verifyMutation(
        options.action,
        options.profile,
        dshHome,
        revision,
        runDsh,
      );
    } catch (verificationError: unknown) {
      const rollbackError = await rollbackMutation(
        options.action,
        options.profile,
        previousSpec,
        runDsh,
      );
      const verificationMessage = errorMessage(verificationError);
      if (rollbackError === undefined) {
        throw new Error(
          `plugin verification failed and the previous profile dependency was restored: ${verificationMessage}`,
          { cause: verificationError },
        );
      }
      throw new Error(
        `plugin verification failed; automatic rollback also failed (${errorMessage(rollbackError)}): ${verificationMessage}`,
        { cause: verificationError },
      );
    }

    const current = await readProfileState(
      dshHome,
      options.profile,
      runDsh,
      false,
    );
    return {
      action: options.action,
      profile: options.profile,
      applied: true,
      restartRequired: true,
      ...(previousSpec === undefined ? {} : { previousSpec }),
      ...(current?.dependency === undefined
        ? {}
        : { currentSpec: current.dependency }),
      checks,
      notes: [
        ...plan,
        "writer credentials, import receipts, and PostgreSQL data were left unchanged",
        "run doctor after restarting the profile before resuming a Session",
      ],
    };
  } finally {
    await releaseLock();
  }
}

export function lifecyclePlan(
  action: Exclude<PluginLifecycleAction, "doctor">,
  profile: string,
  previousSpec?: string,
  desiredSpec?: string,
): string[] {
  if (action === "install") {
    return [
      `install ${desiredSpec} into profile ${profile}`,
      "keep JSONL authoritative until DSH_TELEPORT_ENABLE=1 is set after service validation",
      "do not continue an old Session until its import and cutover have been verified",
    ];
  }
  if (action === "upgrade") {
    return [
      `upgrade profile ${profile} from ${previousSpec} to ${desiredSpec}`,
      "restore the previous pinned dependency automatically if structural verification fails",
      "keep the PostgreSQL authority and local writer credentials unchanged",
    ];
  }
  return [
    `remove ${TELEPORT_PACKAGE} from profile ${profile}`,
    "remove only the profile layer; keep PostgreSQL data and local writer credentials",
    "do not resume a Teleport Session on another backend unless an explicit reverse cutover was verified",
  ];
}

async function doctor(
  profile: string,
  dshHome: string,
  environment: Readonly<Record<string, string | undefined>>,
  runDsh: (
    args: readonly string[],
    timeoutMs?: number,
  ) => Promise<CommandOutput>,
  offline: boolean,
): Promise<LifecycleCheck[]> {
  const checks: LifecycleCheck[] = [];
  checks.push({
    name: "node",
    status: nodeVersionSupported(process.versions.node) ? "pass" : "fail",
    detail: `Node.js ${process.versions.node}; requires 22.19+ or 24+`,
  });

  try {
    const version = (await runDsh(["--version"], 30_000)).stdout.trim();
    checks.push({
      name: "dsh",
      status: "pass",
      detail: version || "DSH command is available",
    });
  } catch (error: unknown) {
    checks.push({ name: "dsh", status: "fail", detail: errorMessage(error) });
  }

  let state: ProfileState | undefined;
  try {
    state = await readProfileState(dshHome, profile, runDsh, true);
  } catch (error: unknown) {
    checks.push({
      name: "profile",
      status: "fail",
      detail: errorMessage(error),
    });
  }
  if (state !== undefined) {
    const revision = revisionFromSpec(state.dependency);
    checks.push({
      name: "pinned-dependency",
      status: revision === undefined ? "fail" : "pass",
      detail:
        revision === undefined
          ? "Teleport dependency is missing or is not pinned to a full commit SHA"
          : `Teleport is pinned to ${revision}`,
    });
    checks.push({
      name: "bundle-order",
      status: state.bundles.at(-1) === TELEPORT_PACKAGE ? "pass" : "fail",
      detail:
        state.bundles.at(-1) === TELEPORT_PACKAGE
          ? "Teleport is the final profile bundle"
          : "Teleport must be the final profile bundle",
    });
    checks.push(...configChecks(state.config));
  }

  const credentialDir =
    environment.DSH_TELEPORT_CREDENTIAL_DIR ??
    join(dshHome, "session-teleport", "writers");
  try {
    const info = await stat(credentialDir);
    const ownerOnly = process.platform === "win32" || (info.mode & 0o077) === 0;
    checks.push({
      name: "credential-directory",
      status: info.isDirectory() && ownerOnly ? "pass" : "fail",
      detail:
        info.isDirectory() && ownerOnly
          ? "writer credential directory exists with owner-only access"
          : "writer credential path must be an owner-only directory",
    });
  } catch (error: unknown) {
    if (isErrorCode(error, "ENOENT")) {
      checks.push({
        name: "credential-directory",
        status: "warn",
        detail:
          "writer credential directory will be created on first credential write",
      });
    } else {
      checks.push({
        name: "credential-directory",
        status: "fail",
        detail: errorMessage(error),
      });
    }
  }

  const baseUrl = environment.DSH_TELEPORT_URL ?? "http://127.0.0.1:43127";
  const parsedUrl = safeUrl(baseUrl);
  checks.push({
    name: "service-url",
    status: parsedUrl === undefined ? "fail" : "pass",
    detail:
      parsedUrl === undefined
        ? "DSH_TELEPORT_URL must be an http(s) URL"
        : parsedUrl.origin,
  });
  checks.push({
    name: "device-id",
    status: nonBlank(environment.DSH_TELEPORT_DEVICE_ID) ? "pass" : "warn",
    detail: nonBlank(environment.DSH_TELEPORT_DEVICE_ID)
      ? "explicit device identity is configured"
      : "set DSH_TELEPORT_DEVICE_ID explicitly on every machine",
  });
  checks.push({
    name: "api-token",
    status: nonBlank(environment.DSH_TELEPORT_API_TOKEN) ? "pass" : "warn",
    detail: nonBlank(environment.DSH_TELEPORT_API_TOKEN)
      ? "service token is configured (value not displayed)"
      : "no service token is configured; this is only acceptable for loopback development",
  });

  const healthTimeoutValue = environment.DSH_TELEPORT_HEALTH_TIMEOUT_MS?.trim();
  const healthTimeoutMs =
    healthTimeoutValue === undefined || healthTimeoutValue === ""
      ? 5_000
      : Number(healthTimeoutValue);
  const healthTimeoutValid =
    Number.isSafeInteger(healthTimeoutMs) && healthTimeoutMs > 0;
  checks.push({
    name: "health-timeout",
    status: healthTimeoutValid ? "pass" : "fail",
    detail: healthTimeoutValid
      ? `Teleport startup and doctor health timeout is ${healthTimeoutMs} ms`
      : "DSH_TELEPORT_HEALTH_TIMEOUT_MS must be a positive integer",
  });

  const enableValue = environment.DSH_TELEPORT_ENABLE?.trim();
  const cutoverEnabled = enableValue === "1";
  checks.push({
    name: "cutover-mode",
    status:
      enableValue === undefined || enableValue === "" || cutoverEnabled
        ? "pass"
        : "warn",
    detail: cutoverEnabled
      ? "Teleport is selected as the Session authority"
      : enableValue === undefined || enableValue === ""
        ? "JSONL remains authoritative; Teleport cutover is not enabled"
        : "DSH_TELEPORT_ENABLE does not enable cutover; only the exact value 1 does",
  });

  if (!cutoverEnabled) {
    checks.push({
      name: "authority-health",
      status: "pass",
      detail:
        "not required while JSONL remains authoritative; enable cutover and run online doctor before switching",
    });
  } else if (!offline && parsedUrl !== undefined && healthTimeoutValid) {
    try {
      const response = await fetch(new URL("/health", parsedUrl), {
        signal: AbortSignal.timeout(healthTimeoutMs),
      });
      checks.push({
        name: "authority-health",
        status: response.status === 200 ? "pass" : "fail",
        detail:
          response.status === 200
            ? "Teleport service and PostgreSQL authority are ready"
            : `Teleport health returned HTTP ${response.status}`,
      });
    } catch (error: unknown) {
      checks.push({
        name: "authority-health",
        status: "fail",
        detail: errorMessage(error),
      });
    }
  } else if (offline) {
    checks.push({
      name: "authority-health",
      status: "warn",
      detail:
        "skipped by --offline; run online doctor before enabling or resuming Teleport",
    });
  } else if (!offline) {
    checks.push({
      name: "authority-health",
      status: "fail",
      detail:
        parsedUrl === undefined
          ? "cannot check Teleport authority while DSH_TELEPORT_URL is invalid"
          : "cannot check Teleport authority while its health timeout is invalid",
    });
  }
  return checks;
}

async function verifyMutation(
  action: Exclude<PluginLifecycleAction, "doctor">,
  profile: string,
  dshHome: string,
  expectedRevision: string | undefined,
  runDsh: (
    args: readonly string[],
    timeoutMs?: number,
  ) => Promise<CommandOutput>,
): Promise<LifecycleCheck[]> {
  const state = await readProfileState(dshHome, profile, runDsh, true);
  if (state === undefined)
    throw new Error(`profile ${profile} was not initialized`);
  if (action === "uninstall") {
    const checks: LifecycleCheck[] = [
      {
        name: "dependency-removed",
        status: state.dependency === undefined ? "pass" : "fail",
        detail:
          state.dependency === undefined
            ? "Teleport dependency was removed"
            : "Teleport dependency remains installed",
      },
      {
        name: "bundle-removed",
        status: state.bundles.includes(TELEPORT_PACKAGE) ? "fail" : "pass",
        detail: state.bundles.includes(TELEPORT_PACKAGE)
          ? "Teleport bundle remains active"
          : "Teleport bundle was removed",
      },
      {
        name: "config-removed",
        status: state.config.includes("session-persistence-teleport")
          ? "fail"
          : "pass",
        detail: state.config.includes("session-persistence-teleport")
          ? "Teleport persistence row remains composed"
          : "Teleport persistence row is absent",
      },
    ];
    assertNoFailedChecks(checks);
    return checks;
  }

  const actualRevision = revisionFromSpec(state.dependency);
  const checks: LifecycleCheck[] = [
    {
      name: "pinned-dependency",
      status: actualRevision === expectedRevision ? "pass" : "fail",
      detail:
        actualRevision === expectedRevision
          ? `installed pinned commit ${actualRevision}`
          : `expected pinned commit ${expectedRevision}, found ${actualRevision ?? "none"}`,
    },
    {
      name: "bundle-order",
      status: state.bundles.at(-1) === TELEPORT_PACKAGE ? "pass" : "fail",
      detail:
        state.bundles.at(-1) === TELEPORT_PACKAGE
          ? "Teleport is the final profile bundle"
          : "Teleport is not the final profile bundle",
    },
    ...configChecks(state.config),
  ];
  assertNoFailedChecks(checks);
  return checks;
}

function configChecks(config: string): LifecycleCheck[] {
  const teleport = configRow(config, "session-persistence-teleport");
  const jsonl = configRow(config, "session-persistence-jsonl");
  const teleportGate = "process.env.DSH_TELEPORT_ENABLE !== '1'";
  const jsonlGate = "process.env.DSH_TELEPORT_ENABLE === '1'";
  return [
    {
      name: "teleport-config",
      status:
        teleport?.includes(`name: '${TELEPORT_PACKAGE}/dsh-adapter'`) ===
          true && teleport.includes(teleportGate)
          ? "pass"
          : "fail",
      detail:
        teleport?.includes(`name: '${TELEPORT_PACKAGE}/dsh-adapter'`) ===
          true && teleport.includes(teleportGate)
          ? "Teleport adapter is composed behind the explicit cutover gate"
          : "Teleport adapter or its explicit cutover gate is missing",
    },
    {
      name: "jsonl-cutover-gate",
      status: jsonl?.includes(jsonlGate) === true ? "pass" : "fail",
      detail:
        jsonl?.includes(jsonlGate) === true
          ? "base JSONL authority remains enabled until explicit cutover"
          : "base JSONL authority is missing its explicit cutover gate",
    },
  ];
}

async function rollbackMutation(
  action: Exclude<PluginLifecycleAction, "doctor">,
  profile: string,
  previousSpec: string | undefined,
  runDsh: (
    args: readonly string[],
    timeoutMs?: number,
  ) => Promise<CommandOutput>,
): Promise<unknown | undefined> {
  try {
    if (previousSpec !== undefined) {
      await runDsh(["plugin", "--profile", profile, "add", previousSpec]);
    } else if (action === "install") {
      await runDsh([
        "plugin",
        "--profile",
        profile,
        "remove",
        TELEPORT_PACKAGE,
      ]);
    }
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

async function readProfileState(
  dshHome: string,
  profile: string,
  runDsh: (
    args: readonly string[],
    timeoutMs?: number,
  ) => Promise<CommandOutput>,
  requireManifest: boolean,
): Promise<ProfileState | undefined> {
  const manifestPath = join(dshHome, "profiles", profile, "package.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error: unknown) {
    if (!requireManifest && isErrorCode(error, "ENOENT")) return undefined;
    throw new Error(`cannot read profile ${profile} manifest`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`profile ${profile} manifest is not valid JSON`, {
      cause: error,
    });
  }
  if (!isRecord(parsed))
    throw new Error(`profile ${profile} manifest must be a JSON object`);
  const dependencies = isRecord(parsed.dependencies) ? parsed.dependencies : {};
  const dependency =
    typeof dependencies[TELEPORT_PACKAGE] === "string"
      ? dependencies[TELEPORT_PACKAGE]
      : undefined;
  const dsh = isRecord(parsed.dsh) ? parsed.dsh : {};
  const profileValue = isRecord(dsh.profile) ? dsh.profile : {};
  const bundles = Array.isArray(profileValue.bundles)
    ? profileValue.bundles.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const config = (await runDsh(["--profile", profile, "--dump-config"], 30_000))
    .stdout;
  return {
    ...(dependency === undefined ? {} : { dependency }),
    bundles,
    config,
  };
}

async function readProfileDependency(
  dshHome: string,
  profile: string,
): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(
        join(dshHome, "profiles", profile, "package.json"),
        "utf8",
      ),
    );
    if (!isRecord(value) || !isRecord(value.dependencies)) return undefined;
    const dependency = value.dependencies[TELEPORT_PACKAGE];
    return typeof dependency === "string" ? dependency : undefined;
  } catch (error: unknown) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw new Error(
      `cannot inspect profile ${profile} after plugin-manager failure`,
      { cause: error },
    );
  }
}

async function acquireLifecycleLock(
  dshHome: string,
  profile: string,
): Promise<() => Promise<void>> {
  const directory = join(dshHome, "session-teleport", "lifecycle");
  const path = join(directory, `${profile}.lock`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        );
      } finally {
        await handle.close();
      }
      return async () => rm(path, { force: true });
    } catch (error: unknown) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      const pid = await lockPid(path);
      if (pid !== undefined && processIsAlive(pid)) {
        throw new Error(
          `another plugin lifecycle operation is active for profile ${profile} (pid ${pid})`,
        );
      }
      await rm(path, { force: true });
    }
  }
  throw new Error(
    `could not acquire plugin lifecycle lock for profile ${profile}`,
  );
}

async function lockPid(path: string): Promise<number | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(value) && Number.isSafeInteger(value.pid)
      ? (value.pid as number)
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isErrorCode(error, "ESRCH");
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<CommandOutput> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: { ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString("utf8")}`.slice(-1_000_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    let forced: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      forced = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (forced !== undefined) clearTimeout(forced);
      rejectPromise(
        new Error(`cannot run ${command}: ${error.message}`, { cause: error }),
      );
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (forced !== undefined) clearTimeout(forced);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const output = redact(`${stdout}${stderr}`.trim(), environment).slice(
        -8_000,
      );
      rejectPromise(
        new Error(
          `${command} failed (${signal === null ? `exit ${code ?? "unknown"}` : `signal ${signal}`})${
            output.length === 0 ? "" : `: ${output}`
          }`,
        ),
      );
    });
  });
}

function validateTransition(
  action: PluginLifecycleAction,
  previousSpec: string | undefined,
): void {
  if (action === "install" && previousSpec !== undefined) {
    throw new Error(
      `Teleport is already installed as ${previousSpec}; use upgrade`,
    );
  }
  if (
    (action === "upgrade" || action === "uninstall") &&
    previousSpec === undefined
  ) {
    throw new Error(`Teleport is not installed; cannot ${action}`);
  }
}

function validateProfile(profile: string): void {
  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error(
      "profile must contain only letters, numbers, dot, underscore, or hyphen",
    );
  }
}

function requireRevision(revision: string | undefined): string {
  if (revision === undefined || !REVISION_PATTERN.test(revision)) {
    throw new Error(
      "--revision must be a full 40-character lowercase commit SHA",
    );
  }
  return revision;
}

function revisionFromSpec(spec: string | undefined): string | undefined {
  if (spec === undefined) return undefined;
  const match = /#([0-9a-f]{40})$/.exec(spec);
  return match?.[1];
}

function configRow(config: string, id: string): string | undefined {
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `- id: ${id}`);
  if (start < 0) return undefined;
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("- id: "),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function assertNoFailedChecks(checks: readonly LifecycleCheck[]): void {
  const failed = checks.filter((check) => check.status === "fail");
  if (failed.length > 0) {
    throw new Error(
      failed.map((check) => `${check.name}: ${check.detail}`).join("; "),
    );
  }
}

function nodeVersionSupported(version: string): boolean {
  const [majorValue, minorValue] = version.split(".");
  const major = Number(majorValue);
  const minor = Number(minorValue);
  return (major === 22 && minor >= 19) || major >= 24;
}

function resolveDshHome(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const configured = environment.DSH_HOME?.trim();
  if (configured === undefined || configured.length === 0)
    return join(homedir(), ".dsh");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return resolve(homedir(), configured.slice(2));
  }
  return resolve(configured);
}

function parseArgsPrefix(value: string | undefined): string[] {
  if (value === undefined || value.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error: unknown) {
    throw new Error("DSH_TELEPORT_DSH_ARGS_JSON must be a JSON string array", {
      cause: error,
    });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error("DSH_TELEPORT_DSH_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

function redact(
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  let output = value;
  for (const [name, secret] of Object.entries(environment)) {
    if (
      !/(TOKEN|PASSWORD|SECRET|CREDENTIAL|DATABASE_URL)/i.test(name) ||
      secret === undefined ||
      secret.length < 4
    ) {
      continue;
    }
    output = output.split(secret).join("[redacted]");
  }
  return output;
}

function safeUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function nonBlank(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
