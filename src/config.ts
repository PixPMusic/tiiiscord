import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { BridgeConfig, Credentials, ModelSelection, Route, RuntimeMode } from "./types.ts";

export const configPath = resolve(process.env.T3_DISCORD_CONFIG ?? ".local/config.json");
export const credentialsPath = resolve(dirname(configPath), "credentials.json");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const modes = new Set(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const snowflake = (value: unknown): value is string => typeof value === "string" && /^\d{15,22}$/.test(value);

export function parseConfig(value: unknown): BridgeConfig {
  if (!record(value) || typeof value.t3Url !== "string" || !Array.isArray(value.routes) || !value.routes.length)
    throw new Error("Configure a T3 URL and at least one channel route with npm run setup.");
  const url = new URL(value.t3Url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("T3 URL must be an HTTP(S) origin without credentials, query, or fragment.");
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("Use HTTPS for a remote T3 environment, or HTTP on localhost.");
  if (!Array.isArray(value.allowedUserIds) || !value.allowedUserIds.length || !value.allowedUserIds.every(snowflake))
    throw new Error("Set allowedUserIds to the Discord user IDs allowed to run agents.");
  const routes: Route[] = value.routes.map(raw => {
    if (!record(raw) || !snowflake(raw.channelId) || typeof raw.projectId !== "string" || !raw.projectId.trim())
      throw new Error("Each route needs a Discord channel ID and T3 project ID.");
    if (raw.runtimeMode !== undefined && (typeof raw.runtimeMode !== "string" || !modes.has(raw.runtimeMode)))
      throw new Error("Invalid runtimeMode in channel route.");
    let modelSelection: ModelSelection | undefined;
    if (raw.modelSelection !== undefined) {
      if (!record(raw.modelSelection) || typeof raw.modelSelection.model !== "string") throw new Error("Invalid modelSelection.");
      const { model, instanceId, provider, options } = raw.modelSelection;
      if ((instanceId !== undefined && typeof instanceId !== "string") || (provider !== undefined && typeof provider !== "string") ||
          (options !== undefined && (!record(options) || !Object.values(options).every(value => typeof value === "boolean" || typeof value === "string"))))
        throw new Error("Invalid modelSelection fields.");
      modelSelection = { model, ...(instanceId ? { instanceId } : {}), ...(provider ? { provider } : {}),
        ...(options ? { options: options as Record<string, string | boolean> } : {}) };
    }
    return { channelId: raw.channelId, projectId: raw.projectId, ...(modelSelection ? { modelSelection } : {}),
      ...(raw.runtimeMode ? { runtimeMode: raw.runtimeMode as RuntimeMode } : {}) };
  });
  if (new Set(routes.map(route => route.channelId)).size !== routes.length) throw new Error("A channel can only have one route.");
  return { t3Url: url.href.replace(/\/$/, ""), routes, allowedUserIds: value.allowedUserIds,
    databasePath: resolve(dirname(configPath), typeof value.databasePath === "string" ? value.databasePath : "bridge.sqlite") };
}
export async function loadCredentials(): Promise<Credentials> {
  let stored: Credentials = {};
  try { stored = JSON.parse(await readFile(credentialsPath, "utf8")) as Credentials; }
  catch (error) { if (!record(error) || error.code !== "ENOENT") throw error; }
  return { t3Token: process.env.T3_TOKEN || stored.t3Token, discordToken: process.env.DISCORD_TOKEN || stored.discordToken };
}
export async function loadConfig(): Promise<BridgeConfig> {
  return parseConfig(JSON.parse(await readFile(configPath, "utf8")));
}
export async function savePrivate(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
export async function saveCredentials(credentials: Credentials) { await savePrivate(credentialsPath, credentials); }
