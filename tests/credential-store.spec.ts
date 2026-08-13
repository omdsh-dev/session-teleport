import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileWriterCredentialStore } from "../src/credential-store.js";

describe("FileWriterCredentialStore", () => {
  const directories: string[] = [];

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it("round-trips one writer through an owner-only atomic file", async () => {
    const root = await mkdtemp(join(tmpdir(), "teleport-credentials-"));
    directories.push(root);
    const directory = join(root, "writers");
    const store = new FileWriterCredentialStore(directory);
    const writer = {
      deviceId: "office",
      writerEpoch: 3,
      writerToken: "secret-token",
    };
    await store.put("session/a", writer);
    expect(await store.get("session/a")).toEqual(writer);
    expect(await store.get("missing")).toBeUndefined();

    const files = (await import("node:fs/promises")).readdir(directory);
    const names = await files;
    expect(names).toHaveLength(1);
    expect(names[0]).not.toContain("session/a");
    const mode = (await stat(join(directory, names[0]!))).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await readFile(join(directory, names[0]!), "utf8")).not.toContain("session/a.json");

    await store.delete("session/a");
    expect(await store.get("session/a")).toBeUndefined();
  });
});
