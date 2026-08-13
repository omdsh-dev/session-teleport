import { isUtf8 } from "node:buffer";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(
  await readFile(join(projectDir, "package.json"), "utf8"),
);
const readme = await readFile(join(projectDir, "README.md"), "utf8");
const license = await readFile(join(projectDir, "LICENSE"), "utf8");
const envExample = await readFile(join(projectDir, ".env.example"), "utf8");
const npmrc = await readFile(join(projectDir, ".npmrc"), "utf8");
const bundlePatch = await readFile(
  join(projectDir, "cordis.patch.yml"),
  "utf8",
);
const integrationGuide = await readFile(
  join(projectDir, "docs/DSH_INTEGRATION.md"),
  "utf8",
);
const lifecycleGuide = await readFile(
  join(projectDir, "docs/PLUGIN_LIFECYCLE.md"),
  "utf8",
);
const localLifecycle = await readFile(
  join(projectDir, "scripts/plugin-profile-local.mjs"),
  "utf8",
);

assert(packageJson.private === true, "package.json must retain private: true");
assert(
  packageJson.license === "BSD-3-Clause",
  "package.json license must be BSD-3-Clause",
);
assert(
  packageJson.repository?.url ===
    "git+https://github.com/omdsh-dev/session-teleport.git",
  "package.json repository URL is not the release repository",
);
assert(
  packageJson.keywords?.includes("dsh-plugin"),
  "package discovery keyword dsh-plugin is missing",
);
assert(
  readme.includes("BSD-3-Clause"),
  "README license declaration is missing",
);
assert(
  license.startsWith("BSD 3-Clause License\n"),
  "LICENSE is not BSD 3-Clause text",
);
assert(
  license.includes("Copyright (c) 2026, mattheliu\n"),
  "LICENSE author is inconsistent",
);
assert(!license.includes("@"), "LICENSE must not include an email address");
assert(
  /^DATABASE_URL=postgresql:\/\/USER:PASSWORD@HOST:5432\/DATABASE$/m.test(
    envExample,
  ),
  ".env.example must use an explicit PostgreSQL placeholder URL",
);
assert(
  npmrc ===
    [
      "auto-install-peers=false",
      "@deepseek-ai:registry=https://registry.npmjs.org/",
      "//registry.npmjs.org/:_authToken=${NPM_TOKEN}",
      "",
    ].join("\n"),
  ".npmrc must contain only the approved registry template",
);
const baselines = {
  "@deepseek-ai/cordis": ["4.0.1-rc.4", "^4.0.1-rc.4"],
  "@deepseek-ai/dsh-session": ["0.0.1-rc.5", "0.0.1-rc.5"],
  "@deepseek-ai/dsh-session-persistence": ["0.0.1-rc.5", "0.0.1-rc.5"],
};
for (const [name, [development, peer]] of Object.entries(baselines)) {
  assert(
    packageJson.devDependencies?.[name] === development,
    `${name} development baseline changed`,
  );
  assert(
    packageJson.peerDependencies?.[name] === peer,
    `${name} peer range changed`,
  );
}
assert(
  packageJson.devDependencies?.[
    "@deepseek-ai/dsh-session-persistence-jsonl"
  ] === "0.0.1-rc.5",
  "JSONL development baseline changed",
);
assert(
  bundlePatch.includes("process.env.DSH_TELEPORT_ENABLE === '1'"),
  "JSONL must remain enabled until explicit Teleport cutover",
);
assert(
  bundlePatch.includes("process.env.DSH_TELEPORT_ENABLE !== '1'"),
  "Teleport adapter must remain disabled until explicit cutover",
);
assert(
  bundlePatch.includes("process.env.DSH_TELEPORT_HEALTH_TIMEOUT_MS ?? '5000'"),
  "Teleport startup health timeout must remain explicitly configurable",
);
for (const [name, content] of [
  ["README.md", readme],
  ["docs/DSH_INTEGRATION.md", integrationGuide],
  ["docs/PLUGIN_LIFECYCLE.md", lifecycleGuide],
]) {
  assert(
    content.includes("DSH_TELEPORT_ENABLE=1"),
    `${name} omits the explicit cutover gate`,
  );
}
for (const name of [
  "@deepseek-ai/dsh-attachment",
  "@deepseek-ai/dsh-brand",
  "@deepseek-ai/dsh-invariants",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-scope",
  "@deepseek-ai/dsh-timeout",
  "@deepseek-ai/dsh-typert-protocol",
]) {
  assert(
    localLifecycle.includes(`\"${name}\": \"0.0.1-rc.5\"`),
    `local lifecycle peer closure omits ${name}@0.0.1-rc.5`,
  );
}
for (const file of ["SECURITY.md", "CONTRIBUTING.md"]) {
  assert(
    packageJson.files?.includes(file),
    `${file} is not included in the package boundary`,
  );
}

const mapNames = (await readdir(join(projectDir, "dist"))).filter((name) =>
  name.endsWith(".map"),
);
assert(mapNames.length > 0, "dist contains no source maps to verify");
for (const name of mapNames) {
  const path = join(projectDir, "dist", name);
  const raw = await readFile(path, "utf8");
  const map = JSON.parse(raw);
  assert(
    !Object.hasOwn(map, "sourcesContent"),
    `${name} embeds sourcesContent`,
  );
  assert(
    !isAbsoluteOrUrl(map.sourceRoot ?? ""),
    `${name} has an absolute sourceRoot`,
  );
  for (const source of map.sources ?? []) {
    assert(
      !isAbsoluteOrUrl(source),
      `${name} has an absolute or URL source: ${source}`,
    );
  }
  assert(
    !/(?:\/Users\/|\/home\/|[A-Za-z]:\\\\)/.test(raw),
    `${name} contains a local path`,
  );
}

await assertNoConcreteTokens(projectDir);

process.stdout.write(
  `release artifacts: verified ${mapNames.length} source maps and package metadata\n`,
);

async function assertNoConcreteTokens(root) {
  const excluded = new Set([".git", "node_modules", "coverage"]);
  const tokenPatterns = [
    new RegExp(["npm", "_[A-Za-z0-9]{20,}"].join("")),
    new RegExp(["ghp", "_[A-Za-z0-9]{20,}"].join("")),
    new RegExp(["github", "_pat_[A-Za-z0-9_]{20,}"].join("")),
    new RegExp(
      [
        "NPM",
        "_TOKEN\\s*=\\s*(?!\\$\\{NPM_TOKEN\\}(?:\\r?$|[\\\"'`]))\\S+",
      ].join(""),
      "m",
    ),
    new RegExp(
      [
        "_auth",
        "Token\\s*=\\s*(?!\\$\\{NPM_TOKEN\\}(?:\\r?$|[\\\"'`]))\\S+",
      ].join(""),
      "m",
    ),
  ];
  const hygienePatterns = [
    new RegExp(
      [
        "dsh",
        "-external|dsh",
        "2026|integration-",
        "08",
        "12|(?:^|[^0-9])08(?:0[0-9]|12)(?:[^0-9]|$)|\\u5185\\u6d4b|(?:^|[^A-Za-z])N",
        "DA(?:[^A-Za-z]|$)",
      ].join(""),
      "im",
    ),
    new RegExp(["leon", "liuzx|outlook\\.com"].join(""), "i"),
    new RegExp(
      [
        "(?:/",
        "Users/|/home/)[A-Za-z0-9._-]+/|[A-Za-z]:\\\\(?:Users|Documents)\\\\",
      ].join(""),
      "i",
    ),
    new RegExp(["-----BEGIN ", "[A-Z ]*PRIVATE KEY-----"].join("")),
  ];
  const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      assert(!entry.isSymbolicLink(), `${path} is a symbolic link`);
      if (excluded.has(entry.name)) continue;
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      assert(entry.isFile(), `${path} is not a regular file`);
      assert(!/\.tgz$/i.test(entry.name), `${path} is a package archive`);
      const value = await readFile(path);
      assert(!value.includes(0), `${path} contains binary data`);
      assert(isUtf8(value), `${path} is not valid UTF-8 text`);
      const text = value.toString("utf8");
      assert(
        !tokenPatterns.some((pattern) => pattern.test(text)),
        `${path} contains a concrete token`,
      );
      assert(
        !hygienePatterns.some((pattern) => pattern.test(text)),
        `${path} contains release hygiene data`,
      );
      for (const match of text.matchAll(emailPattern)) {
        const email = match[0].toLowerCase();
        assert(
          email.endsWith("@example.invalid") ||
            email.endsWith("@users.noreply.github.com"),
          `${path} contains a non-placeholder email address`,
        );
      }
    }
  }
}

function isAbsoluteOrUrl(value) {
  return /^(?:\/|[A-Za-z]:[\\\\/]|[A-Za-z][A-Za-z0-9+.-]*:)/.test(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
