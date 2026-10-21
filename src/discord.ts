import { createHash } from "node:crypto";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from "discord.js";
import type { Message, MessageMentionOptions } from "discord.js";
import type { BridgeConfig, DiscordPort, InboundMessage, T3Request } from "./types.ts";
import { formatDiscordText } from "./markdown.ts";

const TEXT_LIMIT = 1900;
const allowedMentions: MessageMentionOptions = { parse: [], repliedUser: false };

export function requestKey(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 24);
}

export function deliveryNonce(key: string, part: number): string {
  return createHash("sha256").update(JSON.stringify([key, part])).digest("hex").slice(0, 25);
}

interface Fence {
  marker: string;
  opener: string;
}

function fenceAfter(line: string, fence: Fence | null): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(line);
  if (!match) return fence;
  const marker = match[1]!;
  const info = match[2]!;
  if (fence) {
    return marker[0] === fence.marker[0] && marker.length >= fence.marker.length && !info.trim()
      ? null
      : fence;
  }
  // Leave room for both the reopened fence and actual content in the next message.
  return line.length <= 400 ? { marker, opener: line.trimEnd() } : null;
}

function closingFence(content: string, fence: Fence | null): string {
  return fence ? `${content.endsWith("\n") ? "" : "\n"}${fence.marker}` : "";
}

function splitBoundary(text: string, limit: number): number {
  let end = Math.min(text.length, limit);
  const space = text.lastIndexOf(" ", end - 1);
  if (space >= end / 2) end = space + 1;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return end;
}

/** Close and reopen fenced blocks so each Discord message is readable on its own. */
export function splitDiscordText(text: string): string[] {
  if (!text.trim()) return [];
  if (text.length <= TEXT_LIMIT) return [text];
  const parts: string[] = [];
  let fence: Fence | null = null;
  let content = "";
  let hasContent = false;
  const flush = () => {
    if (!hasContent) return;
    parts.push(content + closingFence(content, fence));
    content = fence ? `${fence.opener}\n` : "";
    hasContent = false;
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const nextFence = fenceAfter(line, fence);
    let rest = line;
    while (content.length + rest.length + closingFence(content + rest, nextFence).length > TEXT_LIMIT) {
      if (hasContent) {
        flush();
        continue;
      }
      const room = TEXT_LIMIT - content.length - (fence ? fence.marker.length + 1 : 0);
      const end = splitBoundary(rest, room);
      content += rest.slice(0, end);
      rest = rest.slice(end);
      hasContent = true;
      flush();
    }
    content += rest;
    hasContent = true;
    fence = nextFence;
  }
  flush();
  return parts;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit - 1;
  const previous = text.charCodeAt(end - 1);
  if (previous >= 0xd800 && previous <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

function hasCode(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export class DiscordAdapter implements DiscordPort {
  private readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  private async thread(threadId: string) {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel?.isThread() || !channel.isSendable()) throw new Error("Discord thread is unavailable.");
    return channel;
  }

  private async existingThread(starterId: string, parentId: string) {
    try {
      const channel = await this.client.channels.fetch(starterId, { force: true });
      return channel?.isThread() && channel.parentId === parentId ? channel : null;
    } catch (error) {
      if (hasCode(error, 10003)) return null;
      throw error;
    }
  }

  async ensureThread(message: InboundMessage, title: string): Promise<string> {
    if (message.parentChannelId) return message.channelId;
    const parent = await this.client.channels.fetch(message.channelId);
    if (!parent?.isTextBased() || !("messages" in parent)) {
      throw new Error("Discord starter channel is unavailable.");
    }
    const starter = await parent.messages.fetch({ message: message.id, force: true });
    const existing = await this.existingThread(message.id, message.channelId);
    if (existing) return existing.id;
    try {
      const thread = await starter.startThread({ name: truncate(title.trim() || "T3 Code", 100) });
      return thread.id;
    } catch (error) {
      // Discord uses the starter's ID, including when another attempt won the race.
      const thread = await this.existingThread(message.id, message.channelId).catch(() => null);
      if (thread) return thread.id;
      throw error;
    }
  }

  private assertOwned(message: Message) {
    if (!this.client.user || message.author.id !== this.client.user.id) {
      throw new Error("Refusing to change a Discord message owned by another author.");
    }
  }

  async upsertText(threadId: string, deliveryKey: string, text: string, existingMessageIds: string[]): Promise<string[]> {
    const thread = await this.thread(threadId);
    const parts = splitDiscordText(formatDiscordText(text));
    const ids: string[] = [];
    for (const [part, content] of parts.entries()) {
      const existingId = existingMessageIds[part];
      if (existingId) {
        try {
          const message = await thread.messages.fetch({ message: existingId, force: true });
          this.assertOwned(message);
          await message.edit({ content, allowedMentions });
          ids.push(message.id);
          continue;
        } catch (error) {
          if (!hasCode(error, 10008)) throw error;
        }
      }
      // A deleted saved message must not reuse the nonce of its original send.
      const nonce = deliveryNonce(JSON.stringify([threadId, "text", deliveryKey, existingId ?? null]), part);
      const message = await thread.send({ content, allowedMentions, nonce, enforceNonce: true });
      this.assertOwned(message);
      // Nonce deduplication returns the original content after a lost response.
      if (message.content !== content) await message.edit({ content, allowedMentions });
      ids.push(message.id);
    }
    for (const id of existingMessageIds.slice(parts.length)) {
      try {
        const message = await thread.messages.fetch({ message: id, force: true });
        this.assertOwned(message);
        await message.delete();
      } catch (error) {
        if (!hasCode(error, 10008)) throw error;
      }
    }
    return ids;
  }

  async sendFile(threadId: string, deliveryKey: string, name: string, bytes: Uint8Array, caption: string): Promise<string> {
    const thread = await this.thread(threadId);
    const message = await thread.send({
      ...(caption.trim() ? { content: truncate(formatDiscordText(caption), 2000) } : {}),
      files: [new AttachmentBuilder(Buffer.from(bytes), { name })],
      allowedMentions,
      nonce: deliveryNonce(JSON.stringify([threadId, "file", deliveryKey]), 0),
      enforceNonce: true,
    });
    return message.id;
  }

  async request(threadId: string, request: T3Request): Promise<string> {
    const thread = await this.thread(threadId);
    const key = requestKey(request.id);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`t3:approve:${key}`).setLabel("Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`t3:deny:${key}`).setLabel("Deny").setStyle(ButtonStyle.Danger),
    );
    const content = request.kind === "approval"
      ? `T3 approval pending — choose Approve or Deny below.\n\n${request.text}`
      : `T3 question pending — reply with !answer <text>. Include question ids for multiple answers.\n\n${
        (request.questions ?? []).map((question) => `${question.id}: ${question.question}${
          question.options.length ? `\n${question.options.map((option) => `- ${option.label}${option.value && option.value !== option.label ? ` (${option.value})` : ""}`).join("\n")}` : ""
        }`).join("\n\n")
      }\n\n${request.text}`;
    const message = await thread.send({
      content: truncate(formatDiscordText(content), 2000),
      components: request.kind === "approval" ? [row] : [],
      allowedMentions,
      nonce: deliveryNonce(JSON.stringify([threadId, "request", request.id]), 0),
      enforceNonce: true,
    });
    return message.id;
  }
}

export interface DiscordDecision {
  threadId: string;
  requestKey: string;
  decision: "approved" | "denied";
  userId: string;
}

export interface DiscordHandlers {
  onMessage(message: InboundMessage): Promise<void>;
  onDecision(decision: DiscordDecision): Promise<string>;
}

export function createDiscordClient(
  config: Pick<BridgeConfig, "routes" | "allowedUserIds">,
  handlers: DiscordHandlers,
): Client {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  const users = new Set(config.allowedUserIds);
  const parents = new Set(config.routes.map((route) => route.channelId));
  const routed = (channelId: string, parentId: string | null) => parents.has(parentId ?? channelId);

  client.on(Events.MessageCreate, (message) => {
    if (!message.inGuild() || message.author.bot || message.webhookId || message.system || !users.has(message.author.id)) return;
    const parentChannelId = message.channel.isThread() ? message.channel.parentId : null;
    if (!routed(message.channelId, parentChannelId)) return;
    const inbound: InboundMessage = {
      id: message.id,
      channelId: message.channelId,
      parentChannelId,
      authorId: message.author.id,
      authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
      text: message.content,
      attachments: [...message.attachments.values()].map((attachment) => ({
        name: attachment.name,
        mimeType: attachment.contentType ?? "application/octet-stream",
        sizeBytes: attachment.size,
        url: attachment.url,
      })),
    };
    void handlers.onMessage(inbound).catch(() => console.error("Discord message handler failed."));
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isButton() || !interaction.inGuild() || !users.has(interaction.user.id)) return;
    const match = /^t3:(approve|deny):([a-f0-9]{24})$/.exec(interaction.customId);
    if (!match) return;
    const respond = async () => {
      const channel = interaction.channel ?? await client.channels.fetch(interaction.channelId);
      if (!channel) return;
      const parentId = channel.isThread() ? channel.parentId : null;
      if (!routed(interaction.channelId, parentId)) return;
      if (!client.user || interaction.message.author.id !== client.user.id) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let content: string;
      try {
        content = await handlers.onDecision({
          threadId: interaction.channelId,
          requestKey: match[2]!,
          decision: match[1] === "approve" ? "approved" : "denied",
          userId: interaction.user.id,
        });
      } catch {
        content = "Unable to process this response. Please try again.";
      }
      await interaction.editReply({ content: truncate(content.trim() || "Response recorded.", 2000), allowedMentions });
    };
    void respond().catch(() => console.error("Discord interaction handler failed."));
  });

  client.on(Events.Error, () => console.error("Discord client error."));
  return client;
}
