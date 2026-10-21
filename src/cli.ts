import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { Client, Events, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import { Bridge, stableId } from "./bridge.ts";
import { configPath, credentialsPath, loadConfig, loadCredentials, parseConfig, saveCredentials, savePrivate } from "./config.ts";
import { createDiscordClient, DiscordAdapter } from "./discord.ts";
import { Store } from "./store.ts";
import { exchangePairing, T3Client } from "./t3.ts";
import type { T3ThreadState } from "./types.ts";

const command = process.argv[2] ?? "start";
let redactions: string[] = [];
function safeError(error: unknown) {
  let message = error instanceof Error ? error.message : "Unexpected bridge error";
  for (const value of redactions) if (value) message = message.replaceAll(value, "[redacted]");
  return message.replace(/(wsTicket|token|credential)=([^&\s]+)/gi, "$1=[redacted]");
}
const report = (error: unknown) => console.error(`[bridge] ${safeError(error)}`);

async function setup() {
  if (!process.stdin.isTTY) throw new Error("Run npm run setup in an interactive terminal. Secrets are entered without echo.");
  let hidden = false;
  const output = new Writable({ write(chunk: Buffer, _encoding, done) { if (!hidden) process.stdout.write(chunk); done(); } });
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  const ask = async (label: string, fallback = "", secret = false) => {
    process.stdout.write(`${label}${fallback ? ` [${fallback}]` : ""}: `);
    hidden = secret;
    try { return (await prompt.question("")).trim() || fallback; }
    finally { hidden = false; if (secret) process.stdout.write("\n"); }
  };
  let t3: T3Client | undefined;
  try {
    const credentials = await loadCredentials();
    const url = await ask("T3 environment URL", "http://127.0.0.1:3773");
    if (!credentials.t3Token || await ask("Replace saved T3 connection? (y/n)", "n") === "y") {
      let pairing = await ask("T3 pairing code or pairing URL", "", true);
      try { pairing = new URL(pairing).hash.slice(1).replace(/^token=/, ""); } catch {}
      const session = await exchangePairing(url, pairing);
      credentials.t3Token = session.token;
      await saveCredentials(credentials);
    }
    if (!credentials.discordToken || await ask("Replace saved Discord bot token? (y/n)", "n") === "y")
      credentials.discordToken = await ask("Discord bot token", "", true);
    redactions = [credentials.t3Token!, credentials.discordToken!];
    t3 = new T3Client({ url, token: credentials.t3Token!, onError: report });
    await t3.connect();
    const projects = await t3.listProjects();
    projects.forEach((project, index) => console.log(`${index + 1}. ${project.title}`));
    const chosen = Number(await ask("Project number", "1")) - 1;
    const project = projects[chosen];
    if (!project) throw new Error("Choose an existing T3 project.");
    const channelId = await ask("Discord channel ID", process.env.DISCORD_CHANNEL_ID ?? "");
    const allowedUserIds = (await ask("Allowed Discord user IDs (comma separated)")).split(",").map(id => id.trim());
    const provider = await ask("T3 provider instance", project.defaultModelSelection?.instanceId ?? "codex");
    const model = await ask("Model", project.defaultModelSelection?.model ?? "gpt-6.1-sol");
    const runtimeMode = await ask("Permission mode", "auto");
    const config = parseConfig({ t3Url: url, allowedUserIds, databasePath: "bridge.sqlite",
      routes: [{ channelId, projectId: project.id, modelSelection: { instanceId: provider, model }, runtimeMode }] });
    await saveCredentials(credentials);
    await savePrivate(configPath, config);
    console.log(`Saved configuration to ${configPath}. Run npm run doctor, then npm start.`);
  } finally { prompt.close(); await t3?.close(); }
}

async function connections() {
  const config = await loadConfig();
  const credentials = await loadCredentials();
  if (!credentials.t3Token || !credentials.discordToken) throw new Error("Run npm run setup to connect T3 and Discord.");
  redactions = [credentials.t3Token, credentials.discordToken];
  const t3 = new T3Client({ url: config.t3Url, token: credentials.t3Token, onError: report });
  await t3.connect();
  return { config, credentials, t3 };
}

async function doctor() {
  const { config, credentials, t3 } = await connections();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    const ready = once(client, Events.ClientReady);
    await client.login(credentials.discordToken);
    await ready;
    const projects = await t3.listProjects();
    console.log(`T3: connected to ${new URL(config.t3Url).origin}; ${projects.length} projects available.`);
    console.log(`Discord: connected as ${client.user?.tag}.`);
    for (const route of config.routes) {
      if (!projects.some(project => project.id === route.projectId)) throw new Error(`T3 project ${route.projectId} does not exist.`);
      const channel = await client.channels.fetch(route.channelId);
      if (!channel || !channel.isTextBased() || !('permissionsFor' in channel)) throw new Error(`Channel ${route.channelId} is not a guild text channel.`);
      const permissions = channel.permissionsFor(client.user!);
      const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.AttachFiles];
      if (!permissions?.has(needed)) throw new Error(`Missing required Discord permissions in ${route.channelId}.`);
      console.log(`Route ${route.channelId}: ready (${route.runtimeMode ?? "auto"}).`);
    }
    console.log("Enable Message Content Intent in the Discord Developer Portal before starting the bot.");
  } finally { await client.destroy(); await t3.close(); }
}

async function smoke() {
  const { config, t3 } = await connections();
  const route = config.routes[0]!;
  const project = (await t3.listProjects()).find(project => project.id === route.projectId);
  const modelSelection = route.modelSelection ?? project?.defaultModelSelection;
  if (!modelSelection) throw new Error("Configure a provider/model first.");
  const id = `smoke:${Date.now()}`;
  let stop: (() => void) | undefined;
  try {
    const threadId = await t3.launch({ commandId: stableId(`${id}:launch`), threadId: stableId(`${id}:thread`),
      messageId: stableId(`${id}:message`), projectId: route.projectId, title: "Discord bridge connection test",
      modelSelection, runtimeMode: "approval-required", attachments: [],
      text: "Reply with exactly T3_DISCORD_BRIDGE_OK. Do not use tools or change files." });
    console.log(`Created T3 smoke-test thread ${threadId}.`);
    await new Promise<void>((resolveResult, reject) => {
      const timeout = setTimeout(() => reject(new Error("Smoke test timed out after 2 minutes.")), 120_000);
      const onState = async (state: T3ThreadState) => {
        if (state.messages.some(message => message.role === "assistant" && message.text.includes("T3_DISCORD_BRIDGE_OK"))) {
          clearTimeout(timeout); resolveResult();
        } else if (state.runs.some(run => ["failed", "cancelled"].includes(run.status))) {
          clearTimeout(timeout); reject(new Error("T3 smoke-test run failed."));
        }
      };
      void t3.watch(threadId, null, onState).then(unsubscribe => { stop = unsubscribe; }, error => { clearTimeout(timeout); reject(error); });
    });
    console.log("T3 created a thread and streamed the expected agent reply. No Discord message was posted.");
  } finally { stop?.(); await t3.close(); }
}

async function start() {
  const { config, credentials, t3 } = await connections();
  const store = new Store(config.databasePath);
  let bridge: Bridge;
  const client = createDiscordClient(config, {
    onMessage: async message => { await bridge.accept(message); },
    onDecision: async action => bridge.decide(action),
  });
  client.on(Events.Error, report);
  bridge = new Bridge(config, store, t3, new DiscordAdapter(client), report);
  let retry: NodeJS.Timeout | undefined;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    if (retry) clearInterval(retry);
    await client.destroy();
    await bridge.close();
    await t3.close();
    store.close();
    console.log("Bridge stopped.");
  };
  process.once("SIGINT", () => void shutdown().catch(report));
  process.once("SIGTERM", () => void shutdown().catch(report));
  try {
    const ready = once(client, Events.ClientReady);
    await client.login(credentials.discordToken);
    await ready;
    await bridge.start();
    retry = setInterval(() => void bridge.retryPending().catch(report), 10_000);
    console.log(`Bridge online as ${client.user?.tag}. Channels: ${config.routes.map(route => route.channelId).join(", ")}.`);
  } catch (error) { await shutdown(); throw error; }
}

try {
  if (command === "setup") await setup();
  else if (command === "doctor") await doctor();
  else if (command === "smoke") await smoke();
  else if (command === "start") await start();
  else throw new Error("Usage: node src/cli.ts [setup|doctor|smoke|start]");
} catch (error) { report(error); process.exitCode = 1; }
