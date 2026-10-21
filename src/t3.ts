import WebSocket from "ws";
import type { Attachment, InboundAttachment, ModelSelection, T3Port, T3Project, T3Request, T3ThreadState } from "./types.ts";

type Row = Record<string, unknown>;
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const str = (value: unknown): string => typeof value === "string" ? value : "";
function required(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Invalid T3 response.");
  return value;
}
function origin(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Invalid T3 URL."); }
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid T3 URL.");
  if (parsed.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))
    throw new Error("Use HTTPS for a remote T3 environment, or HTTP on localhost.");
  return new URL(parsed.origin);
}
async function transfer(url: URL, init: RequestInit, label: string, limit = MAX_BYTES): Promise<Uint8Array> {
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`${label} failed (HTTP ${response.status}).`); }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
      await response.body?.cancel();
      throw new Error(`${label} exceeds the byte limit.`);
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) throw new Error(`${label} exceeds the byte limit.`);
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    // Fetch and websocket errors can contain signed URLs or credentials.
    if (error instanceof Error && (error.message === `${label} exceeds the byte limit.` || new RegExp(`^${label} failed \\(HTTP \\d+\\)\\.$`).test(error.message))) throw error;
    throw new Error(`${label} failed.`);
  }
}
async function json(url: URL, init: RequestInit, label: string): Promise<Row> {
  const bytes = await transfer(url, init, label, 4 * 1024 * 1024);
  try { return row(JSON.parse(new TextDecoder().decode(bytes))); } catch { throw new Error(`Invalid ${label} response.`); }
}
async function checkVersion(base: URL, signal?: AbortSignal): Promise<void> {
  const metadata = await json(new URL("/.well-known/t3/environment", base), { signal }, "T3 discovery");
  if (metadata.orchestrationProtocolVersion !== 2) throw new Error("This bridge requires T3 orchestration protocol V2.");
}
export async function exchangePairing(url: string, credential: string): Promise<{ token: string; expiresAt: string }> {
  const base = origin(url);
  await checkVersion(base);
  const response = await json(new URL("/oauth/token", base), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: credential, subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap", requested_token_type: "urn:ietf:params:oauth:token-type:access_token", scope: "orchestration:read orchestration:operate", client_label: "T3 Discord bridge", client_device_type: "bot" }),
  }, "T3 pairing");
  const granted = new Set(str(response.scope).split(/\s+/));
  if (!granted.has("orchestration:read") || !granted.has("orchestration:operate")) throw new Error("T3 pairing must grant orchestration:read and orchestration:operate.");
  if (typeof response.expires_in !== "number" || !Number.isFinite(response.expires_in) || response.expires_in <= 0) throw new Error("Invalid T3 token expiry.");
  return { token: required(response.access_token), expiresAt: new Date(Date.now() + response.expires_in * 1000).toISOString() };
}
function attachment(value: Row): Attachment | null {
  if (!str(value.id) || !["image", "file"].includes(str(value.type))) return null;
  return { id: str(value.id), type: value.type === "image" ? "image" : "file", name: str(value.name), mimeType: str(value.mimeType), sizeBytes: typeof value.sizeBytes === "number" ? value.sizeBytes : 0 };
}
function toolResult(value: unknown, depth = 0, budget = { bytes: 1_048_576, nodes: 256 }): { data: Row; failed: boolean } {
  if (++depth > 12 || --budget.nodes < 0) return { data: {}, failed: true };
  if (typeof value === "string") {
    budget.bytes -= value.length;
    if (budget.bytes < 0) return { data: {}, failed: true };
    try { return toolResult(JSON.parse(value), depth, budget); } catch { return { data: {}, failed: false }; }
  }
  if (Array.isArray(value)) {
    let data: Row = {}, failed = false;
    if (value.length > 256) return { data, failed: true };
    for (const block of value) {
      const nested = toolResult(row(block).text, depth, budget);
      if (!Object.keys(data).length) data = nested.data;
      failed ||= nested.failed;
    }
    return { data, failed };
  }
  const data = row(value);
  const failed = data.isError === true || data.is_error === true || data.error != null || data._tag === "OrchestratorMcpFailure";
  if (data.structuredContent !== undefined || data.content !== undefined) {
    const nested = toolResult(data.structuredContent ?? data.content, depth, budget);
    return { data: nested.data, failed: failed || nested.failed };
  }
  return { data, failed };
}
function rpcError(exit: Row): Error {
  // Only contract error discriminants are safe to expose. Cause/message may echo input.
  const tags = new Set<string>();
  const inspect = (value: unknown, depth: number): void => {
    if (depth > 8) return;
    if (Array.isArray(value)) { for (const part of value.slice(0, 32)) inspect(part, depth + 1); return; }
    const part = row(value);
    if (typeof part._tag === "string" && /^[A-Za-z][A-Za-z0-9]{0,100}(?:Error|Failure)$/.test(part._tag) && part._tag !== "Failure") tags.add(part._tag);
    for (const key of ["error", "defect", "cause", "reasons", "left", "right"]) if (part[key] !== undefined) inspect(part[key], depth + 1);
  };
  inspect(exit.cause, 0);
  return new Error(`T3 RPC failed${tags.size ? ` (${[...tags].join(", ")})` : ""}.`);
}
function normalize(threadId: string, sequence: number, projection: Row): T3ThreadState {
  const messages = rows(projection.messages).filter(m => m.role === "assistant" || m.role === "user").map(m => ({ id: str(m.id), role: m.role as "assistant" | "user", text: str(m.text), runId: typeof m.runId === "string" ? m.runId : null, status: m.streaming === true ? "in_progress" : "completed", attachments: rows(m.attachments).map(attachment).filter(a => a !== null) }));
  const turnItems = rows(projection.turnItems);
  const requests: T3Request[] = [];
  for (const request of rows(projection.runtimeRequests)) {
    if (request.status !== "pending" || row(request.responseCapability).type === "not_resumable") continue;
    const item = turnItems.findLast(item => item.requestId === request.id);
    if (request.kind === "user_input") {
      if (!item || item.type !== "user_input_request") continue;
      const questions = rows(item.questions).map(q => ({ id: str(q.id), question: str(q.question), options: rows(q.options).map(o => ({ label: str(o.label), value: str(o.value) || str(o.label) })) }));
      requests.push({ id: str(request.id), kind: "question", text: questions.map(q => q.question).join("\n"), questions });
    } else if (["command", "file-read", "file-change", "mcp-elicitation", "permission"].includes(str(request.kind))) {
      requests.push({ id: str(request.id), kind: "approval", text: str(item?.prompt) || `Approval required: ${str(request.kind)}` });
    }
  }
  const artifacts = new Map<string, T3ThreadState["artifacts"][number]>();
  for (const item of turnItems) {
    if (item.type !== "dynamic_tool" || item.status !== "completed" || !/^(?:html_render|t3-code[._]html_render|mcp__t3[-_]code__html_render)$/.test(str(item.toolName))) continue;
    const output = toolResult(item.output);
    if (output.failed) continue;
    const reference = row(output.data.htmlRender);
    if (typeof reference.attachmentId !== "string" || !reference.attachmentId || reference.attachmentId.length > 256 || typeof reference.title !== "string" || typeof reference.height !== "number" || !Number.isFinite(reference.height)) continue;
    artifacts.set(reference.attachmentId, { id: reference.attachmentId, title: reference.title.trim().slice(0, 200) || "HTML", mimeType: "text/html" });
  }
  return { threadId, title: str(row(projection.thread).title), sequence, messages, runs: rows(projection.runs).map(r => ({ id: str(r.id), status: str(r.status) })), requests, artifacts: [...artifacts.values()] };
}
const EVENT_COLLECTIONS: Record<string, string> = {
  "run.created": "runs", "run.updated": "runs", "run-attempt.created": "attempts", "run-attempt.updated": "attempts", "node.updated": "nodes", "subagent.updated": "subagents", "provider-session.attached": "providerSessions", "provider-session.updated": "providerSessions", "provider-thread.updated": "providerThreads", "provider-turn.updated": "providerTurns", "runtime-request.updated": "runtimeRequests", "message.updated": "messages", "turn-item.updated": "turnItems", "turn-item.upserted": "turnItems", "plan.updated": "plans", "checkpoint-scope.created": "checkpointScopes", "checkpoint.captured": "checkpoints", "context-handoff.updated": "contextHandoffs", "context-transfer.created": "contextTransfers", "context-transfer.updated": "contextTransfers",
};
function applyEvent(projection: Row, event: Row): boolean {
  const type = str(event.type), payload = row(event.payload);
  if (type.startsWith("thread.") && str(payload.id) === str(row(projection.thread).id)) { projection.thread = payload; return true; }
  const key = EVENT_COLLECTIONS[type];
  if (!key) return false;
  const list = rows(projection[key]);
  const index = list.findIndex(item => item.id === payload.id);
  if (index < 0) list.push(payload); else list[index] = payload;
  projection[key] = list;
  return true;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface Watch {
  threadId: string;
  sequence: number | null;
  projection: Row | null;
  callback(state: T3ThreadState): Promise<void>;
  requestId: string | null;
  active: boolean;
  queue: Array<{ state: T3ThreadState; coalescible: boolean }>;
  draining: boolean;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  subscriptionTimer?: ReturnType<typeof setTimeout>;
  lastDelivery: number;
  lastQueuedSequence?: number;
  ready: boolean;
  resolve(): void;
  reject(error: Error): void;
  startupTimer?: ReturnType<typeof setTimeout>;
}

export class T3Client implements T3Port {
  private readonly base: URL;
  private readonly token: string;
  private readonly onError: (error: unknown) => void;
  private readonly controller = new AbortController();
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private nextId = 0;
  private pending = new Map<string, Pending>();
  private watches = new Set<Watch>();
  private subscriptions = new Map<string, Watch>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelay = 500;
  private lastFrame = 0;

  constructor(options: { url: string; token: string; onError?: (error: unknown) => void }) {
    this.base = origin(options.url);
    this.token = options.token;
    this.onError = options.onError ?? (() => {});
  }
  private report(error: Error): void { try { this.onError(error); } catch {} }
  private auth(): Record<string, string> { return { authorization: `Bearer ${this.token}` }; }
  private signedUrl(value: unknown): URL {
    const relative = required(value);
    let url: URL;
    try { url = new URL(relative, this.base); } catch { throw new Error("Invalid T3 asset URL."); }
    if (!relative.startsWith("/") || url.origin !== this.base.origin || url.username || url.password || url.hash) throw new Error("Invalid T3 asset URL.");
    return url;
  }
  async connect(): Promise<void> {
    if (this.closed) throw new Error("T3 client is closed.");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  private async open(): Promise<void> {
    await checkVersion(this.base, this.controller.signal);
    const response = await json(new URL("/api/auth/websocket-ticket", this.base), { method: "POST", headers: this.auth(), signal: this.controller.signal }, "T3 websocket ticket");
    if (this.closed) throw new Error("T3 client is closed.");
    const url = new URL("/ws", this.base);
    url.protocol = this.base.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({ wsTicket: required(response.ticket), orchestrationProtocol: "2" }).toString();
    const socket = new WebSocket(url, { handshakeTimeout: TIMEOUT_MS, maxPayload: 32 * 1024 * 1024 });
    this.socket = socket;
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error("T3 websocket connection timed out.")); }, TIMEOUT_MS);
      const fail = () => { clearTimeout(timer); reject(new Error("T3 websocket connection failed.")); };
      socket.once("error", fail);
      socket.once("close", fail);
      socket.once("open", () => {
        clearTimeout(timer); socket.off("error", fail); socket.off("close", fail);
        if (this.closed) { socket.terminate(); reject(new Error("T3 client is closed.")); return; }
        this.lastFrame = Date.now();
        socket.on("message", data => {
          if (socket !== this.socket) return;
          try {
            const decoded: unknown = JSON.parse(data.toString());
            for (const frame of Array.isArray(decoded) ? decoded : [decoded]) this.frame(row(frame), socket);
          } catch { this.report(new Error("Invalid T3 websocket frame.")); socket.terminate(); }
        });
        socket.once("close", () => this.disconnected(socket));
        clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.lastFrame >= 15_000) { this.report(new Error("T3 websocket heartbeat timed out.")); socket.terminate(); }
          else if (socket.readyState === WebSocket.OPEN) {
            try { this.write({ _tag: "Ping" }); } catch { socket.terminate(); }
          }
        }, 5_000);
        for (const watch of this.watches) if (watch.projection !== null || watch.sequence === null) this.subscribe(watch);
        resolve();
      });
    });
  }
  private write(frame: Row): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("T3 websocket is disconnected.");
    const socket = this.socket;
    socket.send(JSON.stringify(frame), error => {
      if (error && this.socket === socket) { this.report(new Error("T3 websocket send failed.")); socket.terminate(); }
    });
  }
  private disconnected(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("T3 websocket disconnected.")); }
    this.pending.clear();
    this.subscriptions.clear();
    for (const watch of this.watches) watch.requestId = null;
    this.scheduleReconnect();
  }
  private scheduleReconnect(): void {
    if (this.closed || !this.watches.size || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => { this.report(new Error("T3 reconnect failed.")); this.scheduleReconnect(); });
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2);
  }
  async rpc(tag: string, payload: unknown): Promise<unknown> {
    await this.connect();
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { this.write({ _tag: "Interrupt", requestId: id }); } catch {}
        reject(new Error("T3 RPC timed out."));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ _tag: "Request", id, tag, payload, headers: [] }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("T3 RPC send failed.")); }
    });
  }
  private frame(frame: Row, socket: WebSocket): void {
    this.lastFrame = Date.now();
    if (frame._tag === "Ping") { this.write({ _tag: "Pong" }); return; }
    if (frame._tag === "Pong") { this.reconnectDelay = 500; return; }
    const id = str(frame.requestId), watch = this.subscriptions.get(id);
    if (frame._tag === "Chunk") {
      if (watch) for (const value of Array.isArray(frame.values) ? frame.values : []) this.apply(watch, row(value));
      if (socket === this.socket) this.write({ _tag: "Ack", requestId: id });
    } else if (frame._tag === "Exit") {
      const exit = row(frame.exit), pending = this.pending.get(id);
      const error = rpcError(exit);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(id); if (exit._tag === "Success") pending.resolve(exit.value); else pending.reject(error); }
      if (watch) {
        this.subscriptions.delete(id); watch.requestId = null;
        const failure = exit._tag === "Success" ? new Error("T3 thread subscription ended.") : error;
        if (!watch.ready) { watch.reject(failure); this.cancel(watch); }
        else {
          this.report(failure);
          watch.subscriptionTimer = setTimeout(() => {
            watch.subscriptionTimer = undefined;
            if (!watch.active) return;
            if (this.socket?.readyState === WebSocket.OPEN) this.subscribe(watch);
            else this.scheduleReconnect();
          }, 1_000);
        }
      }
    }
  }
  private subscribe(watch: Watch): void {
    if (!watch.active || watch.requestId) return;
    clearTimeout(watch.subscriptionTimer); watch.subscriptionTimer = undefined;
    const id = String(++this.nextId);
    watch.requestId = id; this.subscriptions.set(id, watch);
    this.write({ _tag: "Request", id, tag: "orchestration.subscribeThread", payload: { threadId: watch.threadId, ...(watch.sequence === null ? {} : { afterSequence: watch.sequence }), requestCompletionMarker: true }, headers: [] });
  }
  private apply(watch: Watch, item: Row): void {
    if (!watch.active) return;
    if (item.kind === "snapshot") {
      if (typeof item.snapshotSequence !== "number") throw new Error("Invalid T3 snapshot.");
      watch.projection = row(item.projection); watch.sequence = item.snapshotSequence;
      this.notify(watch, true);
    } else if (item.kind === "synchronized") {
      this.reconnectDelay = 500;
      if (watch.projection) this.notify(watch, true);
    } else if (item.kind === "event" || item.kind === "unknown-event") {
      if (typeof item.sequence !== "number" || item.sequence <= (watch.sequence ?? -1)) return;
      const event = row(item.event);
      if (watch.projection) applyEvent(watch.projection, event);
      watch.sequence = item.sequence;
      const payload = row(event.payload);
      const immediate = event.type === "runtime-request.updated" || str(event.type).startsWith("thread.") ||
        (event.type === "message.updated" && payload.streaming !== true) ||
        ((event.type === "run.updated" || event.type === "run.created") && !["running", "queued", "starting"].includes(str(payload.status))) ||
        ((event.type === "turn-item.updated" || event.type === "turn-item.upserted") && ["completed", "approval_request", "user_input_request"].includes(str(payload.status === "completed" ? payload.status : payload.type)));
      this.notify(watch, immediate);
    }
  }
  private notify(watch: Watch, immediate: boolean): void {
    if (!watch.active || !watch.projection || watch.sequence === null) return;
    watch.dirty = true;
    if (immediate || Date.now() - watch.lastDelivery >= 1_000) this.enqueue(watch, !immediate);
    else if (!watch.timer) watch.timer = setTimeout(() => { watch.timer = undefined; this.enqueue(watch, true); }, Math.max(0, 1_000 - (Date.now() - watch.lastDelivery)));
  }
  private enqueue(watch: Watch, coalescible = false): void {
    clearTimeout(watch.timer); watch.timer = undefined;
    if (!watch.active || !watch.dirty || !watch.projection || watch.sequence === null) return;
    watch.dirty = false;
    if (watch.lastQueuedSequence === watch.sequence) return;
    watch.lastQueuedSequence = watch.sequence; watch.lastDelivery = Date.now();
    const delivery = { state: normalize(watch.threadId, watch.sequence, watch.projection), coalescible };
    const tail = watch.queue.length - 1;
    if (coalescible && watch.queue[tail]?.coalescible && !(watch.draining && tail === 0)) watch.queue[tail] = delivery;
    else watch.queue.push(delivery);
    void this.drain(watch);
  }
  private async drain(watch: Watch): Promise<void> {
    if (watch.draining || watch.retryTimer) return;
    watch.draining = true;
    try {
      while (watch.active && watch.queue.length) {
        const state = watch.queue[0]!.state;
        try { await watch.callback(state); }
        catch {
          this.report(new Error("T3 state callback failed; delivery will retry."));
          if (watch.active) watch.retryTimer = setTimeout(() => { watch.retryTimer = undefined; void this.drain(watch); }, 1_000);
          return;
        }
        watch.queue.shift();
        if (!watch.ready) { watch.ready = true; clearTimeout(watch.startupTimer); watch.resolve(); }
      }
    } finally { watch.draining = false; }
  }
  async watch(threadId: string, afterSequence: number | null, onState: (state: T3ThreadState) => Promise<void>): Promise<() => void> {
    if (afterSequence !== null && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) throw new Error("Invalid T3 resume cursor.");
    let resolve!: () => void, reject!: (error: Error) => void;
    // A persisted cursor alone has no matching projection. Cold watches take a full
    // snapshot; only reconnects resume the in-memory projection with afterSequence.
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const watch: Watch = { threadId, sequence: null, projection: null, callback: onState, requestId: null, active: true, queue: [], draining: false, dirty: false, lastDelivery: 0, ready: false, resolve, reject };
    this.watches.add(watch);
    watch.startupTimer = setTimeout(() => { watch.reject(new Error("T3 thread subscription timed out.")); this.cancel(watch); }, TIMEOUT_MS);
    // Observe rejection while the initial connection/projection request is pending.
    void ready.catch(() => {});
    try {
      await this.connect();
      if (watch.active) this.subscribe(watch);
      await ready;
      return () => this.cancel(watch);
    } catch (error) { this.cancel(watch); throw error; }
  }
  private cancel(watch: Watch): void {
    watch.active = false; watch.queue = [];
    clearTimeout(watch.timer); clearTimeout(watch.retryTimer); clearTimeout(watch.startupTimer); clearTimeout(watch.subscriptionTimer);
    this.watches.delete(watch);
    if (watch.requestId) {
      this.subscriptions.delete(watch.requestId);
      try { this.write({ _tag: "Interrupt", requestId: watch.requestId }); } catch {}
      watch.requestId = null;
    }
    if (!this.watches.size) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.controller.abort();
    clearTimeout(this.reconnectTimer); clearInterval(this.heartbeat);
    for (const watch of [...this.watches]) { watch.reject(new Error("T3 client is closed.")); this.cancel(watch); }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("T3 client is closed.")); }
    this.pending.clear();
    const socket = this.socket; this.socket = null;
    if (socket) { socket.terminate(); }
  }
  async listProjects(): Promise<T3Project[]> {
    await checkVersion(this.base, this.controller.signal);
    const shell = await json(new URL("/api/orchestration/shell", this.base), { headers: { ...this.auth(), "x-t3-orchestration-protocol": "2" }, signal: this.controller.signal }, "T3 project list");
    return rows(shell.projects).map(p => ({ id: required(p.id), title: str(p.title), defaultModelSelection: p.defaultModelSelection ? row(p.defaultModelSelection) as unknown as ModelSelection : null }));
  }
  async launch(input: Parameters<T3Port["launch"]>[0]): Promise<string> {
    validateAttachments(input.attachments);
    const { messageId, text, attachments, ...thread } = input;
    const result = row(await this.rpc("orchestration.launchThread", { ...thread, interactionMode: "default", workspaceStrategy: { type: "root" }, initialMessage: { messageId, text, attachments } }));
    return required(result.threadId);
  }
  async send(input: Parameters<T3Port["send"]>[0]): Promise<void> {
    validateAttachments(input.attachments);
    await this.rpc("orchestration.dispatchCommand", { ...input, type: "message.dispatch", createdBy: "user", creationSource: "web", deliveryIntent: "steer", dispatchMode: { type: "start_immediately" } });
  }
  async stop(threadId: string, commandId: string): Promise<void> { await this.rpc("orchestration.dispatchCommand", { type: "thread.stop", threadId, commandId }); }
  async respond(threadId: string, requestId: string, response: Parameters<T3Port["respond"]>[2], commandId: string): Promise<void> {
    const decisions: Record<string, string> = { approved: "accept", denied: "decline", accept: "accept", decline: "decline", cancel: "cancel", acceptForSession: "acceptForSession", acceptAlways: "acceptAlways" };
    const decision = response.decision ? decisions[response.decision] : undefined;
    if ((response.decision && !decision) || (!!decision === !!response.answers)) throw new Error("Invalid T3 runtime request response.");
    let answers: Record<string, unknown> | undefined;
    if (response.answers) {
      const retained = [...this.watches].find(w => w.threadId === threadId)?.projection;
      const projection = retained ?? row(await this.rpc("orchestration.getThreadProjection", { threadId }));
      const request = rows(projection.runtimeRequests).find(r => r.id === requestId);
      const capability = row(request?.responseCapability).type;
      if (capability === "not_resumable") throw new Error("T3 request can no longer be answered.");
      answers = Object.fromEntries(Object.entries(response.answers).map(([id, values]) => [id, capability === "message" ? values.join("\n") : { answers: values }]));
    }
    await this.rpc("orchestration.dispatchCommand", { type: "runtime-request.respond", commandId, threadId, requestId, ...(decision ? { decision } : { answers }) });
  }
  async upload(input: InboundAttachment): Promise<Attachment> {
    const mimeType = input.mimeType.trim().toLowerCase();
    const type = IMAGE_TYPES.has(mimeType) ? "image" : "file";
    validateAttachments([{ ...input, mimeType, id: "upload", type }]);
    let source: URL;
    try { source = new URL(input.url); } catch { throw new Error("Invalid Discord attachment URL."); }
    if (source.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(source.hostname) || source.port || source.username || source.password) throw new Error("Only Discord CDN attachment URLs are supported.");
    const bytes = await transfer(source, { signal: this.controller.signal }, "Discord attachment download", Math.min(input.sizeBytes, type === "image" ? IMAGE_BYTES : MAX_BYTES));
    if (bytes.byteLength !== input.sizeBytes) throw new Error("Discord attachment size does not match its metadata.");
    const minted = row(await this.rpc("attachments.createUploadUrl", { type, name: input.name, mimeType, sizeBytes: bytes.byteLength }));
    await transfer(this.signedUrl(minted.relativeUrl), { method: "POST", headers: { "content-type": mimeType }, body: Buffer.from(bytes), signal: this.controller.signal }, "T3 attachment upload");
    return { id: required(minted.attachmentId), type, name: input.name, mimeType, sizeBytes: bytes.byteLength };
  }
  async download(attachmentId: string, name: string, mimeType: string): Promise<Uint8Array> {
    const result = row(await this.rpc("assets.createUrl", { resource: { _tag: "attachment", attachmentId, fileName: name, mimeType } }));
    return transfer(this.signedUrl(result.relativeUrl), { signal: this.controller.signal }, "T3 attachment download");
  }
}
function validateAttachments(attachments: Attachment[]): void {
  if (attachments.length > 8) throw new Error("At most 8 attachments are supported per message.");
  for (const file of attachments) {
    if (!file.name.trim() || file.name.length > 255 || !file.mimeType.trim() || file.mimeType.length > 100 || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > (file.type === "image" ? IMAGE_BYTES : MAX_BYTES)) throw new Error("Attachment metadata exceeds supported limits (10 MiB images; 20 MiB files).");
  }
}
