import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: projectDir,
  encoding: "utf8",
  env: { ...process.env, NPM_TOKEN: "" },
});

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const reports = JSON.parse(result.stdout);
if (!Array.isArray(reports) || reports.length !== 1) {
  throw new Error("npm pack returned an unexpected report");
}
const files = reports[0].files.map(({ path }) => path);
for (const forbidden of [".npmrc", ".env", "pnpm-lock.yaml"]) {
  if (files.includes(forbidden)) throw new Error(`package tarball contains ${forbidden}`);
}

process.stdout.write(`package tarball: verified ${files.length} files; local npm config excluded\n`);
