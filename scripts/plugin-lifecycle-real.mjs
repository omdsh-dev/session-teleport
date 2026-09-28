import { peerSpecs as compatibilityPeers } from "./compatibility.mjs";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runPluginLifecycle, TELEPORT_PACKAGE } from "../dist/plugin-lifecycle.js";

const dshBin = requiredPath("DSH_TELEPORT_TEST_DSH_BIN");
const fromRevision = requiredRevision("DSH_TELEPORT_TEST_FROM_REVISION");
const toRevision = requiredRevision("DSH_TELEPORT_TEST_TO_REVISION");
if (fromRevision === toRevision) throw new Error("lifecycle test revisions must differ");
const peerSpecs = compatibilityPeers();

const root = await mkdtemp(join(tmpdir(), "session-teleport-real-lifecycle-"));
const dshHome = join(root, "dsh-home");
const profile = "teleport-lifecycle-real";
const credentialDir = join(dshHome, "session-teleport", "writers");
const sentinel = join(credentialDir, "preserved-by-uninstall");
const environment = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_TELEPORT_ENABLE: "1",
  DSH_TELEPORT_URL: "http://127.0.0.1:43127",
  DSH_TELEPORT_DEVICE_ID: "lifecycle-real-device",
};
const common = {
  profile,
  environment,
  dshCommand: process.execPath,
  dshArgsPrefix: [dshBin],
};

try {
  await mkdir(dshHome, { recursive: true, mode: 0o700 });
  if (peerSpecs !== undefined) await installPeers(peerSpecs);
  const install = await runPluginLifecycle({
    ...common,
    action: "install",
    revision: fromRevision,
    apply: true,
    profileStopped: true,
    cutoverSafe: true,
  });
  assertAllPass(install.checks, "install");

  await mkdir(credentialDir, { recursive: true, mode: 0o700 });
  await writeFile(sentinel, "preserve", { mode: 0o600 });
  const beforeDoctor = await runPluginLifecycle({ ...common, action: "doctor", offline: true });
  assertNoFailures(beforeDoctor.checks, "pre-upgrade doctor");

  const upgrade = await runPluginLifecycle({
    ...common,
    action: "upgrade",
    revision: toRevision,
    apply: true,
    profileStopped: true,
  });
  assertAllPass(upgrade.checks, "upgrade");
  const manifest = await profileManifest(dshHome, profile);
  assert(
    manifest.dependencies?.[TELEPORT_PACKAGE]?.endsWith(`#${toRevision}`) === true,
    "profile dependency did not advance to the target revision",
  );
  const adapter = await import(
    pathToFileURL(
      join(
        dshHome,
        "profiles",
        profile,
        "node_modules/@mattheliu/session-teleport/dist/dsh-adapter.js",
      ),
    ).href
  );
  assert(adapter.default?.name === "SessionPersistenceTeleport", "upgraded adapter is not loadable");

  const afterDoctor = await runPluginLifecycle({ ...common, action: "doctor", offline: true });
  assertNoFailures(afterDoctor.checks, "post-upgrade doctor");
  const uninstall = await runPluginLifecycle({
    ...common,
    action: "uninstall",
    apply: true,
    profileStopped: true,
    cutoverSafe: true,
  });
  assertAllPass(uninstall.checks, "uninstall");
  assert((await readFile(sentinel, "utf8")) === "preserve", "uninstall deleted local credentials");
  assert(((await stat(sentinel)).mode & 0o777) === 0o600, "credential sentinel mode changed");

  process.stdout.write(
    [
      "real lifecycle: pinned repository install passed",
      "real lifecycle: offline doctor passed",
      "real lifecycle: pinned upgrade passed",
      "real lifecycle: uninstall removed the bundle",
      "real lifecycle: local credentials were preserved",
    ].join("\n") + "\n",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

function requiredPath(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return resolve(value);
}

function requiredRevision(name) {
  const value = process.env[name];
  if (value === undefined || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${name} must be a full lowercase commit SHA`);
  }
  return value;
}

async function profileManifest(home, profile) {
  return JSON.parse(await readFile(join(home, "profiles", profile, "package.json"), "utf8"));
}

async function installPeers(specs) {
  runDsh(["plugin", "--profile", profile, "install", "--ignore-scripts"]);
  const manifestPath = join(dshHome, "profiles", profile, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies = {
    ...manifest.dependencies,
    ...specs,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  runDsh(["plugin", "--profile", profile, "install", "--ignore-scripts"]);
}

function runDsh(args) {
  const result = spawnSync(process.execPath, [dshBin, ...args], {
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`DSH failed with ${result.status}\n${result.stdout}${result.stderr}`);
  }
}

function assertAllPass(checks, stage) {
  const failed = checks.filter((check) => check.status !== "pass");
  assert(failed.length === 0, `${stage} checks were not all pass: ${JSON.stringify(failed)}`);
}

function assertNoFailures(checks, stage) {
  const failed = checks.filter((check) => check.status === "fail");
  assert(failed.length === 0, `${stage} failed: ${JSON.stringify(failed)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
