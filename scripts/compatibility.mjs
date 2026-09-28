import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
export function peerSpecs() {
  const variables = {
    "@deepseek-ai/dsh-session": "DSH_TELEPORT_TEST_SESSION_SPEC",
    "@deepseek-ai/dsh-session-persistence": "DSH_TELEPORT_TEST_SESSION_PERSISTENCE_SPEC",
    "@deepseek-ai/dsh-session-persistence-jsonl": "DSH_TELEPORT_TEST_JSONL_SPEC",
    "@deepseek-ai/cordis": "DSH_TELEPORT_TEST_CORDIS_SPEC",
  };
  const primary = Object.fromEntries(Object.entries(variables).map(([name, variable]) => [
    name, process.env[variable]?.trim() || manifest.devDependencies[name],
  ]));
  // The DSH profile manager does not automatically install transitive peers.
  // Keep one matching host closure for adapter imports in either smoke test.
  const version = manifest.devDependencies["@deepseek-ai/dsh-session"];
  return {
    ...Object.fromEntries(["dsh-scope", "dsh-invariants", "dsh-attachment", "dsh-brand",
      "dsh-llm", "dsh-timeout", "dsh-typert-protocol"].map((name) => [`@deepseek-ai/${name}`, version])),
    "@deepseek-ai/cordis-plugin-include": "1.0.9",
    "@deepseek-ai/cordis-plugin-loader": "1.0.5",
    ...primary,
  };
}
