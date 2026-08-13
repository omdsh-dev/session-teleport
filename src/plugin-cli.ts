#!/usr/bin/env node
import {
  runPluginLifecycle,
  type PluginLifecycleAction,
  type PluginLifecycleOptions,
} from "./plugin-lifecycle.js";

try {
  const options = parseArguments(process.argv.slice(2));
  const result = await runPluginLifecycle(options);
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    render(result);
  }
  if (result.checks.some((check) => check.status === "fail")) process.exitCode = 1;
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

interface ParsedOptions extends PluginLifecycleOptions {
  json?: boolean;
}

function parseArguments(argv: readonly string[]): ParsedOptions {
  if (argv[0] === "--help" || argv[0] === "-h") {
    usage();
    process.exit(0);
  }
  const action = argv[0] as PluginLifecycleAction | undefined;
  if (action === undefined || !["install", "upgrade", "uninstall", "doctor"].includes(action)) {
    usage();
    throw new Error("expected install, upgrade, uninstall, or doctor");
  }
  let profile: string | undefined;
  let revision: string | undefined;
  let apply = false;
  let profileStopped = false;
  let cutoverSafe = false;
  let offline = false;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--profile") {
      profile = argv[++index];
    } else if (value === "--revision") {
      revision = argv[++index];
    } else if (value === "--apply") {
      apply = true;
    } else if (value === "--profile-stopped") {
      profileStopped = true;
    } else if (value === "--cutover-safe") {
      cutoverSafe = true;
    } else if (value === "--offline") {
      offline = true;
    } else if (value === "--json") {
      json = true;
    } else if (value === "--help" || value === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  if (profile === undefined || profile.length === 0) throw new Error("--profile is required");
  if ((action === "install" || action === "upgrade") && revision === undefined) {
    throw new Error("--revision is required for install and upgrade");
  }
  if (action === "uninstall" && revision !== undefined) {
    throw new Error("uninstall does not take --revision");
  }
  if (action === "doctor" && (apply || profileStopped || cutoverSafe || revision !== undefined)) {
    throw new Error("doctor is read-only and does not take mutation flags or --revision");
  }
  return {
    action,
    profile,
    ...(revision === undefined ? {} : { revision }),
    apply,
    profileStopped,
    cutoverSafe,
    offline,
    json,
  };
}

function render(result: Awaited<ReturnType<typeof runPluginLifecycle>>): void {
  const mode = result.applied ? "APPLIED" : result.action === "doctor" ? "DOCTOR" : "PLAN";
  process.stdout.write(`${mode} ${result.action} profile=${result.profile}\n`);
  for (const check of result.checks) {
    process.stdout.write(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}\n`);
  }
  for (const note of result.notes) process.stdout.write(`- ${note}\n`);
  if (!result.applied && result.action !== "doctor") {
    process.stdout.write("No changes made. Add --apply and the required safety acknowledgements to execute.\n");
  }
}

function usage(): void {
  process.stderr.write(
    [
      "usage:",
      "  dsh-teleport-plugin install --profile <name> --revision <full-sha> [--apply --profile-stopped --cutover-safe]",
      "  dsh-teleport-plugin upgrade --profile <name> --revision <full-sha> [--apply --profile-stopped]",
      "  dsh-teleport-plugin uninstall --profile <name> [--apply --profile-stopped --cutover-safe]",
      "  dsh-teleport-plugin doctor --profile <name> [--offline] [--json]",
      "",
      "Without --apply, lifecycle mutations print a plan and make no changes.",
    ].join("\n") + "\n",
  );
}
