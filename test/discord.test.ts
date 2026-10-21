import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AttachmentBuilder, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import type { Client, ClientEvents, Interaction, MessageCreateOptions, MessageEditOptions } from "discord.js";
import { createDiscordClient, deliveryNonce, DiscordAdapter, requestKey, splitDiscordText } from "../src/discord.ts";
import type { DiscordDecision } from "../src/discord.ts";
import type { InboundMessage } from "../src/types.ts";

const noMentions = { parse: [], repliedUser: false };

function fixture() {
  const sent: MessageCreateOptions[] = [];
  const edited: Array<{ id: string; options: MessageEditOptions }> = [];
  const deleted: string[] = [];
  const messages = new Map<string, ReturnType<typeof addMessage>>();
  const nonces = new Map<string | number, ReturnType<typeof addMessage>>();
  const channels = new Map<string, unknown>();
  let sendError: unknown;
  let editError: unknown;
  let serial = 0;
  function addMessage(id: string, content: string, authorId = "bot") {
    const message = {
      id,
      content,
      author: { id: authorId },
      edit: async (options: MessageEditOptions) => {
        if (editError) throw editError;
        edited.push({ id, options });
        message.content = options.content ?? "";
        return message;
      },
      delete: async () => {
        deleted.push(id);
        messages.delete(id);
        return message;
      },
    };
    messages.set(id, message);
    return message;
  }
  const thread = {
    id: "thread",
    parentId: "parent",
    isThread: () => true,
    isSendable: () => true,
    messages: {
      fetch: async ({ message: id }: { message: string }) => {
        const message = messages.get(id);
        if (!message) throw { code: 10008 };
        return message;
      },
    },
    send: async (options: MessageCreateOptions) => {
      sent.push(options);
      if (sendError) throw sendError;
      const prior = options.nonce && options.enforceNonce ? nonces.get(options.nonce) : undefined;
      if (prior) return prior;
      const message = addMessage(`sent-${++serial}`, options.content ?? "");
      if (options.nonce) nonces.set(options.nonce, message);
      return message;
    },
  };
  channels.set(thread.id, thread);
  const client = {
    user: { id: "bot" },
    channels: {
      fetch: async (id: string) => {
        if (!channels.has(id)) throw { code: 10003 };
        return channels.get(id);
      },
    },
  } as unknown as Client;
  return {
    adapter: new DiscordAdapter(client), thread, client, channels, messages, sent, edited, deleted, addMessage,
    failSend(error: unknown) { sendError = error; },
    failEdit(error: unknown) { editError = error; },
  };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "starter", channelId: "parent", parentChannelId: null,
    authorId: "user", authorName: "User", text: "hello", attachments: [], ...overrides,
  };
}

test("splitting preserves plain content and Unicode without exceeding Discord's budget", () => {
  assert.deepEqual(splitDiscordText(""), []);
  assert.deepEqual(splitDiscordText(" \n"), []);
  assert.deepEqual(splitDiscordText("x".repeat(1900)), ["x".repeat(1900)]);
  for (const text of ["word ".repeat(1500), "x".repeat(1899) + "😀".repeat(1800), "line\n".repeat(1500)]) {
    const parts = splitDiscordText(text);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((part) => part.length > 0 && part.length <= 1900 && part.isWellFormed()));
    assert.equal(parts.join(""), text);
  }
});

test("splitting closes and reopens code fences with the language and preserves code", () => {
  for (const marker of ["```", "~~~~"]) {
    const lines = Array.from({ length: 180 }, (_, index) => `const value${index} = ${index};\n`).join("");
    const parts = splitDiscordText(`${marker}typescript\n${lines}${marker}`);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((part) => part.length <= 1900 && part.startsWith(`${marker}typescript\n`) && part.endsWith(marker)));
    const code = parts.map((part) => part.slice(`${marker}typescript\n`.length, -marker.length)).join("");
    assert.equal(code, lines);
  }
  const longLine = splitDiscordText(`\`\`\`js\n${"😀".repeat(4000)}\n\`\`\``);
  assert.ok(longLine.every((part) => part.length <= 1900 && part.isWellFormed() && part.startsWith("```js\n") && part.endsWith("```")));
});

test("splitting handles multiple fences and surrounding prose", () => {
  const text = `${"intro\n".repeat(400)}\`\`\`js\n${"code\n".repeat(800)}\`\`\`\n${"outro\n".repeat(400)}~~~txt\n${"other\n".repeat(400)}~~~\n`;
  const parts = splitDiscordText(text);
  assert.ok(parts.every((part) => part.length <= 1900));
  assert.equal(parts.map((part) => (part.match(/^code$/gm) ?? []).length).reduce((a, b) => a + b, 0), 800);
  assert.equal(parts.map((part) => (part.match(/^other$/gm) ?? []).length).reduce((a, b) => a + b, 0), 400);
});

test("request keys and delivery nonces are deterministic, bounded, and distinguish parts", () => {
  assert.equal(requestKey("request"), createHash("sha256").update("request").digest("hex").slice(0, 24));
  assert.match(requestKey("request"), /^[a-f0-9]{24}$/);
  const nonce = deliveryNonce("secret-like-key".repeat(100), 0);
  assert.match(nonce, /^[a-f0-9]{25}$/);
  assert.equal(nonce, deliveryNonce("secret-like-key".repeat(100), 0));
  assert.notEqual(nonce, deliveryNonce("secret-like-key".repeat(100), 1));
  assert.notEqual(deliveryNonce("a:1", 0), deliveryNonce("a", 1));
});

test("ensureThread reuses inbound threads without fetching", async () => {
  const f = fixture();
  assert.equal(await f.adapter.ensureThread(inbound({ channelId: "unfetched", parentChannelId: "parent" }), "Title"), "unfetched");
});

test("ensureThread creates once, reuses the starter ID, and recovers a lost create response", async () => {
  for (const lostResponse of [false, true]) {
    const f = fixture();
    let starts = 0;
    f.channels.set("parent", {
      isTextBased: () => true,
      messages: { fetch: async () => ({
        startThread: async (options: { name: string }) => {
          starts++;
          assert.ok(options.name.length <= 100);
          const thread = { ...f.thread, id: "starter" };
          f.channels.set("starter", thread);
          if (lostResponse) throw new Error("response lost");
          return thread;
        },
      }) },
    });
    assert.equal(await f.adapter.ensureThread(inbound(), "a".repeat(120)), "starter");
    assert.equal(await f.adapter.ensureThread(inbound(), "Title"), "starter");
    assert.equal(starts, 1);
  }
});

test("upsertText edits saved messages, recreates missing ones, and removes surplus owned messages", async () => {
  const f = fixture();
  f.addMessage("saved", "before");
  f.addMessage("surplus", "old tail");
  const ids = await f.adapter.upsertText("thread", "delivery", "a".repeat(1901), ["saved", "missing", "surplus"]);
  assert.deepEqual(ids, ["saved", "sent-1"]);
  assert.deepEqual(f.deleted, ["surplus"]);
  assert.equal(f.edited[0]?.options.content, "a".repeat(1900));
  assert.deepEqual(f.edited[0]?.options.allowedMentions, noMentions);
  assert.deepEqual(f.sent[0]?.allowedMentions, noMentions);
  assert.equal(f.sent[0]?.enforceNonce, true);
  await f.adapter.upsertText("thread", "delivery", "", ids);
  assert.deepEqual(f.deleted, ["surplus", "saved", "sent-1"]);
});

test("upsertText deduplicates retries and reconciles changed text returned by a nonce", async () => {
  const f = fixture();
  const first = await f.adapter.upsertText("thread", "delivery", "before", []);
  assert.deepEqual(await f.adapter.upsertText("thread", "delivery", "after", []), first);
  assert.equal(f.messages.size, 1);
  assert.equal(f.messages.get(first[0]!)?.content, "after");
  assert.equal(f.sent[0]?.nonce, f.sent[1]?.nonce);
  assert.deepEqual(f.edited[0]?.options.allowedMentions, noMentions);
});

test("outgoing text, captions, and requests display local links as paths while preserving web links", async () => {
  const f = fixture();
  const text = "Open [t3-discord](/Users/example/projects/t3-discord) and [docs](https://example.com/docs).";
  const expected = "Open `/Users/example/projects/t3-discord` and [docs](https://example.com/docs).";
  f.addMessage("legacy", text);
  await f.adapter.upsertText("thread", "local-link", text, ["legacy"]);
  assert.equal(f.messages.get("legacy")?.content, expected);
  await f.adapter.sendFile("thread", "caption", "page.html", new Uint8Array(), text);
  assert.equal(f.sent[0]?.content, expected);
  await f.adapter.request("thread", { id: "local-approval", kind: "approval", text });
  assert.ok(f.sent[1]?.content?.endsWith(expected));
  assert.deepEqual(f.sent[1]?.allowedMentions, noMentions);
});

test("a deleted saved message gets a fresh deterministic replacement nonce", async () => {
  const f = fixture();
  const first = await f.adapter.upsertText("thread", "delivery", "before", []);
  f.messages.delete(first[0]!);
  const replacement = await f.adapter.upsertText("thread", "delivery", "after", first);
  assert.notDeepEqual(replacement, first);
  assert.notEqual(f.sent[0]?.nonce, f.sent[1]?.nonce);
  assert.deepEqual(await f.adapter.upsertText("thread", "delivery", "after", first), replacement);
});

test("upsertText refuses other authors and propagates errors other than Unknown Message", async () => {
  const f = fixture();
  f.addMessage("foreign", "other person's message", "human");
  await assert.rejects(f.adapter.upsertText("thread", "delivery", "edit", ["foreign"]), /another author/);
  await assert.rejects(f.adapter.upsertText("thread", "delivery", "", ["foreign"]), /another author/);
  assert.equal(f.edited.length, 0);
  assert.equal(f.deleted.length, 0);
  f.addMessage("owned", "old");
  const forbidden = { code: 50013 };
  f.failEdit(forbidden);
  await assert.rejects(f.adapter.upsertText("thread", "delivery", "new", ["owned"]), (error) => error === forbidden);
  assert.equal(f.sent.length, 0);
  f.failSend(forbidden);
  await assert.rejects(f.adapter.upsertText("thread", "delivery", "new", []), (error) => error === forbidden);
});

test("sendFile uploads bytes with bounded caption, safe mentions, and retry deduplication", async () => {
  const f = fixture();
  const bytes = Uint8Array.from([0, 128, 255]);
  const id = await f.adapter.sendFile("thread", "file-key", "result.bin", bytes, "x".repeat(2100));
  assert.equal(await f.adapter.sendFile("thread", "file-key", "result.bin", bytes, "caption"), id);
  const options = f.sent[0]!;
  assert.ok(options.content!.length <= 2000);
  assert.deepEqual(options.allowedMentions, noMentions);
  assert.equal(options.enforceNonce, true);
  const attachment = options.files![0];
  assert.ok(attachment instanceof AttachmentBuilder);
  assert.deepEqual(attachment.attachment, Buffer.from(bytes));
  assert.equal(attachment.name, "result.bin");
});

test("requests have bounded text and approval buttons; questions explain !answer and list ids/options", async () => {
  const f = fixture();
  await f.adapter.request("thread", { id: "approval", kind: "approval", text: "x".repeat(3000) });
  const approval = f.sent[0]!;
  assert.equal(approval.content!.length, 2000);
  const row = approval.components![0]!;
  assert.ok("toJSON" in row);
  const data = row.toJSON();
  assert.ok("components" in data);
  assert.deepEqual(data.components.map((button) => "custom_id" in button ? button.custom_id : null), [
    `t3:approve:${requestKey("approval")}`, `t3:deny:${requestKey("approval")}`,
  ]);
  await f.adapter.request("thread", {
    id: "question", kind: "question", text: "Choose a target.".repeat(300),
    questions: [{ id: "target", question: "Which target?", options: [{ label: "Production", value: "prod" }, { label: "Development" }] }],
  });
  const question = f.sent[1]!;
  assert.ok(question.content!.length <= 2000);
  assert.match(question.content!, /!answer <text>/);
  assert.match(question.content!, /target: Which target\?/);
  assert.match(question.content!, /Production \(prod\)/);
  assert.match(question.content!, /Development/);
  assert.deepEqual(question.components, []);
  assert.deepEqual(question.allowedMentions, noMentions);
});

function eventMessage(overrides: Record<string, unknown> = {}): ClientEvents[Events.MessageCreate][0] {
  return {
    id: "message", channelId: "parent", inGuild: () => true,
    author: { id: "user", bot: false, username: "username", globalName: "Global" },
    member: { displayName: "Nickname" }, webhookId: null, system: false,
    content: "hello", channel: { isThread: () => false }, attachments: new Map(), ...overrides,
  } as unknown as ClientEvents[Events.MessageCreate][0];
}

test("client normalizes configured parent and thread messages, including attachment-only input", async (t) => {
  const received: InboundMessage[] = [];
  const client = createDiscordClient({ routes: [{ channelId: "parent", projectId: "project" }], allowedUserIds: ["user"] }, {
    onMessage: async (message) => { received.push(message); }, onDecision: async () => "ok",
  });
  t.after(() => client.destroy());
  assert.ok(client.options.intents.has(GatewayIntentBits.MessageContent));
  assert.equal(client.isReady(), false);
  client.emit(Events.MessageCreate, eventMessage());
  client.emit(Events.MessageCreate, eventMessage({
    channelId: "child", content: "", channel: { isThread: () => true, parentId: "parent" },
    attachments: new Map([["file", { name: "file.bin", contentType: null, size: 3, url: "https://cdn.discordapp.com/file" }]]),
  }));
  assert.equal(received.length, 2);
  assert.equal(received[0]?.authorName, "Nickname");
  assert.equal(received[0]?.parentChannelId, null);
  assert.equal(received[1]?.parentChannelId, "parent");
  assert.deepEqual(received[1]?.attachments, [{ name: "file.bin", mimeType: "application/octet-stream", sizeBytes: 3, url: "https://cdn.discordapp.com/file" }]);
});

test("client ignores bots, webhooks, DMs, system messages, unlisted users, and unrelated routes", async (t) => {
  const received: InboundMessage[] = [];
  const client = createDiscordClient({ routes: [{ channelId: "parent", projectId: "project" }], allowedUserIds: ["user"] }, {
    onMessage: async (message) => { received.push(message); }, onDecision: async () => "ok",
  });
  t.after(() => client.destroy());
  for (const overrides of [
    { author: { id: "user", bot: true } }, { webhookId: "webhook" }, { inGuild: () => false },
    { system: true }, { author: { id: "stranger", bot: false } }, { channelId: "elsewhere" },
    { channelId: "child", channel: { isThread: () => true, parentId: "elsewhere" } },
  ]) client.emit(Events.MessageCreate, eventMessage(overrides));
  assert.deepEqual(received, []);
});

function button(overrides: Record<string, unknown> = {}) {
  const deferred: unknown[] = [];
  const replies: Array<{ content: string; allowedMentions: unknown }> = [];
  const completed = Promise.withResolvers<void>();
  const interaction = {
    isButton: () => true, inGuild: () => true, user: { id: "user" }, channelId: "child",
    channel: { isThread: () => true, parentId: "parent" },
    customId: `t3:approve:${requestKey("approval")}`, message: { author: { id: "bot" } },
    deferReply: async (options: unknown) => { deferred.push(options); },
    editReply: async (options: { content: string; allowedMentions: unknown }) => { replies.push(options); completed.resolve(); },
    ...overrides,
  } as unknown as Interaction;
  return { interaction, deferred, replies, completed: completed.promise };
}

test("approval buttons defer ephemerally and deliver only explicit authorized decisions", async (t) => {
  const decisions: DiscordDecision[] = [];
  const client = createDiscordClient({ routes: [{ channelId: "parent", projectId: "project" }], allowedUserIds: ["user"] }, {
    onMessage: async () => {}, onDecision: async (decision) => { decisions.push(decision); return "Recorded"; },
  });
  t.after(() => client.destroy());
  Object.defineProperty(client, "user", { value: { id: "bot" } });
  for (const action of ["approve", "deny"]) {
    const click = button({ customId: `t3:${action}:${requestKey("approval")}` });
    client.emit(Events.InteractionCreate, click.interaction);
    assert.deepEqual(click.deferred, [{ flags: MessageFlags.Ephemeral }]);
    await click.completed;
    assert.deepEqual(click.replies, [{ content: "Recorded", allowedMentions: noMentions }]);
  }
  assert.deepEqual(decisions, [
    { threadId: "child", requestKey: requestKey("approval"), decision: "approved", userId: "user" },
    { threadId: "child", requestKey: requestKey("approval"), decision: "denied", userId: "user" },
  ]);
  for (const overrides of [
    { user: { id: "stranger" } }, { inGuild: () => false }, { isButton: () => false },
    { customId: "t3:approve:bad" }, { customId: `t3:approve:${requestKey("approval")}:extra` },
    { channel: { isThread: () => true, parentId: "elsewhere" } }, { message: { author: { id: "stranger" } } },
  ]) {
    const click = button(overrides);
    client.emit(Events.InteractionCreate, click.interaction);
    assert.deepEqual(click.deferred, []);
  }
  assert.equal(decisions.length, 2);
});

test("interaction failures return a generic response without exposing handler errors", async (t) => {
  const client = createDiscordClient({ routes: [{ channelId: "parent", projectId: "project" }], allowedUserIds: ["user"] }, {
    onMessage: async () => {}, onDecision: async () => { throw new Error("secret token"); },
  });
  t.after(() => client.destroy());
  Object.defineProperty(client, "user", { value: { id: "bot" } });
  const click = button();
  client.emit(Events.InteractionCreate, click.interaction);
  await click.completed;
  assert.match(click.replies[0]!.content, /Unable to process/);
  assert.doesNotMatch(click.replies[0]!.content, /secret token/);
});
