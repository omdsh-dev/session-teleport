import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const projectPackage = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
const dshBin = requiredPath("DSH_TELEPORT_TEST_DSH_BIN");
if (!existsSync(dshBin)) throw new Error("DSH_TELEPORT_TEST_DSH_BIN does not exist");
const peerSpecs = requiredPeerSpecs();

const root = await mkdtemp(join(tmpdir(), "session-teleport-local-profile-"));
const packDir = join(root, "package");
const dshHome = join(root, "dsh-home");
const profile = "teleport-profile-local";
const environment = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_TELEPORT_URL: "http://127.0.0.1:43127",
  DSH_TELEPORT_DEVICE_ID: "profile-local-device",
};

try {
  await Promise.all([
    mkdir(packDir, { recursive: true, mode: 0o700 }),
    mkdir(dshHome, { recursive: true, mode: 0o700 }),
  ]);
  // Initialize a real profile, then satisfy the required runtime peers with
  // caller-provided package-manager specs. The specs may name supported
  // package versions or local paths and only affect the disposable DSH_HOME.
  runDsh(["plugin", "--profile", profile, "install", "--ignore-scripts"]);
  const profileDir = join(dshHome, "profiles", profile);
  const initial = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
  initial.dependencies = {
    ...initial.dependencies,
    ...peerSpecs,
  };
  await writeFile(join(profileDir, "package.json"), `${JSON.stringify(initial, null, 2)}\n`);
  runDsh(["plugin", "--profile", profile, "install", "--ignore-scripts"]);

  run("pnpm", ["pack", "--pack-destination", packDir], projectDir, environment);
  const tarballs = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
  assert(tarballs.length === 1, `expected one tarball, found ${tarballs.length}`);
  const tarball = join(packDir, tarballs[0]);

  runDsh(["plugin", "--profile", profile, "add", tarball]);
  const manifest = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
  assert(manifest.dependencies?.["@mattheliu/session-teleport"] !== undefined, "dependency missing");
  assert(
    manifest.dsh?.profile?.bundles?.at(-1) === "@mattheliu/session-teleport",
    "Teleport is not the final bundle",
  );
  const installedPackage = JSON.parse(
    await readFile(
      join(profileDir, "node_modules/@mattheliu/session-teleport/package.json"),
      "utf8",
    ),
  );
  assert(
    installedPackage.version === projectPackage.version,
    `installed package version ${installedPackage.version} differs from ${projectPackage.version}`,
  );
  for (const binary of [
    "dsh-teleport-server",
    "dsh-teleport-device",
    "dsh-teleport-import",
    "dsh-teleport-plugin",
  ]) {
    assert(existsSync(join(profileDir, "node_modules/.bin", binary)), `missing binary ${binary}`);
  }
  const adapter = await import(
    pathToFileURL(
      join(profileDir, "node_modules/@mattheliu/session-teleport/dist/dsh-adapter.js"),
    ).href
  );
  assert(adapter.default?.name === "SessionPersistenceTeleport", "adapter is not loadable");
  const safeDefault = runDsh(["--profile", profile, "--dump-config"]).stdout;
  assertRow(safeDefault, "session-persistence-jsonl", false);
  assertRowExpression(
    safeDefault,
    "session-persistence-jsonl",
    "process.env.DSH_TELEPORT_ENABLE === '1'",
  );
  assertRowExpression(
    safeDefault,
    "session-persistence-teleport",
    "process.env.DSH_TELEPORT_ENABLE !== '1'",
  );

  runDsh(["plugin", "--profile", profile, "remove", "@mattheliu/session-teleport"]);
  const removed = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
  assert(
    removed.dependencies?.["@mattheliu/session-teleport"] === undefined,
    "dependency survived removal",
  );
  const restored = runDsh(["--profile", profile, "--dump-config"]).stdout;
  assert(!restored.includes("session-persistence-teleport"), "Teleport row survived removal");
  assertRow(restored, "session-persistence-jsonl", false);
  process.stdout.write(
    [
      "local profile: package install passed",
      "local profile: safe default and explicit cutover composition passed",
      "local profile: packaged binaries and adapter passed",
      "local profile: uninstall restored JSONL composition",
    ].join("\n") + "\n",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

function runDsh(args, overrides = {}) {
  return run(process.execPath, [dshBin, ...args], projectDir, {
    ...environment,
    ...overrides,
  });
}

function requiredPath(name) {
  const value = requiredValue(name);
  return resolve(value);
}

function requiredPeerSpecs() {
  return {
    "@deepseek-ai/dsh-session": requiredValue("DSH_TELEPORT_TEST_SESSION_SPEC"),
    "@deepseek-ai/dsh-session-persistence": requiredValue(
      "DSH_TELEPORT_TEST_SESSION_PERSISTENCE_SPEC",
    ),
    "@deepseek-ai/dsh-session-persistence-jsonl": requiredValue(
      "DSH_TELEPORT_TEST_JSONL_SPEC",
    ),
    "@deepseek-ai/cordis": requiredValue("DSH_TELEPORT_TEST_CORDIS_SPEC"),
    "@deepseek-ai/cordis-plugin-include": "1.0.6-rc.4",
    "@deepseek-ai/cordis-plugin-loader": "1.0.2-rc.4",
    "@deepseek-ai/dsh-attachment": "0.0.1-rc.5",
    "@deepseek-ai/dsh-brand": "0.0.1-rc.5",
    "@deepseek-ai/dsh-invariants": "0.0.1-rc.5",
    "@deepseek-ai/dsh-llm": "0.0.1-rc.5",
    "@deepseek-ai/dsh-scope": "0.0.1-rc.5",
    "@deepseek-ai/dsh-timeout": "0.0.1-rc.5",
    "@deepseek-ai/dsh-typert-protocol": "0.0.1-rc.5",
  };
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with ${result.status}\n${result.stdout}${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function assertRow(config, id, disabled) {
  const row = configRow(config, id);
  assert(row.includes("disabled: true") === disabled, `${id} disabled state is wrong`);
}

function assertRowExpression(config, id, expression) {
  const row = configRow(config, id);
  assert(row.includes(expression), `${id} does not contain the expected enablement expression`);
}

function configRow(config, id) {
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `- id: ${id}`);
  assert(start >= 0, `missing config row ${id}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("- id: "));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
