import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPluginLifecycle } from "../src/plugin-lifecycle.js";

const REVISION_ONE = "1".repeat(40);
const REVISION_TWO = "2".repeat(40);
const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("plugin lifecycle", () => {
  it("plans without mutation, then installs, diagnoses, and uninstalls without deleting credentials", async () => {
    const fixture = await lifecycleFixture();
    const plan = await runPluginLifecycle({
      ...fixture.options,
      action: "install",
      revision: REVISION_ONE,
    });
    expect(plan).toMatchObject({ applied: false, restartRequired: true });
    await expect(readManifest(fixture.home, "web")).resolves.toBeUndefined();

    const installed = await runPluginLifecycle({
      ...fixture.options,
      action: "install",
      revision: REVISION_ONE,
      apply: true,
      profileStopped: true,
      cutoverSafe: true,
    });
    expect(installed.checks.every((check) => check.status === "pass")).toBe(true);
    expect((await readManifest(fixture.home, "web"))?.dependencies).toEqual({
      "@mattheliu/session-teleport":
        `github:omdsh-dev/session-teleport#${REVISION_ONE}`,
    });

    const credentialDir = join(fixture.home, "session-teleport", "writers");
    await mkdir(credentialDir, { recursive: true, mode: 0o700 });
    await chmod(credentialDir, 0o700);
    const credential = join(credentialDir, "writer.json");
    await writeFile(credential, "credential fixture", { mode: 0o600 });
    const diagnosed = await runPluginLifecycle({
      ...fixture.options,
      action: "doctor",
      offline: true,
      environment: {
        ...fixture.options.environment,
        DSH_TELEPORT_URL: "https://teleport.example.invalid",
        DSH_TELEPORT_API_TOKEN: "fixture-token",
        DSH_TELEPORT_DEVICE_ID: "device-a",
      },
    });
    expect(diagnosed.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(diagnosed.checks).toContainEqual(
      expect.objectContaining({ name: "authority-health", status: "warn" }),
    );

    const uninstallPlan = await runPluginLifecycle({
      ...fixture.options,
      action: "uninstall",
    });
    expect(uninstallPlan.applied).toBe(false);
    expect((await readManifest(fixture.home, "web"))?.dependencies).toBeDefined();
    await runPluginLifecycle({
      ...fixture.options,
      action: "uninstall",
      apply: true,
      profileStopped: true,
      cutoverSafe: true,
    });
    expect((await readManifest(fixture.home, "web"))?.dependencies).toEqual({});
    await expect(readFile(credential, "utf8")).resolves.toBe("credential fixture");
    expect((await stat(credential)).mode & 0o777).toBe(0o600);
  });

  it("upgrades a pinned commit and restores the old one when verification fails", async () => {
    const fixture = await lifecycleFixture();
    await install(fixture, REVISION_ONE);
    const upgraded = await runPluginLifecycle({
      ...fixture.options,
      action: "upgrade",
      revision: REVISION_TWO,
      apply: true,
      profileStopped: true,
    });
    expect(upgraded.currentSpec).toContain(REVISION_TWO);

    await expect(
      runPluginLifecycle({
        ...fixture.options,
        action: "upgrade",
        revision: REVISION_ONE,
        apply: true,
        profileStopped: true,
        environment: {
          ...fixture.options.environment,
          FAKE_DSH_BROKEN_REVISION: REVISION_ONE,
        },
      }),
    ).rejects.toThrow("previous profile dependency was restored");
    expect(
      (await readManifest(fixture.home, "web"))?.dependencies?.[
        "@mattheliu/session-teleport"
      ],
    ).toContain(REVISION_TWO);
  });

  it("requires restart and cutover acknowledgements at the mutation boundary", async () => {
    const fixture = await lifecycleFixture();
    await expect(
      runPluginLifecycle({
        ...fixture.options,
        action: "install",
        revision: REVISION_ONE,
        apply: true,
      }),
    ).rejects.toThrow("profile-stopped");
    await expect(
      runPluginLifecycle({
        ...fixture.options,
        action: "install",
        revision: REVISION_ONE,
        apply: true,
        profileStopped: true,
      }),
    ).rejects.toThrow("cutover-safe");
    await expect(
      runPluginLifecycle({
        ...fixture.options,
        action: "install",
        revision: "main",
      }),
    ).rejects.toThrow("full 40-character");
  });

  it("redacts inherited secrets from plugin-manager failures", async () => {
    const fixture = await lifecycleFixture();
    const secret = "fixture-secret-that-must-not-escape";
    await expect(
      runPluginLifecycle({
        ...fixture.options,
        action: "install",
        revision: REVISION_ONE,
        apply: true,
        profileStopped: true,
        cutoverSafe: true,
        environment: {
          ...fixture.options.environment,
          PACKAGE_MANAGER_TOKEN: secret,
          FAKE_DSH_FAIL_ADD: "1",
        },
      }),
    ).rejects.not.toThrow(secret);
  });
});

interface Fixture {
  home: string;
  options: {
    profile: string;
    dshCommand: string;
    dshArgsPrefix: string[];
    environment: Record<string, string>;
  };
}

async function lifecycleFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "session-teleport-lifecycle-"));
  temporaryRoots.push(root);
  const home = join(root, "dsh-home");
  const script = join(root, "fake-dsh.mjs");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(script, fakeDsh(), { mode: 0o700 });
  return {
    home,
    options: {
      profile: "web",
      dshCommand: process.execPath,
      dshArgsPrefix: [script],
      environment: { DSH_HOME: home },
    },
  };
}

async function install(fixture: Fixture, revision: string): Promise<void> {
  await runPluginLifecycle({
    ...fixture.options,
    action: "install",
    revision,
    apply: true,
    profileStopped: true,
    cutoverSafe: true,
  });
}

async function readManifest(
  home: string,
  profile: string,
): Promise<{ dependencies?: Record<string, string> } | undefined> {
  try {
    return JSON.parse(await readFile(join(home, "profiles", profile, "package.json"), "utf8"));
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function fakeDsh(): string {
  return `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("dsh-fixture 0.0.1\\n");
  process.exit(0);
}
const profileIndex = args.indexOf("--profile");
const profile = args[profileIndex + 1];
const profileDir = join(process.env.DSH_HOME, "profiles", profile);
const manifestPath = join(profileDir, "package.json");
const readManifest = async () => {
  try { return JSON.parse(await readFile(manifestPath, "utf8")); }
  catch { return { dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } }; }
};
if (args[0] === "plugin") {
  const verb = args[profileIndex + 2];
  const value = args[profileIndex + 3];
  if (verb === "add" && process.env.FAKE_DSH_FAIL_ADD === "1") {
    process.stderr.write("install failed token=" + process.env.PACKAGE_MANAGER_TOKEN + "\\n");
    process.exit(9);
  }
  await mkdir(profileDir, { recursive: true });
  const manifest = await readManifest();
  if (verb === "add") {
    manifest.dependencies["@mattheliu/session-teleport"] = value;
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((item) => item !== "@mattheliu/session-teleport");
    manifest.dsh.profile.bundles.push("@mattheliu/session-teleport");
  } else if (verb === "remove") {
    delete manifest.dependencies["@mattheliu/session-teleport"];
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((item) => item !== "@mattheliu/session-teleport");
  } else {
    process.exit(2);
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
  process.exit(0);
}
if (args.includes("--dump-config")) {
  const manifest = await readManifest();
  const spec = manifest.dependencies["@mattheliu/session-teleport"];
  const broken = spec?.endsWith("#" + process.env.FAKE_DSH_BROKEN_REVISION);
  if (spec === undefined) {
    process.stdout.write("- id: session-persistence-jsonl\\n  name: '@deepseek-ai/dsh-session-persistence-jsonl'\\n");
  } else if (broken) {
    process.stdout.write("- id: session-persistence-jsonl\\n  name: '@deepseek-ai/dsh-session-persistence-jsonl'\\n");
  } else {
    process.stdout.write("- id: session-persistence-jsonl\\n  name: '@deepseek-ai/dsh-session-persistence-jsonl'\\n  disabled: true\\n- id: session-persistence-teleport\\n  name: '@mattheliu/session-teleport/dsh-adapter'\\n");
  }
  process.exit(0);
}
process.exit(2);
`;
}
