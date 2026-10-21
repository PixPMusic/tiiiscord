import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("credentials use nonempty environment overrides and otherwise fall back to storage", async t => {
  const directory = await mkdtemp(join(tmpdir(), "tiiiscord-config-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = ["T3_DISCORD_CONFIG", "T3_TOKEN", "DISCORD_TOKEN"] as const;
  const original = keys.map(key => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.T3_DISCORD_CONFIG = join(directory, "config.json");
  const { loadCredentials } = await import("../src/config.ts");
  const stored = { t3Token: "test-stored-t3", discordToken: "test-stored-discord" };
  const credentialsPath = join(directory, "credentials.json");
  await writeFile(credentialsPath, JSON.stringify(stored));

  const cases = [
    { name: "unset tokens use saved credentials", t3: undefined, discord: undefined, expected: stored },
    { name: "empty tokens use saved credentials", t3: "", discord: "", expected: stored },
    { name: "nonempty tokens override saved credentials", t3: "test-env-t3", discord: "test-env-discord",
      expected: { t3Token: "test-env-t3", discordToken: "test-env-discord" } },
    { name: "each token falls back independently (Discord blank)", t3: "test-env-t3", discord: "",
      expected: { t3Token: "test-env-t3", discordToken: stored.discordToken } },
    { name: "each token falls back independently (T3 blank)", t3: "", discord: "test-env-discord",
      expected: { t3Token: stored.t3Token, discordToken: "test-env-discord" } },
  ];
  for (const { name, t3, discord, expected } of cases) {
    await t.test(name, async () => {
      if (t3 === undefined) delete process.env.T3_TOKEN;
      else process.env.T3_TOKEN = t3;
      if (discord === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = discord;
      assert.deepEqual(await loadCredentials(), expected);
    });
  }

  await rm(credentialsPath);
  await t.test("empty tokens without saved credentials remain unset", async () => {
    process.env.T3_TOKEN = "";
    process.env.DISCORD_TOKEN = "";
    assert.deepEqual(await loadCredentials(), { t3Token: undefined, discordToken: undefined });
  });
  await t.test("environment credentials work without a saved credentials file", async () => {
    process.env.T3_TOKEN = "test-env-t3";
    process.env.DISCORD_TOKEN = "test-env-discord";
    assert.deepEqual(await loadCredentials(), { t3Token: "test-env-t3", discordToken: "test-env-discord" });
  });
});
