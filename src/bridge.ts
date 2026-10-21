import { createHash } from "node:crypto";
import { Store, type Binding, type TextResponse } from "./store.ts";
import type { BridgeConfig, DiscordPort, InboundMessage, T3Port, T3ThreadState } from "./types.ts";
import { DISCORD_CONTEXT_VERSION, discordInitialPrompt } from "./prompt.ts";

export function stableId(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const requestKey = (id: string) => digest(id).slice(0, 24);
const terminal = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

export class Bridge {
  private config: BridgeConfig;
  private store: Store;
  private t3: T3Port;
  private discord: DiscordPort;
  private queues = new Map<string, Promise<void>>();
  private watchers = new Map<string, () => void>();
  private watchStarts = new Map<string, Promise<void>>();
  private closed = false;
  private onError: (error: unknown) => void;
  constructor(config: BridgeConfig, store: Store, t3: T3Port, discord: DiscordPort, onError: (error: unknown) => void) {
    this.config = config; this.store = store; this.t3 = t3; this.discord = discord; this.onError = onError;
  }
  private serial(key: string, work: () => Promise<void>) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {});
    return next;
  }
  private active(binding: Binding) {
    return this.config.routes.some(route => route.channelId === binding.channelId && route.projectId === binding.projectId);
  }
  async start() { await this.retryPending(); }
  async close() {
    this.closed = true;
    for (const stop of this.watchers.values()) stop();
    this.watchers.clear();
    await Promise.allSettled(this.watchStarts.values());
    await Promise.allSettled(this.queues.values());
  }
  async accept(message: InboundMessage) {
    if (this.closed) return;
    const route = this.config.routes.find(route => route.channelId === (message.parentChannelId ?? message.channelId));
    if (!route || !this.config.allowedUserIds.includes(message.authorId)) return;
    const prior = message.parentChannelId ? this.store.binding(message.channelId) : undefined;
    if (prior && (!this.active(prior) || prior.channelId !== route.channelId)) return;
    this.store.enqueue(message, stableId(`message:${message.id}`));
    const key = message.parentChannelId ? message.channelId : message.id;
    return this.serial(`in:${key}`, async () => {
      if (this.store.delivered(message.id)) return;
      const title = message.text.replace(/\s+/g, " ").slice(0, 90) || "Attached task";
      const discordThreadId = await this.discord.ensureThread(message, title);
      let binding = this.store.binding(discordThreadId);
      const existing = binding !== undefined;
      if (binding && (!this.active(binding) || binding.channelId !== route.channelId)) return;
      if (!binding) {
        binding = {
          discordThreadId, channelId: route.channelId, projectId: route.projectId,
          t3ThreadId: stableId(`thread:${discordThreadId}`), initialMessageId: message.id,
          ready: false, sequence: 0,
        };
        this.store.putBinding(binding);
      }
      if (message.text.trim() === "!stop" && existing) {
        await this.t3.stop(binding.t3ThreadId, stableId(`stop:${message.id}`));
        await this.notice(discordThreadId, message.id, "Stopped the T3 thread.");
      } else if (/^!(approve|deny|answer)\b/.test(message.text) && existing) {
        await this.respondText(binding, message);
      } else {
        const attachments = await Promise.all(message.attachments.map(file => this.t3.upload(file)));
        const messageId = stableId(`message:${message.id}`);
        if (!binding.ready && binding.initialMessageId === message.id) {
          const projectId = binding.projectId;
          const project = (await this.t3.listProjects()).find(project => project.id === projectId);
          const modelSelection = route.modelSelection ?? project?.defaultModelSelection;
          if (!modelSelection) throw new Error("Choose a provider and model for this channel in the bridge configuration.");
          const threadId = await this.t3.launch({
            commandId: stableId(`launch:${message.id}`), threadId: binding.t3ThreadId,
            messageId, projectId: binding.projectId, title, text: discordInitialPrompt(message.text),
            attachments, modelSelection, runtimeMode: route.runtimeMode ?? "auto",
          });
          binding = { ...binding, t3ThreadId: threadId, ready: true, discordContextVersion: DISCORD_CONTEXT_VERSION };
          this.store.putBinding(binding);
        } else {
          if (!binding.ready) throw new Error("The first message is still being delivered. Retry shortly.");
          await this.t3.send({ commandId: stableId(`send:${message.id}`), threadId: binding.t3ThreadId,
            messageId, text: binding.discordContextVersion === DISCORD_CONTEXT_VERSION ? message.text : discordInitialPrompt(message.text), attachments });
          if (binding.discordContextVersion !== DISCORD_CONTEXT_VERSION) {
            binding = { ...binding, discordContextVersion: DISCORD_CONTEXT_VERSION };
            this.store.putBinding(binding);
          }
        }
      }
      this.store.complete(message.id);
      if (binding.ready) void this.watch(binding);
    }).catch(async error => {
      const thread = message.parentChannelId ? message.channelId : message.id;
      const binding = this.store.binding(thread);
      if (binding && this.active(binding)) await this.notice(thread, `error:${message.id}`,
        "Could not deliver this message to T3. The bridge will retry; check the bridge log if it persists.").catch(this.onError);
      throw error;
    });
  }
  private watch(binding: Binding): Promise<void> {
    const key = binding.discordThreadId;
    if (this.closed || !binding.ready || !this.active(binding) || this.watchers.has(key)) return Promise.resolve();
    const existing = this.watchStarts.get(key);
    if (existing) return existing;
    const opening = Promise.resolve().then(async () => {
      if (this.closed || !this.active(binding)) return;
      // A new connection needs a snapshot as well as its cursor to reconstruct active messages.
      const stop = await this.t3.watch(binding.t3ThreadId, null, state => {
        if (this.closed || !this.active(binding)) return Promise.resolve();
        return this.serial(`out:${key}`, () => this.sync(key, state));
      });
      if (this.closed || !this.active(binding)) stop();
      else this.watchers.set(key, stop);
    }).catch(this.onError).finally(() => { this.watchStarts.delete(key); });
    this.watchStarts.set(key, opening);
    return opening;
  }
  private async notice(thread: string, key: string, text: string) {
    const deliveryKey = `notice:${key}`;
    const previous = this.store.delivery(deliveryKey);
    const ids = await this.discord.upsertText(thread, deliveryKey, text, previous?.ids ?? []);
    this.store.putDelivery(deliveryKey, { ids, digest: digest(text) });
  }
  private async sync(discordThreadId: string, state: T3ThreadState) {
    if (this.closed) return;
    const binding = this.store.binding(discordThreadId);
    if (!binding || !this.active(binding) || state.threadId !== binding.t3ThreadId) return;
    for (const message of state.messages) {
      // Discord-originated IDs are derived from the durable inbox, so an echo never comes back.
      if (message.role === "user" && this.isOwnMessage(message.id)) continue;
      const run = state.runs.find(run => run.id === message.runId);
      const stillRunning = run !== undefined && !terminal.has(run.status);
      // Completed messages and commentary are delivered; token-by-token edits are coalesced by the T3 adapter.
      if (message.status === "in_progress" && stillRunning) continue;
      if (message.text.trim()) {
        const text = message.role === "user" ? `**From T3**\n${message.text}` : message.text;
        const key = `message:${binding.t3ThreadId}:${message.id}`;
        const previous = this.store.delivery(key);
        if (previous?.digest !== digest(text)) {
          const ids = await this.discord.upsertText(discordThreadId, key, text, previous?.ids ?? []);
          this.store.putDelivery(key, { ids, digest: digest(text) });
        }
      }
      for (const attachment of message.attachments) {
        const fileKey = `file:${binding.t3ThreadId}:${attachment.id}`;
        if (this.store.delivery(fileKey)) continue;
        const bytes = await this.t3.download(attachment.id, attachment.name, attachment.mimeType);
        const id = await this.discord.sendFile(discordThreadId, fileKey, attachment.name, bytes, attachment.name);
        this.store.putDelivery(fileKey, { ids: [id], digest: "sent" });
      }
    }
    for (const artifact of state.artifacts) {
      const key = `artifact:${binding.t3ThreadId}:${artifact.id}`;
      if (this.store.delivery(key)) continue;
      const bytes = await this.t3.download(artifact.id, `${artifact.title}.html`, artifact.mimeType);
      const id = await this.discord.sendFile(discordThreadId, key, `${artifact.title.replace(/[^a-z0-9._ -]/gi, "_").slice(0, 100)}.html`, bytes,
        `Visual reply: ${artifact.title} — download to open the interactive page.`);
      this.store.putDelivery(key, { ids: [id], digest: "sent" });
    }
    this.store.setRequests(discordThreadId, state.requests);
    for (const { request, announced } of this.store.requests(discordThreadId)) {
      if (!announced) { await this.discord.request(discordThreadId, request); this.store.announced(discordThreadId, request.id); }
    }
    const latest = this.store.binding(discordThreadId);
    if (latest) this.store.putBinding({ ...latest, sequence: state.sequence });
  }
  async retryPending() {
    if (this.closed) return;
    const watches = this.store.bindings().map(binding => this.watch(binding));
    for (const message of this.store.pending()) await this.accept(message).catch(this.onError);
    await Promise.all(watches);
  }
  private isOwnMessage(messageId: string) { return this.store.hasT3Message(messageId); }
  private async respondText(binding: Binding, message: InboundMessage) {
    const selected = this.store.textResponse(message.id) ?? this.store.saveTextResponse(message.id, this.selectTextResponse(binding, message));
    if ("notice" in selected) { await this.notice(binding.discordThreadId, message.id, selected.notice); return; }
    await this.t3.respond(selected.threadId, selected.requestId, selected.response, stableId(`respond:${message.id}`));
    this.store.resolveRequest(binding.discordThreadId, selected.requestId);
    await this.notice(binding.discordThreadId, message.id, "Response sent to T3.");
  }
  private selectTextResponse(binding: Binding, message: InboundMessage): TextResponse {
    const [command, ...parts] = message.text.trim().split(/\s+/);
    const kind = command === "!answer" ? "question" : "approval";
    const pending = this.store.requests(binding.discordThreadId).find(({ request }) => request.kind === kind)?.request;
    if (!pending) return { notice: `No pending ${kind} request.` };
    if (kind === "approval") {
      return { threadId: binding.t3ThreadId, requestId: pending.id, response: { decision: command === "!approve" ? "approved" : "denied" } };
    } else {
      const questions = pending.questions ?? [];
      const answer = parts.join(" ");
      if (!answer || !questions.length) return { notice: "Use !answer followed by your answer." };
      const answers: Record<string, string[]> = {};
      if (questions.length === 1) answers[questions[0]!.id] = [answer];
      else for (const part of answer.split(";")) {
        const equals = part.indexOf("=");
        if (equals < 1) return { notice: "For several questions use !answer questionId=answer; questionId=answer." };
        answers[part.slice(0, equals).trim()] = [part.slice(equals + 1).trim()];
      }
      return { threadId: binding.t3ThreadId, requestId: pending.id, response: { answers } };
    }
  }
  async decide(input: { threadId: string; requestKey: string; decision: "approved" | "denied"; userId: string }) {
    if (!this.config.allowedUserIds.includes(input.userId)) return "You are not allowed to control this bridge.";
    if (this.closed) return "This Discord thread is not connected to T3.";
    const binding = this.store.binding(input.threadId);
    if (!binding || !this.active(binding)) return "This Discord thread is not connected to T3.";
    const pending = this.store.requests(input.threadId).find(({ request }) => requestKey(request.id) === input.requestKey)?.request;
    if (!pending || pending.kind !== "approval") return "This request is no longer pending.";
    await this.t3.respond(binding.t3ThreadId, pending.id, { decision: input.decision }, stableId(`decision:${pending.id}:${input.decision}`));
    this.store.resolveRequest(input.threadId, pending.id);
    return "Response sent to T3.";
  }
}
