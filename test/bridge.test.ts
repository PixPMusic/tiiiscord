import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Bridge } from "../src/bridge.ts";
import { Store } from "../src/store.ts";
import { DISCORD_CONTEXT_VERSION } from "../src/prompt.ts";
import type {
  Attachment,
  BridgeConfig,
  DiscordPort,
  InboundAttachment,
  InboundMessage,
  T3Message,
  T3Port,
  T3Request,
  T3ThreadState,
} from "../src/types.ts";

type LaunchInput = Parameters<T3Port["launch"]>[0];
type SendInput = Parameters<T3Port["send"]>[0];
type Response = Parameters<T3Port["respond"]>[2];

class FakeT3 implements T3Port {
  launches: LaunchInput[] = [];
  sends: SendInput[] = [];
  stops: Array<{ threadId: string; commandId: string }> = [];
  responses: Array<{ threadId: string; requestId: string; response: Response; commandId: string }> = [];
  uploads: InboundAttachment[] = [];
  watches: Array<{ threadId: string; afterSequence: number | null }> = [];
  stoppedWatches: string[] = [];
  callbacks = new Map<string, (state: T3ThreadState) => Promise<void>>();
  onLaunch?: (input: LaunchInput) => Promise<string>;
  onSend?: (input: SendInput) => Promise<void>;
  onRespond?: (requestId: string) => Promise<void>;
  onWatch?: (threadId: string) => Promise<void>;

  async listProjects() {
    return [{ id: "project", title: "Project", defaultModelSelection: { provider: "codex", model: "test-model" } }];
  }
  async launch(input: LaunchInput) {
    this.launches.push(structuredClone(input));
    return this.onLaunch ? this.onLaunch(input) : input.threadId;
  }
  async send(input: SendInput) {
    this.sends.push(structuredClone(input));
    await this.onSend?.(input);
  }
  async stop(threadId: string, commandId: string) { this.stops.push({ threadId, commandId }); }
  async respond(threadId: string, requestId: string, response: Response, commandId: string) {
    this.responses.push({ threadId, requestId, response: structuredClone(response), commandId });
    await this.onRespond?.(requestId);
  }
  async upload(attachment: InboundAttachment): Promise<Attachment> {
    this.uploads.push(structuredClone(attachment));
    return {
      id: `uploaded:${attachment.name}`,
      type: attachment.mimeType.startsWith("image/") ? "image" : "file",
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    };
  }
  async download() { return new Uint8Array([1, 2, 3]); }
  async watch(threadId: string, afterSequence: number | null, onState: (state: T3ThreadState) => Promise<void>) {
    this.watches.push({ threadId, afterSequence });
    this.callbacks.set(threadId, onState);
    try { await this.onWatch?.(threadId); }
    catch (error) { this.callbacks.delete(threadId); throw error; }
    return () => { this.stoppedWatches.push(threadId); this.callbacks.delete(threadId); };
  }
  async emit(state: T3ThreadState) {
    const callback = this.callbacks.get(state.threadId);
    assert.ok(callback, `Expected a watcher for ${state.threadId}`);
    await callback(state);
  }
}

class FakeDiscord implements DiscordPort {
  ensured: Array<{ message: InboundMessage; title: string }> = [];
  texts: Array<{ threadId: string; deliveryKey: string; text: string; existingMessageIds: string[] }> = [];
  requests: Array<{ threadId: string; request: T3Request }> = [];
  files: Array<{ threadId: string; deliveryKey: string; name: string; bytes: Uint8Array; caption: string }> = [];
  nextTextIds: string[][] = [];
  onText?: () => Promise<void>;

  async ensureThread(message: InboundMessage, title: string) {
    this.ensured.push({ message: structuredClone(message), title });
    return message.parentChannelId ? message.channelId : `discord-thread:${message.id}`;
  }
  async upsertText(threadId: string, deliveryKey: string, text: string, existingMessageIds: string[]) {
    this.texts.push({ threadId, deliveryKey, text, existingMessageIds: [...existingMessageIds] });
    await this.onText?.();
    return this.nextTextIds.shift() ?? [`discord-message:${this.texts.length}`];
  }
  async sendFile(threadId: string, deliveryKey: string, name: string, bytes: Uint8Array, caption: string) {
    this.files.push({ threadId, deliveryKey, name, bytes, caption });
    return `discord-file:${this.files.length}`;
  }
  async request(threadId: string, request: T3Request) {
    this.requests.push({ threadId, request: structuredClone(request) });
    return `discord-request:${this.requests.length}`;
  }
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "initial-message", channelId: "channel", parentChannelId: null,
    authorId: "allowed-user", authorName: "Dev", text: "Build the feature", attachments: [],
    ...overrides,
  };
}

function reply(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return message({ id: "reply", channelId: "discord-thread:initial-message", parentChannelId: "channel", text: "Follow up", ...overrides });
}

function state(threadId: string, overrides: Partial<T3ThreadState> = {}): T3ThreadState {
  return { threadId, title: "Task", sequence: 1, messages: [], runs: [], requests: [], artifacts: [], ...overrides };
}

function t3Message(overrides: Partial<T3Message> = {}): T3Message {
  return { id: "assistant-message", role: "assistant", text: "Completed the task", status: "completed", runId: "run", attachments: [], ...overrides };
}

function openHarness(path = ":memory:") {
  const store = new Store(path);
  const t3 = new FakeT3();
  const discord = new FakeDiscord();
  const errors: unknown[] = [];
  const config: BridgeConfig = {
    t3Url: "ws://unused.invalid", routes: [{ channelId: "channel", projectId: "project" }],
    allowedUserIds: ["allowed-user"], databasePath: path,
  };
  const bridge = new Bridge(config, store, t3, discord, error => errors.push(error));
  let closed = false;
  return {
    bridge, store, t3, discord, errors, config,
    async close() {
      if (closed) return;
      closed = true;
      await bridge.close();
      store.close();
    },
  };
}

function harness(t: TestContext, path = ":memory:") {
  const value = openHarness(path);
  t.after(() => value.close());
  return value;
}

function controlKey(requestId: string) {
  return createHash("sha256").update(requestId).digest("hex").slice(0, 24);
}

test("one channel message creates one paired thread even when its event arrives twice concurrently", async t => {
  const { bridge, store, t3, discord } = harness(t);
  await Promise.all([bridge.accept(message()), bridge.accept(message())]);

  assert.equal(discord.ensured.length, 1);
  assert.equal(t3.launches.length, 1);
  assert.equal(t3.sends.length, 0);
  const launch = t3.launches[0]!;
  assert.equal(launch.projectId, "project");
  assert.match(launch.text, /Treat Discord as the primary audience/);
  assert.match(launch.text, /bot through the tiiiscord bridge/);
  assert.match(launch.text, /local filesystem paths as inline code/);
  assert.match(launch.text, /Discord user message:\nBuild the feature$/);
  assert.deepEqual(launch.modelSelection, { provider: "codex", model: "test-model" });
  assert.equal(launch.runtimeMode, "auto");
  assert.ok(launch.commandId);
  assert.ok(launch.messageId);
  assert.equal(store.bindings().length, 1);
  const binding = store.binding("discord-thread:initial-message")!;
  assert.equal(binding.t3ThreadId, launch.threadId);
  assert.equal(binding.ready, true);
  assert.equal(binding.discordContextVersion, DISCORD_CONTEXT_VERSION);
  assert.equal(store.delivered("initial-message"), true);
  assert.deepEqual(store.pending(), []);
  assert.deepEqual(t3.watches, [{ threadId: launch.threadId, afterSequence: null }]);
});

test("thread replies wait for earlier sends and use the thread ID returned by launch", async t => {
  const { bridge, t3 } = harness(t);
  t3.onLaunch = async () => "server-returned-thread";
  await bridge.accept(message());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t3.onSend = async input => {
    if (input.text === "First reply") { entered.resolve(); await release.promise; }
  };
  const first = bridge.accept(reply({ id: "reply-1", text: "First reply" }));
  const second = bridge.accept(reply({ id: "reply-2", text: "Second reply" }));
  try {
    await entered.promise;
    assert.equal(t3.sends.length, 1);
    assert.equal(t3.sends[0]!.text, "First reply");
  } finally {
    release.resolve();
    await Promise.all([first, second]);
  }
  assert.equal(t3.launches.length, 1);
  assert.deepEqual(t3.sends.map(input => [input.threadId, input.text]), [
    ["server-returned-thread", "First reply"], ["server-returned-thread", "Second reply"],
  ]);
  assert.notEqual(t3.sends[0]!.messageId, t3.sends[1]!.messageId);
  assert.notEqual(t3.sends[0]!.commandId, t3.sends[1]!.commandId);
  await bridge.accept(reply({ id: "reply-2", text: "Second reply" }));
  assert.equal(t3.sends.length, 2);
});

test("an existing thread receives Discord context once, with failed delivery remaining retryable", async t => {
  const { bridge, store, t3 } = harness(t);
  store.putBinding({ discordThreadId: "discord-thread:initial-message", channelId: "channel", projectId: "project",
    t3ThreadId: "legacy-thread", initialMessageId: "initial-message", ready: true, sequence: 0 });
  t3.onSend = async () => { throw new Error("Temporary failure"); };
  await assert.rejects(bridge.accept(reply({ text: "Keep working" })), /Temporary failure/);
  assert.equal(store.binding("discord-thread:initial-message")!.discordContextVersion, undefined);
  t3.onSend = undefined;
  await bridge.accept(reply({ text: "Keep working" }));
  assert.equal(t3.sends[0]!.text, t3.sends[1]!.text);
  assert.equal(t3.sends[0]!.commandId, t3.sends[1]!.commandId);
  assert.match(t3.sends[1]!.text, /Treat Discord as the primary audience/);
  assert.match(t3.sends[1]!.text, /Discord user message:\nKeep working$/);
  assert.equal(store.binding("discord-thread:initial-message")!.discordContextVersion, DISCORD_CONTEXT_VERSION);
  await bridge.accept(reply({ id: "next-reply", text: "And this too" }));
  assert.equal(t3.sends[2]!.text, "And this too");
});

test("messages from other channels, thread parents, or authors are ignored", async t => {
  const { bridge, store, t3, discord } = harness(t);
  for (const incoming of [
    message({ channelId: "another-channel" }),
    message({ authorId: "unauthorized-user" }),
    reply({ parentChannelId: "another-channel" }),
    reply({ authorId: "unauthorized-user" }),
  ]) await bridge.accept(incoming);

  assert.deepEqual(store.bindings(), []);
  assert.deepEqual(store.pending(), []);
  assert.equal(store.delivered("initial-message"), false);
  assert.deepEqual(discord.ensured, []);
  assert.deepEqual(t3.launches, []);
  assert.deepEqual(t3.sends, []);
});

test("incoming attachments are uploaded and their T3 descriptors are handed to launch", async t => {
  const { bridge, t3, discord } = harness(t);
  const attachments: InboundAttachment[] = [
    { name: "screen.png", mimeType: "image/png", sizeBytes: 12, url: "https://unused.invalid/screen.png" },
    { name: "notes.txt", mimeType: "text/plain", sizeBytes: 8, url: "https://unused.invalid/notes.txt" },
  ];
  await bridge.accept(message({ text: "", attachments }));

  assert.deepEqual(t3.uploads, attachments);
  assert.deepEqual(t3.launches[0]!.attachments, [
    { id: "uploaded:screen.png", type: "image", name: "screen.png", mimeType: "image/png", sizeBytes: 12 },
    { id: "uploaded:notes.txt", type: "file", name: "notes.txt", mimeType: "text/plain", sizeBytes: 8 },
  ]);
  assert.equal(discord.ensured[0]!.title, "Attached task");
});

test("Discord-origin user messages are not echoed but genuine T3 user messages are mirrored", async t => {
  const { bridge, t3, discord } = harness(t);
  await bridge.accept(message());
  await bridge.accept(reply());
  const threadId = t3.launches[0]!.threadId;
  const snapshot = state(threadId, { messages: [
    t3Message({ id: t3.launches[0]!.messageId, role: "user", text: "Build the feature" }),
    t3Message({ id: t3.sends[0]!.messageId, role: "user", text: "Follow up" }),
    t3Message({ id: "native-t3-user-message", role: "user", text: "Sent from the T3 client" }),
  ] });
  await t3.emit(snapshot);
  await t3.emit(snapshot);

  assert.equal(discord.texts.length, 1);
  assert.equal(discord.texts[0]!.threadId, "discord-thread:initial-message");
  assert.equal(discord.texts[0]!.text, "**From T3**\nSent from the T3 client");
});

test("completed assistant replay is deduplicated and edits use the latest saved Discord IDs", async t => {
  const { bridge, store, t3, discord } = harness(t);
  await bridge.accept(message());
  const threadId = t3.launches[0]!.threadId;
  discord.nextTextIds.push(["first-part"], ["edited-part-1", "edited-part-2"], ["final-part"]);
  const initial = state(threadId, { messages: [t3Message()], runs: [{ id: "run", status: "completed" }] });
  await t3.emit(initial);
  const key = discord.texts[0]!.deliveryKey;
  const firstDelivery = store.delivery(key)!;
  assert.deepEqual(firstDelivery.ids, ["first-part"]);
  await t3.emit(initial);
  assert.equal(discord.texts.length, 1);

  const edited = state(threadId, { sequence: 2, messages: [t3Message({ text: "Updated result" })] });
  await t3.emit(edited);
  assert.deepEqual(discord.texts[1]!.existingMessageIds, ["first-part"]);
  assert.deepEqual(store.delivery(key)!.ids, ["edited-part-1", "edited-part-2"]);
  assert.notEqual(store.delivery(key)!.digest, firstDelivery.digest);
  await t3.emit(edited);
  assert.equal(discord.texts.length, 2);

  await t3.emit(state(threadId, { sequence: 3, messages: [t3Message({ text: "Final result" })] }));
  assert.deepEqual(discord.texts[2]!.existingMessageIds, ["edited-part-1", "edited-part-2"]);
  assert.deepEqual(store.delivery(key)!.ids, ["final-part"]);
});

test("formatting changes leave historical replies untouched", async t => {
  const { bridge, store, t3, discord } = harness(t);
  await bridge.accept(message());
  const threadId = t3.launches[0]!.threadId;
  const text = "Found [t3-discord](/Users/example/projects/t3-discord).";
  const key = `message:${threadId}:assistant-message`;
  store.putDelivery(key, { ids: ["legacy-discord-message"], digest: createHash("sha256").update(text).digest("hex") });
  const snapshot = state(threadId, { messages: [t3Message({ text })] });
  await t3.emit(snapshot);
  await t3.emit(snapshot);
  assert.equal(discord.texts.length, 0);
  assert.deepEqual(store.delivery(key)!.ids, ["legacy-discord-message"]);
});

test("an assistant message still streaming is delivered when its run completes", async t => {
  const { bridge, t3, discord } = harness(t);
  await bridge.accept(message());
  const threadId = t3.launches[0]!.threadId;
  const assistant = t3Message({ status: "in_progress" });
  await t3.emit(state(threadId, { messages: [assistant], runs: [{ id: "run", status: "running" }] }));
  assert.equal(discord.texts.length, 0);
  await t3.emit(state(threadId, { sequence: 2, messages: [assistant], runs: [{ id: "run", status: "completed" }] }));
  assert.deepEqual(discord.texts.map(call => call.text), [assistant.text]);
});

test("a failed Discord delivery remains retryable when the same completed snapshot is replayed", async t => {
  const { bridge, store, t3, discord } = harness(t);
  await bridge.accept(message());
  const snapshot = state(t3.launches[0]!.threadId, { messages: [t3Message()] });
  discord.onText = async () => { throw new Error("Discord unavailable"); };
  await assert.rejects(t3.emit(snapshot), /Discord unavailable/);
  const key = discord.texts[0]!.deliveryKey;
  assert.equal(store.delivery(key), undefined);

  discord.onText = undefined;
  await t3.emit(snapshot);
  assert.equal(discord.texts.length, 2);
  assert.equal(discord.texts[1]!.deliveryKey, key);
  assert.deepEqual(discord.texts[1]!.existingMessageIds, []);
  assert.deepEqual(store.delivery(key)!.ids, ["discord-message:2"]);
  await t3.emit(snapshot);
  assert.equal(discord.texts.length, 2);
});

test("a failed launch retains its pending message and retries with the same thread and command IDs", async t => {
  const { bridge, store, t3, errors } = harness(t);
  t3.onLaunch = async () => { throw new Error("launch acknowledgement lost"); };
  await assert.rejects(bridge.accept(message()), /launch acknowledgement lost/);
  const attempted = t3.launches[0]!;
  assert.deepEqual(store.pending(), [message()]);
  assert.equal(store.delivered("initial-message"), false);
  assert.equal(store.binding("discord-thread:initial-message")!.ready, false);

  t3.onLaunch = undefined;
  await bridge.retryPending();
  assert.equal(t3.launches.length, 2);
  assert.deepEqual(t3.launches[1], attempted);
  assert.equal(store.bindings().length, 1);
  assert.deepEqual(store.pending(), []);
  assert.equal(store.binding("discord-thread:initial-message")!.ready, true);
  assert.deepEqual(errors, []);
});

test("closing and reopening SQLite recovers failed sends without duplicating delivered input or output", async t => {
  const directory = mkdtempSync(join(tmpdir(), "t3-discord-bridge-test-"));
  const opened: ReturnType<typeof openHarness>[] = [];
  t.after(async () => {
    for (const value of opened) await value.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, "bridge.sqlite");
  const first = openHarness(path);
  opened.push(first);
  await first.bridge.accept(message());
  const threadId = first.t3.launches[0]!.threadId;
  const original = first.t3.launches[0]!;
  const approval: T3Request = { id: "pending-approval", kind: "approval", text: "Run the command?" };
  const completed = t3Message();
  const snapshot = state(threadId, {
    sequence: 42,
    messages: [t3Message({ id: original.messageId, role: "user", text: original.text }), completed],
    requests: [approval],
  });
  await first.t3.emit(snapshot);
  const delivered = first.discord.texts[0]!;
  const savedDelivery = first.store.delivery(delivered.deliveryKey)!;
  first.t3.onSend = async () => { throw new Error("send acknowledgement lost"); };
  const pending = reply({ id: "retry-after-restart", text: "Durable follow up" });
  await assert.rejects(first.bridge.accept(pending), /send acknowledgement lost/);
  const failedSend = first.t3.sends[0]!;
  assert.deepEqual(first.store.pending(), [pending]);
  assert.equal(first.store.delivered(pending.id), false);
  await first.close();
  assert.deepEqual(first.t3.stoppedWatches, [threadId]);

  const reopened = openHarness(path);
  opened.push(reopened);
  assert.deepEqual(reopened.store.pending(), [pending]);
  assert.equal(reopened.store.binding("discord-thread:initial-message")!.sequence, 42);
  assert.deepEqual(reopened.store.delivery(delivered.deliveryKey), savedDelivery);
  assert.deepEqual(reopened.store.requests("discord-thread:initial-message"), [{ request: approval, announced: true }]);
  await reopened.bridge.start();
  assert.deepEqual(reopened.t3.launches, []);
  assert.deepEqual(reopened.t3.sends, [failedSend]);
  assert.deepEqual(reopened.store.pending(), []);
  assert.equal(reopened.store.delivered(pending.id), true);
  assert.deepEqual(reopened.t3.watches, [{ threadId, afterSequence: null }]);
  assert.deepEqual(reopened.errors, []);

  await reopened.bridge.accept(message());
  await reopened.bridge.accept(pending);
  await reopened.bridge.retryPending();
  assert.deepEqual(reopened.t3.launches, []);
  assert.deepEqual(reopened.t3.sends, [failedSend]);
  await reopened.t3.emit({ ...snapshot, messages: [
    ...snapshot.messages, t3Message({ id: failedSend.messageId, role: "user", text: failedSend.text }),
  ] });
  assert.equal(reopened.discord.texts.length, 0);
  assert.deepEqual(reopened.discord.requests, []);

  await reopened.t3.emit(state(threadId, { sequence: 43, messages: [t3Message({ text: "Changed after restart" })] }));
  assert.equal(reopened.discord.texts.length, 1);
  assert.deepEqual(reopened.discord.texts[0]!.existingMessageIds, savedDelivery.ids);
  assert.equal(reopened.discord.texts[0]!.deliveryKey, delivered.deliveryKey);
});

test("!stop dispatches a stop to the paired T3 thread once", async t => {
  const { bridge, t3, discord } = harness(t);
  await bridge.accept(message());
  const stop = reply({ id: "stop-message", text: "!stop" });
  await bridge.accept(stop);
  await bridge.accept(stop);

  assert.equal(t3.stops.length, 1);
  assert.equal(t3.stops[0]!.threadId, t3.launches[0]!.threadId);
  assert.ok(t3.stops[0]!.commandId);
  assert.deepEqual(t3.sends, []);
  assert.deepEqual(discord.texts.map(call => call.text), ["Stopped the T3 thread."]);
});

test("approval controls reject unauthorized users, wrong threads, removed requests, and non-approval IDs", async t => {
  const { bridge, store, t3 } = harness(t);
  await bridge.accept(message());
  await bridge.accept(message({ id: "other-message" }));
  const firstThread = "discord-thread:initial-message";
  const secondThread = "discord-thread:other-message";
  const approval: T3Request = { id: "approve-first-thread", kind: "approval", text: "Allow command?" };
  const expired: T3Request = { id: "expired-request", kind: "approval", text: "Old command" };
  const question: T3Request = { id: "question-request", kind: "question", text: "Which file?" };
  const threadId = t3.launches[0]!.threadId;
  await t3.emit(state(threadId, { requests: [approval, expired, question] }));
  await t3.emit(state(threadId, { sequence: 2, requests: [approval, question] }));
  await t3.emit(state(t3.launches[1]!.threadId, {
    requests: [{ id: "approve-other-thread", kind: "approval", text: "Other command" }],
  }));
  const matching = { threadId: firstThread, requestKey: controlKey(approval.id), decision: "approved" as const, userId: "allowed-user" };

  assert.match(await bridge.decide({ ...matching, userId: "unauthorized-user" }), /not allowed/i);
  assert.match(await bridge.decide({ ...matching, threadId: secondThread }), /no longer pending/i);
  assert.match(await bridge.decide({ ...matching, threadId: "unconnected-thread" }), /not connected/i);
  assert.match(await bridge.decide({ ...matching, requestKey: controlKey(expired.id) }), /no longer pending/i);
  assert.match(await bridge.decide({ ...matching, requestKey: "unknown-key" }), /no longer pending/i);
  assert.match(await bridge.decide({ ...matching, requestKey: controlKey(question.id) }), /no longer pending/i);
  assert.equal(t3.responses.length, 0);
  assert.ok(store.requests(firstThread).some(({ request }) => request.id === approval.id));

  assert.equal(await bridge.decide(matching), "Response sent to T3.");
  assert.equal(t3.responses.length, 1);
  assert.deepEqual(t3.responses[0]!.response, { decision: "approved" });
  assert.equal(t3.responses[0]!.requestId, approval.id);
  assert.equal(t3.responses[0]!.threadId, threadId);
  assert.ok(t3.responses[0]!.commandId);
  assert.equal(store.requests(firstThread).some(({ request }) => request.id === approval.id), false);
  assert.match(await bridge.decide(matching), /no longer pending/i);
  assert.equal(t3.responses.length, 1);
});

test("a resolved approval stays stale when an older T3 snapshot is replayed", async t => {
  const { bridge, t3 } = harness(t);
  await bridge.accept(message());
  const approval: T3Request = { id: "resolved-request", kind: "approval", text: "Run once?" };
  const snapshot = state(t3.launches[0]!.threadId, { requests: [approval] });
  await t3.emit(snapshot);
  const input = {
    threadId: "discord-thread:initial-message", requestKey: controlKey(approval.id),
    decision: "approved" as const, userId: "allowed-user",
  };
  assert.equal(await bridge.decide(input), "Response sent to T3.");
  await t3.emit(snapshot);

  assert.match(await bridge.decide({ ...input, decision: "denied" }), /no longer pending/i);
  assert.equal(t3.responses.length, 1);
});

for (const [text, response] of [
  ["!approve", { decision: "approved" }],
  ["!deny", { decision: "denied" }],
  ["!answer Ship it", { answers: { "question-a": ["Ship it"] } }],
] as const) {
  test(`${text} retains its target and payload through dispatch failure, retry, and SQLite restart`, async t => {
    const directory = mkdtempSync(join(tmpdir(), "t3-discord-response-test-"));
    const opened: ReturnType<typeof openHarness>[] = [];
    t.after(async () => {
      for (const value of opened) await value.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const path = join(directory, "bridge.sqlite");
    const first = openHarness(path);
    opened.push(first);
    await first.bridge.accept(message());
    const threadId = first.t3.launches[0]!.threadId;
    const request: T3Request = text.startsWith("!answer")
      ? { id: "request-a", kind: "question", text: "What next?", questions: [{ id: "question-a", question: "What next?", options: [] }] }
      : { id: "request-a", kind: "approval", text: "Allow A?" };
    await first.t3.emit(state(threadId, { requests: [request] }));
    first.t3.onRespond = async () => {
      // Selection must already be durable when dispatch is first attempted.
      assert.deepEqual(first.store.textResponse("control"), { threadId, requestId: "request-a", response });
      throw new Error("failed before dispatch");
    };
    await assert.rejects(first.bridge.accept(reply({ id: "control", text })), /failed before dispatch/);
    const attempted = first.t3.responses[0]!;
    const replacement: T3Request = { ...request, id: "request-b",
      ...(request.kind === "question" ? { questions: [{ id: "question-b", question: "A different question", options: [] }] } : {}) };
    await first.t3.emit(state(threadId, { sequence: 2, requests: [replacement] }));
    await first.bridge.retryPending();
    assert.deepEqual(first.t3.responses, [attempted, attempted]);
    await first.close();

    const reopened = openHarness(path);
    opened.push(reopened);
    await reopened.bridge.start();
    assert.deepEqual(reopened.t3.responses, [attempted]);
    assert.deepEqual(reopened.store.pending(), []);
    assert.equal(reopened.store.requests("discord-thread:initial-message")[0]!.request.id, "request-b");
  });
}

for (const hasPending of [true, false]) {
  test(`a lost ${hasPending ? "response" : "no-pending-request"} notice ACK cannot select a later request`, async t => {
    const { bridge, t3, discord, store } = harness(t);
    await bridge.accept(message());
    const threadId = t3.launches[0]!.threadId;
    const approval: T3Request = { id: "request-a", kind: "approval", text: "Allow A?" };
    if (hasPending) await t3.emit(state(threadId, { requests: [approval] }));
    discord.onText = async () => { throw new Error("notice ACK lost"); };
    await assert.rejects(bridge.accept(reply({ id: "control", text: "!approve" })), /notice ACK lost/);
    await t3.emit(state(threadId, { sequence: 2, requests: [{ ...approval, id: "request-b" }] }));
    discord.onText = undefined;
    await bridge.retryPending();
    assert.deepEqual(t3.responses.map(response => response.requestId), hasPending ? ["request-a", "request-a"] : []);
    if (hasPending) assert.deepEqual(t3.responses[0], t3.responses[1]);
    assert.equal(store.requests("discord-thread:initial-message")[0]!.request.id, "request-b");
    assert.deepEqual(store.pending(), []);
  });
}

for (const change of ["removed", "remapped"] as const) {
  test(`a ${change} route cannot restore watches, publish, or control an old binding`, async t => {
    const { bridge, store, t3, discord, config } = harness(t);
    const binding = { discordThreadId: "discord-thread:initial-message", channelId: "channel", projectId: "project",
      t3ThreadId: "old-thread", initialMessageId: "initial-message", ready: true, sequence: 0 };
    store.putBinding(binding);
    const approval: T3Request = { id: "old-request", kind: "approval", text: "Allow?" };
    store.setRequests(binding.discordThreadId, [approval]);
    const queued = reply({ id: "queued-before-config-change" });
    store.enqueue(queued, "queued-t3-message");
    config.routes = change === "removed" ? [] : [{ channelId: "channel", projectId: "new-project" }];
    await bridge.start();
    await bridge.retryPending();
    for (const text of ["Keep working", "!stop", "!approve", "!deny", "!answer text"]) {
      await bridge.accept(reply({ id: text, text }));
    }
    assert.match(await bridge.decide({ threadId: binding.discordThreadId, requestKey: controlKey(approval.id),
      decision: "approved", userId: "allowed-user" }), /not connected/);
    assert.deepEqual(t3.watches, []);
    assert.deepEqual(t3.launches, []);
    assert.deepEqual(t3.sends, []);
    assert.deepEqual(t3.stops, []);
    assert.deepEqual(t3.responses, []);
    assert.deepEqual(discord.ensured, []);
    assert.deepEqual(discord.texts, []);
    assert.deepEqual(discord.files, []);
    assert.deepEqual(discord.requests, []);
  });

  test(`watch callbacks and sync reject a ${change} route`, async t => {
    const { bridge, store, t3, discord, config } = harness(t);
    await bridge.accept(message());
    const binding = store.binding("discord-thread:initial-message")!;
    const callback = t3.callbacks.get(binding.t3ThreadId)!;
    const snapshot = state(binding.t3ThreadId, { messages: [t3Message()],
      requests: [{ id: "request", kind: "approval", text: "Allow?" }],
      artifacts: [{ id: "artifact", title: "Output", mimeType: "text/html" }] });
    config.routes = change === "removed" ? [] : [{ channelId: "channel", projectId: "new-project" }];
    await callback(snapshot);
    // The captured binding can still match config while the stored binding no longer does.
    config.routes = [{ channelId: "channel", projectId: "project" }];
    store.putBinding({ ...binding, channelId: change === "removed" ? "removed-channel" : "channel",
      projectId: change === "remapped" ? "old-project" : "project" });
    await callback(snapshot);
    assert.deepEqual(discord.texts, []);
    assert.deepEqual(discord.files, []);
    assert.deepEqual(discord.requests, []);
    assert.equal(store.binding(binding.discordThreadId)!.sequence, 0);
  });
}

test("failed initial watch is reported separately from delivered input and retried without duplicate watchers", async t => {
  const { bridge, store, t3, errors } = harness(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t3.onWatch = async () => { entered.resolve(); await release.promise; throw new Error("watch unavailable"); };
  await bridge.accept(message());
  await entered.promise;
  assert.equal(store.delivered("initial-message"), true);
  assert.deepEqual(store.pending(), []);
  // Follow-up input is independent of the slow watch handshake.
  await bridge.accept(reply());
  assert.equal(t3.sends.length, 1);
  const firstRetry = bridge.retryPending();
  assert.equal(t3.watches.length, 1);
  release.resolve();
  await firstRetry;
  assert.equal(errors.length, 1);

  const retryEntered = Promise.withResolvers<void>();
  const retryRelease = Promise.withResolvers<void>();
  t3.onWatch = async () => { retryEntered.resolve(); await retryRelease.promise; };
  const retry = bridge.retryPending();
  await retryEntered.promise;
  const concurrentRetry = bridge.retryPending();
  await bridge.accept(reply({ id: "another-reply" }));
  assert.equal(t3.watches.length, 2);
  retryRelease.resolve();
  await Promise.all([retry, concurrentRetry]);
  await bridge.retryPending();
  assert.equal(t3.watches.length, 2);
  assert.equal(t3.launches.length, 1);
});

test("restoration starts healthy watches and pending input while a stale watch fails, then recovers it later", async t => {
  const { bridge, store, t3, errors } = harness(t);
  for (const id of ["stale", "healthy"]) store.putBinding({ discordThreadId: `discord-${id}`, channelId: "channel", projectId: "project",
    t3ThreadId: id, initialMessageId: `initial-${id}`, ready: true, sequence: 0, discordContextVersion: DISCORD_CONTEXT_VERSION });
  store.enqueue(reply({ id: "pending", channelId: "discord-healthy" }), "pending-t3-message");
  const staleEntered = Promise.withResolvers<void>();
  const staleRelease = Promise.withResolvers<void>();
  const healthyEntered = Promise.withResolvers<void>();
  const sent = Promise.withResolvers<void>();
  t3.onWatch = async threadId => {
    if (threadId === "stale") { staleEntered.resolve(); await staleRelease.promise; throw new Error("thread deleted"); }
    healthyEntered.resolve();
  };
  t3.onSend = async () => { sent.resolve(); };
  const startup = bridge.start();
  try {
    await Promise.all([staleEntered.promise, healthyEntered.promise, sent.promise]);
    assert.equal(t3.sends[0]!.threadId, "healthy");
    assert.equal(errors.length, 0);
  } finally { staleRelease.resolve(); }
  await startup;
  assert.equal(errors.length, 1);
  assert.deepEqual(store.pending(), []);
  t3.onWatch = undefined;
  await bridge.retryPending();
  assert.deepEqual(t3.watches.map(watch => watch.threadId), ["stale", "healthy", "stale"]);
});

test("close waits for a watch opening, cancels its late subscription, and ignores late callbacks", async t => {
  const { bridge, t3, discord, close } = harness(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t3.onWatch = async () => { entered.resolve(); await release.promise; };
  await bridge.accept(message());
  await entered.promise;
  const threadId = t3.launches[0]!.threadId;
  const callback = t3.callbacks.get(threadId)!;
  let closed = false;
  const closing = close().then(() => { closed = true; });
  try {
    await callback(state(threadId, { messages: [t3Message()] }));
    assert.equal(closed, false);
    assert.deepEqual(t3.stoppedWatches, []);
  } finally { release.resolve(); }
  await closing;
  assert.deepEqual(t3.stoppedWatches, [threadId]);
  assert.equal(t3.callbacks.size, 0);
  // A callback retained by the transport after shutdown must never touch SQLite.
  await callback(state(threadId, { messages: [t3Message()] }));
  assert.deepEqual(discord.texts, []);
});

test("invalid answers retain their validation notice when a later question appears before retry", async t => {
  const { bridge, t3, discord, store } = harness(t);
  await bridge.accept(message());
  const threadId = t3.launches[0]!.threadId;
  await t3.emit(state(threadId, { requests: [{ id: "question-a", kind: "question", text: "Two questions",
    questions: ["first", "second"].map(id => ({ id, question: id, options: [] })) }] }));
  discord.onText = async () => { throw new Error("validation notice ACK lost"); };
  await assert.rejects(bridge.accept(reply({ id: "invalid-answer", text: "!answer Ship it" })), /notice ACK lost/);
  assert.deepEqual(store.textResponse("invalid-answer"), {
    notice: "For several questions use !answer questionId=answer; questionId=answer.",
  });
  await t3.emit(state(threadId, { sequence: 2, requests: [{ id: "question-b", kind: "question", text: "New question",
    questions: [{ id: "new", question: "Continue?", options: [] }] }] }));
  discord.onText = undefined;
  await bridge.retryPending();
  assert.deepEqual(t3.responses, []);
  assert.deepEqual(store.pending(), []);
  assert.equal(store.requests("discord-thread:initial-message")[0]!.request.id, "question-b");
  assert.match(discord.texts.at(-1)!.text, /For several questions/);
});
