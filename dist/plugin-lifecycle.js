import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rm,
  stat
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const TELEPORT_PACKAGE = "@mattheliu/session-teleport";
const TELEPORT_REPOSITORY = "github:omdsh-dev/session-teleport";
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
async function runPluginLifecycle(options) {
  validateProfile(options.profile);
  const environment = { ...process.env, ...options.environment };
  const dshHome = resolveDshHome(environment);
  const command = options.dshCommand ?? environment.DSH_TELEPORT_DSH_COMMAND ?? "dsh";
  const prefix = options.dshArgsPrefix ?? parseArgsPrefix(environment.DSH_TELEPORT_DSH_ARGS_JSON);
  const runDsh = (args, timeoutMs = 3e5) => runCommand(command, [...prefix, ...args], environment, timeoutMs);
  if (options.action === "doctor") {
    const checks = await doctor(options.profile, dshHome, environment, runDsh, options.offline === true);
    return {
      action: "doctor",
      profile: options.profile,
      applied: false,
      restartRequired: false,
      checks,
      notes: ["doctor never changes the profile, credentials, or database"]
    };
  }
  const revision = options.action === "uninstall" ? void 0 : requireRevision(options.revision);
  const desiredSpec = revision === void 0 ? void 0 : `${TELEPORT_REPOSITORY}#${revision}`;
  const before = await readProfileState(dshHome, options.profile, runDsh, false);
  const previousSpec = before?.dependency;
  validateTransition(options.action, previousSpec);
  const plan = lifecyclePlan(options.action, options.profile, previousSpec, desiredSpec);
  if (options.apply !== true) {
    return {
      action: options.action,
      profile: options.profile,
      applied: false,
      restartRequired: true,
      ...previousSpec === void 0 ? {} : { previousSpec },
      ...desiredSpec === void 0 ? {} : { currentSpec: desiredSpec },
      checks: [],
      notes: plan
    };
  }
  if (options.profileStopped !== true) {
    throw new Error("refusing to mutate a running profile; pass --profile-stopped after stopping it");
  }
  if ((options.action === "install" || options.action === "uninstall") && options.cutoverSafe !== true) {
    throw new Error(
      "this changes the Session authority; pass --cutover-safe only after migration/cutover is verified"
    );
  }
  const releaseLock = await acquireLifecycleLock(dshHome, options.profile);
  try {
    try {
      if (options.action === "install" || options.action === "upgrade") {
        await runDsh(["plugin", "--profile", options.profile, "add", desiredSpec]);
      } else {
        await runDsh(["plugin", "--profile", options.profile, "remove", TELEPORT_PACKAGE]);
      }
    } catch (mutationError) {
      const changedDependency = await readProfileDependency(dshHome, options.profile) !== previousSpec;
      const rollbackError = changedDependency ? await rollbackMutation(options.action, options.profile, previousSpec, runDsh) : void 0;
      if (rollbackError === void 0) {
        throw new Error(
          changedDependency ? `plugin manager failed and the previous dependency was restored: ${errorMessage(mutationError)}` : `plugin manager failed before changing the profile dependency: ${errorMessage(mutationError)}`,
          { cause: mutationError }
        );
      }
      throw new Error(
        `plugin manager failed; automatic rollback also failed (${errorMessage(rollbackError)}): ${errorMessage(mutationError)}`,
        { cause: mutationError }
      );
    }
    let checks;
    try {
      checks = await verifyMutation(
        options.action,
        options.profile,
        dshHome,
        revision,
        runDsh
      );
    } catch (verificationError) {
      const rollbackError = await rollbackMutation(
        options.action,
        options.profile,
        previousSpec,
        runDsh
      );
      const verificationMessage = errorMessage(verificationError);
      if (rollbackError === void 0) {
        throw new Error(
          `plugin verification failed and the previous profile dependency was restored: ${verificationMessage}`,
          { cause: verificationError }
        );
      }
      throw new Error(
        `plugin verification failed; automatic rollback also failed (${errorMessage(rollbackError)}): ${verificationMessage}`,
        { cause: verificationError }
      );
    }
    const current = await readProfileState(dshHome, options.profile, runDsh, false);
    return {
      action: options.action,
      profile: options.profile,
      applied: true,
      restartRequired: true,
      ...previousSpec === void 0 ? {} : { previousSpec },
      ...current?.dependency === void 0 ? {} : { currentSpec: current.dependency },
      checks,
      notes: [
        ...plan,
        "writer credentials, import receipts, and PostgreSQL data were left unchanged",
        "run doctor after restarting the profile before resuming a Session"
      ]
    };
  } finally {
    await releaseLock();
  }
}
function lifecyclePlan(action, profile, previousSpec, desiredSpec) {
  if (action === "install") {
    return [
      `install ${desiredSpec} into profile ${profile}`,
      "replace that profile's JSONL authority with Teleport after a controlled restart",
      "do not continue an old Session until its import and cutover have been verified"
    ];
  }
  if (action === "upgrade") {
    return [
      `upgrade profile ${profile} from ${previousSpec} to ${desiredSpec}`,
      "restore the previous pinned dependency automatically if structural verification fails",
      "keep the PostgreSQL authority and local writer credentials unchanged"
    ];
  }
  return [
    `remove ${TELEPORT_PACKAGE} from profile ${profile}`,
    "remove only the profile layer; keep PostgreSQL data and local writer credentials",
    "do not resume a Teleport Session on another backend unless an explicit reverse cutover was verified"
  ];
}
async function doctor(profile, dshHome, environment, runDsh, offline) {
  const checks = [];
  checks.push({
    name: "node",
    status: nodeVersionSupported(process.versions.node) ? "pass" : "fail",
    detail: `Node.js ${process.versions.node}; requires 22.19+ or 24+`
  });
  try {
    const version = (await runDsh(["--version"], 3e4)).stdout.trim();
    checks.push({ name: "dsh", status: "pass", detail: version || "DSH command is available" });
  } catch (error) {
    checks.push({ name: "dsh", status: "fail", detail: errorMessage(error) });
  }
  let state;
  try {
    state = await readProfileState(dshHome, profile, runDsh, true);
  } catch (error) {
    checks.push({ name: "profile", status: "fail", detail: errorMessage(error) });
  }
  if (state !== void 0) {
    const revision = revisionFromSpec(state.dependency);
    checks.push({
      name: "pinned-dependency",
      status: revision === void 0 ? "fail" : "pass",
      detail: revision === void 0 ? "Teleport dependency is missing or is not pinned to a full commit SHA" : `Teleport is pinned to ${revision}`
    });
    checks.push({
      name: "bundle-order",
      status: state.bundles.at(-1) === TELEPORT_PACKAGE ? "pass" : "fail",
      detail: state.bundles.at(-1) === TELEPORT_PACKAGE ? "Teleport is the final profile bundle" : "Teleport must be the final profile bundle"
    });
    checks.push(...configChecks(state.config));
  }
  const credentialDir = environment.DSH_TELEPORT_CREDENTIAL_DIR ?? join(dshHome, "session-teleport", "writers");
  try {
    const info = await stat(credentialDir);
    const ownerOnly = process.platform === "win32" || (info.mode & 63) === 0;
    checks.push({
      name: "credential-directory",
      status: info.isDirectory() && ownerOnly ? "pass" : "fail",
      detail: info.isDirectory() && ownerOnly ? "writer credential directory exists with owner-only access" : "writer credential path must be an owner-only directory"
    });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      checks.push({
        name: "credential-directory",
        status: "warn",
        detail: "writer credential directory will be created on first credential write"
      });
    } else {
      checks.push({ name: "credential-directory", status: "fail", detail: errorMessage(error) });
    }
  }
  const baseUrl = environment.DSH_TELEPORT_URL ?? "http://127.0.0.1:43127";
  const parsedUrl = safeUrl(baseUrl);
  checks.push({
    name: "service-url",
    status: parsedUrl === void 0 ? "fail" : "pass",
    detail: parsedUrl === void 0 ? "DSH_TELEPORT_URL must be an http(s) URL" : parsedUrl.origin
  });
  checks.push({
    name: "device-id",
    status: nonBlank(environment.DSH_TELEPORT_DEVICE_ID) ? "pass" : "warn",
    detail: nonBlank(environment.DSH_TELEPORT_DEVICE_ID) ? "explicit device identity is configured" : "set DSH_TELEPORT_DEVICE_ID explicitly on every machine"
  });
  checks.push({
    name: "api-token",
    status: nonBlank(environment.DSH_TELEPORT_API_TOKEN) ? "pass" : "warn",
    detail: nonBlank(environment.DSH_TELEPORT_API_TOKEN) ? "service token is configured (value not displayed)" : "no service token is configured; this is only acceptable for loopback development"
  });
  if (!offline && parsedUrl !== void 0) {
    try {
      const response = await fetch(new URL("/health", parsedUrl), {
        signal: AbortSignal.timeout(5e3)
      });
      checks.push({
        name: "authority-health",
        status: response.status === 200 ? "pass" : "fail",
        detail: response.status === 200 ? "Teleport service and PostgreSQL authority are ready" : `Teleport health returned HTTP ${response.status}`
      });
    } catch (error) {
      checks.push({ name: "authority-health", status: "fail", detail: errorMessage(error) });
    }
  } else if (offline) {
    checks.push({
      name: "authority-health",
      status: "warn",
      detail: "skipped by --offline; run online doctor before resuming work"
    });
  }
  return checks;
}
async function verifyMutation(action, profile, dshHome, expectedRevision, runDsh) {
  const state = await readProfileState(dshHome, profile, runDsh, true);
  if (state === void 0) throw new Error(`profile ${profile} was not initialized`);
  if (action === "uninstall") {
    const checks2 = [
      {
        name: "dependency-removed",
        status: state.dependency === void 0 ? "pass" : "fail",
        detail: state.dependency === void 0 ? "Teleport dependency was removed" : "Teleport dependency remains installed"
      },
      {
        name: "bundle-removed",
        status: state.bundles.includes(TELEPORT_PACKAGE) ? "fail" : "pass",
        detail: state.bundles.includes(TELEPORT_PACKAGE) ? "Teleport bundle remains active" : "Teleport bundle was removed"
      },
      {
        name: "config-removed",
        status: state.config.includes("session-persistence-teleport") ? "fail" : "pass",
        detail: state.config.includes("session-persistence-teleport") ? "Teleport persistence row remains composed" : "Teleport persistence row is absent"
      }
    ];
    assertNoFailedChecks(checks2);
    return checks2;
  }
  const actualRevision = revisionFromSpec(state.dependency);
  const checks = [
    {
      name: "pinned-dependency",
      status: actualRevision === expectedRevision ? "pass" : "fail",
      detail: actualRevision === expectedRevision ? `installed pinned commit ${actualRevision}` : `expected pinned commit ${expectedRevision}, found ${actualRevision ?? "none"}`
    },
    {
      name: "bundle-order",
      status: state.bundles.at(-1) === TELEPORT_PACKAGE ? "pass" : "fail",
      detail: state.bundles.at(-1) === TELEPORT_PACKAGE ? "Teleport is the final profile bundle" : "Teleport is not the final profile bundle"
    },
    ...configChecks(state.config)
  ];
  assertNoFailedChecks(checks);
  return checks;
}
function configChecks(config) {
  const teleport = configRow(config, "session-persistence-teleport");
  const jsonl = configRow(config, "session-persistence-jsonl");
  return [
    {
      name: "teleport-config",
      status: teleport?.includes(`name: '${TELEPORT_PACKAGE}/dsh-adapter'`) === true ? "pass" : "fail",
      detail: teleport?.includes(`name: '${TELEPORT_PACKAGE}/dsh-adapter'`) === true ? "Teleport persistence adapter is composed" : "Teleport persistence adapter is missing from the effective config"
    },
    {
      name: "jsonl-disabled",
      status: jsonl?.includes("disabled: true") === true ? "pass" : "fail",
      detail: jsonl?.includes("disabled: true") === true ? "base JSONL authority is disabled" : "base JSONL authority is still enabled"
    }
  ];
}
async function rollbackMutation(action, profile, previousSpec, runDsh) {
  try {
    if (previousSpec !== void 0) {
      await runDsh(["plugin", "--profile", profile, "add", previousSpec]);
    } else if (action === "install") {
      await runDsh(["plugin", "--profile", profile, "remove", TELEPORT_PACKAGE]);
    }
    return void 0;
  } catch (error) {
    return error;
  }
}
async function readProfileState(dshHome, profile, runDsh, requireManifest) {
  const manifestPath = join(dshHome, "profiles", profile, "package.json");
  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (!requireManifest && isErrorCode(error, "ENOENT")) return void 0;
    throw new Error(`cannot read profile ${profile} manifest`, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`profile ${profile} manifest is not valid JSON`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`profile ${profile} manifest must be a JSON object`);
  const dependencies = isRecord(parsed.dependencies) ? parsed.dependencies : {};
  const dependency = typeof dependencies[TELEPORT_PACKAGE] === "string" ? dependencies[TELEPORT_PACKAGE] : void 0;
  const dsh = isRecord(parsed.dsh) ? parsed.dsh : {};
  const profileValue = isRecord(dsh.profile) ? dsh.profile : {};
  const bundles = Array.isArray(profileValue.bundles) ? profileValue.bundles.filter((value) => typeof value === "string") : [];
  const config = (await runDsh(["--profile", profile, "--dump-config"], 3e4)).stdout;
  return { ...dependency === void 0 ? {} : { dependency }, bundles, config };
}
async function readProfileDependency(dshHome, profile) {
  try {
    const value = JSON.parse(
      await readFile(join(dshHome, "profiles", profile, "package.json"), "utf8")
    );
    if (!isRecord(value) || !isRecord(value.dependencies)) return void 0;
    const dependency = value.dependencies[TELEPORT_PACKAGE];
    return typeof dependency === "string" ? dependency : void 0;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return void 0;
    throw new Error(`cannot inspect profile ${profile} after plugin-manager failure`, { cause: error });
  }
}
async function acquireLifecycleLock(dshHome, profile) {
  const directory = join(dshHome, "session-teleport", "lifecycle");
  const path = join(directory, `${profile}.lock`);
  await mkdir(directory, { recursive: true, mode: 448 });
  await chmod(directory, 448);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 384);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: (/* @__PURE__ */ new Date()).toISOString() })}
`);
      } finally {
        await handle.close();
      }
      return async () => rm(path, { force: true });
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      const pid = await lockPid(path);
      if (pid !== void 0 && processIsAlive(pid)) {
        throw new Error(`another plugin lifecycle operation is active for profile ${profile} (pid ${pid})`);
      }
      await rm(path, { force: true });
    }
  }
  throw new Error(`could not acquire plugin lifecycle lock for profile ${profile}`);
}
async function lockPid(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return isRecord(value) && Number.isSafeInteger(value.pid) ? value.pid : void 0;
  } catch {
    return void 0;
  }
}
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, "ESRCH");
  }
}
async function runCommand(command, args, environment, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: { ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${chunk.toString("utf8")}`.slice(-1e6);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    let forced;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      forced = setTimeout(() => child.kill("SIGKILL"), 5e3);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (forced !== void 0) clearTimeout(forced);
      rejectPromise(new Error(`cannot run ${command}: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (forced !== void 0) clearTimeout(forced);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const output = redact(`${stdout}${stderr}`.trim(), environment).slice(-8e3);
      rejectPromise(
        new Error(
          `${command} failed (${signal === null ? `exit ${code ?? "unknown"}` : `signal ${signal}`})${output.length === 0 ? "" : `: ${output}`}`
        )
      );
    });
  });
}
function validateTransition(action, previousSpec) {
  if (action === "install" && previousSpec !== void 0) {
    throw new Error(`Teleport is already installed as ${previousSpec}; use upgrade`);
  }
  if ((action === "upgrade" || action === "uninstall") && previousSpec === void 0) {
    throw new Error(`Teleport is not installed; cannot ${action}`);
  }
}
function validateProfile(profile) {
  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error("profile must contain only letters, numbers, dot, underscore, or hyphen");
  }
}
function requireRevision(revision) {
  if (revision === void 0 || !REVISION_PATTERN.test(revision)) {
    throw new Error("--revision must be a full 40-character lowercase commit SHA");
  }
  return revision;
}
function revisionFromSpec(spec) {
  if (spec === void 0) return void 0;
  const match = /#([0-9a-f]{40})$/.exec(spec);
  return match?.[1];
}
function configRow(config, id) {
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `- id: ${id}`);
  if (start < 0) return void 0;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("- id: "));
  return lines.slice(start, end < 0 ? void 0 : end).join("\n");
}
function assertNoFailedChecks(checks) {
  const failed = checks.filter((check) => check.status === "fail");
  if (failed.length > 0) {
    throw new Error(failed.map((check) => `${check.name}: ${check.detail}`).join("; "));
  }
}
function nodeVersionSupported(version) {
  const [majorValue, minorValue] = version.split(".");
  const major = Number(majorValue);
  const minor = Number(minorValue);
  return major === 22 && minor >= 19 || major >= 24;
}
function resolveDshHome(environment) {
  const configured = environment.DSH_HOME?.trim();
  if (configured === void 0 || configured.length === 0) return join(homedir(), ".dsh");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return resolve(homedir(), configured.slice(2));
  }
  return resolve(configured);
}
function parseArgsPrefix(value) {
  if (value === void 0 || value.length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("DSH_TELEPORT_DSH_ARGS_JSON must be a JSON string array", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("DSH_TELEPORT_DSH_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}
function redact(value, environment) {
  let output = value;
  for (const [name, secret] of Object.entries(environment)) {
    if (!/(TOKEN|PASSWORD|SECRET|CREDENTIAL|DATABASE_URL)/i.test(name) || secret === void 0 || secret.length < 4) {
      continue;
    }
    output = output.split(secret).join("[redacted]");
  }
  return output;
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : void 0;
  } catch {
    return void 0;
  }
}
function nonBlank(value) {
  return value !== void 0 && value.trim().length > 0;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isErrorCode(error, code) {
  return error instanceof Error && error.code === code;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
export {
  TELEPORT_PACKAGE,
  lifecyclePlan,
  runPluginLifecycle
};
//# sourceMappingURL=plugin-lifecycle.js.map
