import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InboundMessage, T3Port, T3Request } from "./types.ts";

export interface Binding {
  discordThreadId: string;
  channelId: string;
  projectId: string;
  t3ThreadId: string;
  initialMessageId: string;
  ready: boolean;
  sequence: number;
  discordContextVersion?: number;
}
export interface Delivery { ids: string[]; digest: string }
export type TextResponse = { threadId: string; requestId: string; response: Parameters<T3Port["respond"]>[2] } | { notice: string };

export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bindings (
        discord_thread TEXT PRIMARY KEY, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY, t3_message TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        key TEXT PRIMARY KEY, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS text_responses (
        message_id TEXT PRIMARY KEY, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        thread TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        announced INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
        responded INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(thread, id)
      );
    `);
  }
  close() { this.db.close(); }
  bindings(): Binding[] {
    return this.db.prepare("SELECT payload FROM bindings").all().map(row => JSON.parse(String(row.payload)) as Binding);
  }
  binding(thread: string): Binding | undefined {
    const row = this.db.prepare("SELECT payload FROM bindings WHERE discord_thread=?").get(thread);
    return row ? JSON.parse(String(row.payload)) as Binding : undefined;
  }
  putBinding(binding: Binding) {
    this.db.prepare("INSERT INTO bindings VALUES (?,?) ON CONFLICT(discord_thread) DO UPDATE SET payload=excluded.payload")
      .run(binding.discordThreadId, JSON.stringify(binding));
  }
  enqueue(message: InboundMessage, t3MessageId: string) {
    this.db.prepare("INSERT OR IGNORE INTO inbox(id,t3_message,payload) VALUES (?,?,?)").run(message.id, t3MessageId, JSON.stringify(message));
  }
  hasT3Message(id: string): boolean { return this.db.prepare("SELECT 1 FROM inbox WHERE t3_message=?").get(id) !== undefined; }
  pending(): InboundMessage[] {
    return this.db.prepare("SELECT payload FROM inbox WHERE delivered=0 ORDER BY rowid").all()
      .map(row => JSON.parse(String(row.payload)) as InboundMessage);
  }
  delivered(id: string): boolean {
    return this.db.prepare("SELECT delivered FROM inbox WHERE id=?").get(id)?.delivered === 1;
  }
  complete(id: string) { this.db.prepare("UPDATE inbox SET delivered=1 WHERE id=?").run(id); }
  textResponse(messageId: string): TextResponse | undefined {
    const row = this.db.prepare("SELECT payload FROM text_responses WHERE message_id=?").get(messageId);
    return row ? JSON.parse(String(row.payload)) as TextResponse : undefined;
  }
  saveTextResponse(messageId: string, response: TextResponse): TextResponse {
    this.db.prepare("INSERT OR IGNORE INTO text_responses VALUES (?,?)").run(messageId, JSON.stringify(response));
    return this.textResponse(messageId)!;
  }
  delivery(key: string): Delivery | undefined {
    const row = this.db.prepare("SELECT payload FROM deliveries WHERE key=?").get(key);
    return row ? JSON.parse(String(row.payload)) as Delivery : undefined;
  }
  putDelivery(key: string, delivery: Delivery) {
    this.db.prepare("INSERT INTO deliveries VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload")
      .run(key, JSON.stringify(delivery));
  }
  setRequests(thread: string, requests: T3Request[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE requests SET active=0 WHERE thread=?").run(thread);
      for (const request of requests) {
        this.db.prepare(`INSERT INTO requests(thread,id,payload) VALUES (?,?,?)
          ON CONFLICT(thread,id) DO UPDATE SET payload=excluded.payload,active=CASE WHEN requests.responded=0 THEN 1 ELSE 0 END`)
          .run(thread, request.id, JSON.stringify(request));
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  requests(thread: string): Array<{ request: T3Request; announced: boolean }> {
    return this.db.prepare("SELECT payload,announced FROM requests WHERE thread=? AND active=1 ORDER BY rowid").all(thread)
      .map(row => ({ request: JSON.parse(String(row.payload)) as T3Request, announced: row.announced === 1 }));
  }
  announced(thread: string, id: string) {
    this.db.prepare("UPDATE requests SET announced=1 WHERE thread=? AND id=?").run(thread, id);
  }
  resolveRequest(thread: string, id: string) {
    this.db.prepare("UPDATE requests SET active=0,responded=1 WHERE thread=? AND id=?").run(thread, id);
  }
}
