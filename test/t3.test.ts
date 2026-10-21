import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { exchangePairing, T3Client } from "../src/t3.ts";
import type { T3ThreadState } from "../src/types.ts";

type Frame = Record<string, unknown>;
const record = (value: unknown) => value as Frame;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function snapshot(sequence = 10) {
  return { kind: "snapshot", snapshotSequence: sequence, projection: { thread: { id: "thread", title: "Test" }, messages: [], runs: [], runtimeRequests: [], turnItems: [] } };
}
function event(sequence: number, type: string, payload: unknown) { return { kind: "event", sequence, event: { threadId: "thread", type, payload } }; }
function chunk(socket: WebSocket, request: Frame, values: unknown[]) { socket.send(JSON.stringify({ _tag: "Chunk", requestId: request.id, values })); }
function success(socket: WebSocket, request: Frame, value: unknown) { socket.send(JSON.stringify({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value } })); }
async function fixture(t: TestContext, options: {
  frame?: (frame: Frame, socket: WebSocket, connection: number) => void;
  http?: (request: IncomingMessage, response: ServerResponse) => boolean | Promise<boolean>;
  version?: number;
} = {}) {
  const requests: Array<{ method: string; path: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const upgrades: string[] = [];
  const frames: Frame[] = [];
  let tickets = 0, connections = 0;
  const server = createServer(async (req, res) => {
    if (await options.http?.(req, res)) return;
    const data: Buffer[] = [];
    for await (const block of req) data.push(Buffer.isBuffer(block) ? block : Buffer.from(block));
    requests.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: Buffer.concat(data).toString() });
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/t3/environment") res.end(JSON.stringify({ orchestrationProtocolVersion: options.version ?? 2 }));
    else if (req.url === "/oauth/token") res.end(JSON.stringify({ access_token: "access-token", expires_in: 3600, scope: "orchestration:read orchestration:operate" }));
    else if (req.url === "/api/auth/websocket-ticket") res.end(JSON.stringify({ ticket: `ticket-${++tickets}` }));
    else if (req.url === "/api/orchestration/shell") res.end(JSON.stringify({ projects: [{ id: "project", title: "Project", defaultModelSelection: { provider: "codex", model: "test" } }] }));
    else { res.statusCode = 404; res.end("{}"); }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    upgrades.push(req.url ?? "");
    wss.handleUpgrade(req, socket, head, ws => {
      const connection = ++connections;
      ws.on("message", data => {
        const frame = record(JSON.parse(data.toString()));
        frames.push(frame);
        if (frame._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
        options.frame?.(frame, ws, connection);
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const client = new T3Client({ url, token: "access-token" });
  t.after(async () => {
    await client.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { client, url, requests, frames, upgrades };
}

test("pairing exchanges a raw bootstrap credential and discovery requires V2", async t => {
  const f = await fixture(t);
  const before = Date.now();
  const result = await exchangePairing(f.url, "pairing-secret");
  assert.equal(result.token, "access-token");
  assert.ok(Date.parse(result.expiresAt) >= before + 3_600_000);
  const formRequest = f.requests.find(r => r.path === "/oauth/token")!;
  const form = new URLSearchParams(formRequest.body);
  assert.equal(form.get("subject_token"), "pairing-secret");
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
  assert.equal(form.get("subject_token_type"), "urn:t3:params:oauth:token-type:environment-bootstrap");
  assert.equal(form.get("requested_token_type"), "urn:ietf:params:oauth:token-type:access_token");
  assert.equal(form.get("scope"), "orchestration:read orchestration:operate");
  assert.equal(form.get("client_label"), "T3 Discord bridge");
  assert.equal(form.get("client_device_type"), "bot");
  assert.equal(formRequest.headers["content-type"], "application/x-www-form-urlencoded");
  const old = await fixture(t, { version: 1 });
  await assert.rejects(old.client.connect(), /requires.*V2/);
  await assert.rejects(exchangePairing(old.url, "secret"), /requires.*V2/);
  assert.equal(old.requests.some(r => r.path === "/oauth/token"), false);
});

test("pairing and saved-token clients reject plaintext remote origins before any fetch", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  for (const url of ["http://remote.invalid", "ws://remote.invalid/path", "http://localhost.remote.invalid", "http://[::2]"]) {
    await assert.rejects(exchangePairing(url, "bootstrap-credential"), /Use HTTPS/);
    assert.throws(() => new T3Client({ url, token: "saved-access-token" }), /Use HTTPS/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("transport permits supported loopback hosts and remote TLS, preserving ws/wss normalization", async t => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname === "/.well-known/t3/environment") return Response.json({ orchestrationProtocolVersion: 2 });
    if (url.pathname === "/oauth/token") return Response.json({ access_token: "access-token", expires_in: 3600, scope: "orchestration:read orchestration:operate" });
    assert.equal(url.pathname, "/api/orchestration/shell");
    return Response.json({ projects: [] });
  });
  for (const url of [
    "http://localhost:3773", "http://127.0.0.1:3773", "http://[::1]:3773",
    "ws://localhost:3773", "ws://127.0.0.1:3773", "ws://[::1]:3773",
    "https://remote.invalid", "wss://remote.invalid",
  ]) {
    requests.length = 0;
    const expected = new URL(url.replace(/^ws/, "http")).origin;
    assert.equal((await exchangePairing(url, "bootstrap-credential")).token, "access-token");
    const client = new T3Client({ url, token: "saved-access-token" });
    try { assert.deepEqual(await client.listProjects(), []); }
    finally { await client.close(); }
    assert.deepEqual(requests.map(request => request.url.origin), [expected, expected, expected, expected]);
    assert.equal(new Headers(requests[3]!.init?.headers).get("authorization"), "Bearer saved-access-token");
  }
});

test("ticket authentication, shell projects, launch and command shapes use V2", async t => {
  const f = await fixture(t, { frame(frame, socket) {
    if (frame._tag !== "Request") return;
    success(socket, frame, frame.tag === "orchestration.launchThread" ? { threadId: "thread" } : { sequence: 1 });
  } });
  assert.deepEqual(await f.client.listProjects(), [{ id: "project", title: "Project", defaultModelSelection: { provider: "codex", model: "test" } }]);
  const modelSelection = { provider: "codex", model: "test", options: { reasoningEffort: "high" } };
  assert.equal(await f.client.launch({ commandId: "launch", threadId: "thread", messageId: "message", projectId: "project", title: "Test", text: "Hello", attachments: [], modelSelection, runtimeMode: "full-access" }), "thread");
  await f.client.send({ commandId: "send", threadId: "thread", messageId: "next", text: "Next", attachments: [] });
  await f.client.stop("thread", "stop");
  await f.client.respond("thread", "request", { decision: "approved" }, "respond");
  const launch = f.frames.find(frame => frame.tag === "orchestration.launchThread")!;
  assert.equal(typeof launch.id, "string");
  assert.deepEqual(launch.headers, []);
  assert.deepEqual(launch.payload, { commandId: "launch", threadId: "thread", projectId: "project", title: "Test", modelSelection, runtimeMode: "full-access", interactionMode: "default", workspaceStrategy: { type: "root" }, initialMessage: { messageId: "message", text: "Hello", attachments: [] } });
  const commands = f.frames.filter(frame => frame.tag === "orchestration.dispatchCommand").map(frame => record(frame.payload));
  assert.deepEqual(commands[0], { commandId: "send", threadId: "thread", messageId: "next", text: "Next", attachments: [], type: "message.dispatch", createdBy: "user", creationSource: "web", deliveryIntent: "steer", dispatchMode: { type: "start_immediately" } });
  assert.deepEqual(commands[1], { type: "thread.stop", threadId: "thread", commandId: "stop" });
  assert.deepEqual(commands[2], { type: "runtime-request.respond", threadId: "thread", requestId: "request", commandId: "respond", decision: "accept" });
  assert.equal(f.requests.find(r => r.path === "/api/orchestration/shell")?.headers["x-t3-orchestration-protocol"], "2");
  assert.equal(f.requests.find(r => r.path === "/api/auth/websocket-ticket")?.headers.authorization, "Bearer access-token");
  const upgrade = new URL(f.upgrades[0]!, f.url);
  assert.equal(upgrade.searchParams.get("wsTicket"), "ticket-1");
  assert.equal(upgrade.searchParams.get("orchestrationProtocol"), "2");
  assert.equal(upgrade.searchParams.has("token"), false);
});

test("array envelopes apply snapshots/events, join requests, and extract only published HTML artifacts", async t => {
  const delivered = deferred<T3ThreadState>();
  const acknowledged = deferred<void>();
  let received: T3ThreadState | undefined;
  const f = await fixture(t, { frame(frame, socket) {
    if (frame._tag === "Ack") { assert.equal(received?.sequence, 18); acknowledged.resolve(); }
    if (frame.tag !== "orchestration.subscribeThread") return;
    assert.equal(record(frame.payload).afterSequence, undefined); // No cached projection on a cold watch.
    socket.send(JSON.stringify([{ _tag: "Chunk", requestId: frame.id, values: [snapshot(),
      event(11, "message.updated", { id: "message", role: "assistant", text: "Done", runId: "run", streaming: false, attachments: [{ id: "file", type: "file", name: "normal.txt", mimeType: "text/plain", sizeBytes: 2 }] }),
      event(12, "run.created", { id: "run", status: "completed" }),
      event(13, "turn-item.updated", { id: "question", type: "user_input_request", requestId: "request", status: "running", questions: [{ id: "q", question: "Which?", options: [{ label: "One", value: "1" }] }] }),
      event(14, "runtime-request.updated", { id: "request", kind: "user_input", status: "pending", responseCapability: { type: "live" } }),
      event(15, "turn-item.updated", { id: "html", type: "dynamic_tool", status: "completed", toolName: "mcp__t3-code__html_render", output: { content: [{ type: "text", text: JSON.stringify({ htmlRender: { attachmentId: "page", title: "Result", height: 200 } }) }] } }),
      event(16, "turn-item.updated", { id: "bad", type: "dynamic_tool", status: "completed", toolName: "html_render", output: { isError: true, htmlRender: { attachmentId: "bad", title: "Bad", height: 100 } } }),
      event(17, "turn-item.updated", { id: "path", type: "dynamic_tool", status: "completed", toolName: "html_render", output: { path: "/private/secret.html" } }),
      event(18, "future.event", { ignored: true }), { kind: "synchronized" },
    ] }, { _tag: "Ping" }]));
  } });
  const stop = await f.client.watch("thread", 3, async state => { received = state; if (state.sequence === 18) delivered.resolve(state); });
  const state = await delivered.promise;
  await acknowledged.promise;
  assert.equal(state.messages[0]?.status, "completed");
  assert.equal(state.messages[0]?.text, "Done");
  assert.deepEqual(state.runs, [{ id: "run", status: "completed" }]);
  assert.deepEqual(state.requests, [{ id: "request", kind: "question", text: "Which?", questions: [{ id: "q", question: "Which?", options: [{ label: "One", value: "1" }] }] }]);
  assert.deepEqual(state.artifacts, [{ id: "page", title: "Result", mimeType: "text/html" }]);
  stop();
});

test("reconnect obtains a fresh ticket, resumes applied sequence, and cancellation interrupts", async t => {
  const replayed = deferred<T3ThreadState>(), interrupted = deferred<void>();
  const seen: number[] = [];
  const f = await fixture(t, { frame(frame, socket, connection) {
    if (frame._tag === "Interrupt") interrupted.resolve();
    if (frame.tag !== "orchestration.subscribeThread") return;
    if (connection === 1) chunk(socket, frame, [snapshot(10), event(12, "message.updated", { id: "m", role: "assistant", text: "Partial", streaming: true }), { kind: "synchronized" }]);
    else {
      assert.equal(record(frame.payload).afterSequence, 12);
      chunk(socket, frame, [event(12, "message.updated", { id: "m", role: "assistant", text: "Duplicate stale", streaming: false }), event(15, "message.updated", { id: "m", role: "assistant", text: "Complete", streaming: false }), { kind: "synchronized" }]);
    }
    if (connection === 1) socket.once("message", data => { if (record(JSON.parse(data.toString()))._tag === "Ack") socket.terminate(); });
  } });
  const stop = await f.client.watch("thread", null, async state => { seen.push(state.sequence); if (state.sequence === 15) replayed.resolve(state); });
  const state = await replayed.promise;
  assert.equal(state.messages[0]?.text, "Complete");
  assert.equal(f.requests.filter(r => r.path === "/api/auth/websocket-ticket").length, 2);
  assert.equal(new URL(f.upgrades[1]!, f.url).searchParams.get("wsTicket"), "ticket-2");
  assert.equal(seen.filter(n => n === 15).length, 1);
  stop();
  await interrupted.promise;
});

test("slow callbacks stay serial while streaming updates coalesce and completion stays queued", async t => {
  const started = deferred<void>(), release = deferred<void>(), completed = deferred<T3ThreadState>(), ack = deferred<void>();
  let request!: Frame, socket!: WebSocket, active = 0, maxActive = 0;
  const seen: T3ThreadState[] = [];
  const f = await fixture(t, { frame(frame, ws) {
    if (frame._tag === "Ack" && seen.length >= 2) ack.resolve();
    if (frame.tag === "orchestration.subscribeThread") { request = frame; socket = ws; chunk(ws, frame, [snapshot()]); }
  } });
  const stop = await f.client.watch("thread", null, async state => {
    active++; maxActive = Math.max(maxActive, active); seen.push(state);
    if (state.sequence === 11) { started.resolve(); await release.promise; }
    if (state.sequence === 30) completed.resolve(state);
    active--;
  });
  chunk(socket, request, [event(11, "runtime-request.updated", { id: "a", kind: "command", status: "pending", responseCapability: { type: "live" } })]);
  await started.promise;
  chunk(socket, request, Array.from({ length: 18 }, (_, i) => event(12 + i, "message.updated", { id: "m", role: "assistant", text: `Chunk ${i}`, streaming: true })));
  await ack.promise;
  assert.equal(seen.length, 2);
  chunk(socket, request, [event(30, "message.updated", { id: "m", role: "assistant", text: "Final", streaming: false })]);
  release.resolve();
  assert.equal((await completed.promise).messages[0]?.text, "Final");
  assert.equal(maxActive, 1);
  assert.deepEqual(seen.map(s => s.sequence), [10, 11, 30]);
  stop();
});

test("RPC failures expose contract classification without secrets, and close rejects pending calls", async t => {
  const pendingStarted = deferred<void>();
  const f = await fixture(t, { frame(frame, socket) {
    if (frame.tag === "fail") socket.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "ProjectionStoreThreadNotFoundError", message: "access-token http://host/?secret=hidden raw payload" } }] } }));
    if (frame.tag === "pending") pendingStarted.resolve();
  } });
  await assert.rejects(f.client.rpc("fail", { secret: "payload" }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ProjectionStoreThreadNotFoundError/);
    assert.doesNotMatch(error.message, /access-token|secret|payload|http/);
    return true;
  });
  const pending = f.client.rpc("pending", {});
  const rejected = assert.rejects(pending, /closed/);
  await pendingStarted.promise;
  await f.client.close();
  await rejected;
  await assert.rejects(f.client.connect(), /closed/);
});

test("message-capability questions use scalar answers and approvals use the native enum", async t => {
  const commands: Frame[] = [];
  const f = await fixture(t, { frame(frame, socket) {
    if (frame.tag === "orchestration.getThreadProjection") success(socket, frame, { runtimeRequests: [{ id: "q", responseCapability: { type: "message" } }] });
    if (frame.tag === "orchestration.dispatchCommand") { commands.push(record(frame.payload)); success(socket, frame, {}); }
  } });
  await f.client.respond("thread", "q", { answers: { question: ["First", "Second"] } }, "answer");
  await f.client.respond("thread", "approval", { decision: "denied" }, "deny");
  assert.deepEqual(commands[0]?.answers, { question: "First\nSecond" });
  assert.equal(commands[1]?.decision, "decline");
  await assert.rejects(f.client.respond("thread", "q", { decision: "yes" }, "bad"), /Invalid/);
});

test("attachment transfers enforce CDN, count, metadata and streamed byte limits", async t => {
  const minted: Frame[] = [];
  let uploaded: Buffer | undefined;
  const f = await fixture(t, {
    async http(req, res) {
      if (req.url === "/upload?signature=secret") {
        const parts: Buffer[] = [];
        for await (const part of req) parts.push(Buffer.from(part));
        uploaded = Buffer.concat(parts); res.end(); return true;
      }
      if (req.url === "/asset?signature=secret") { res.end("file bytes"); return true; }
      if (req.url === "/oversize") { res.setHeader("content-length", String(21 * 1024 * 1024)); res.end(); return true; }
      return false;
    },
    frame(frame, socket) {
      if (frame.tag === "attachments.createUploadUrl") { minted.push(record(frame.payload)); success(socket, frame, { attachmentId: "uploaded", relativeUrl: "/upload?signature=secret" }); }
      if (frame.tag === "assets.createUrl") success(socket, frame, { relativeUrl: record(record(frame.payload).resource).attachmentId === "large" ? "/oversize" : "/asset?signature=secret" });
    },
  });
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://cdn.discordapp.com/")) return new Response(new Uint8Array([1, 2, 3]));
    if (String(input).startsWith("https://media.discordapp.net/")) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); controller.close(); } }));
    return originalFetch(input, init);
  });
  const metadata = { name: "file.txt", mimeType: "text/plain", sizeBytes: 3 };
  assert.deepEqual(await f.client.upload({ ...metadata, url: "https://cdn.discordapp.com/attachments/file" }), { ...metadata, id: "uploaded", type: "file" });
  assert.deepEqual(uploaded, Buffer.from([1, 2, 3]));
  assert.deepEqual(minted[0], { type: "file", ...metadata });
  assert.equal(new TextDecoder().decode(await f.client.download("id", "file.txt", "text/plain")), "file bytes");
  await assert.rejects(f.client.download("large", "file", "text/plain"), /byte limit/);
  await assert.rejects(f.client.upload({ ...metadata, url: "https://media.discordapp.net/attachments/file" }), /byte limit/);
  await assert.rejects(f.client.upload({ ...metadata, url: "https://cdn.discordapp.com.evil.test/file" }), /Only Discord CDN/);
  await assert.rejects(f.client.upload({ ...metadata, url: "http://127.0.0.1/file" }), /Only Discord CDN/);
  await assert.rejects(f.client.upload({ ...metadata, sizeBytes: 21 * 1024 * 1024, url: "https://cdn.discordapp.com/file" }), /metadata/);
  await assert.rejects(f.client.upload({ ...metadata, mimeType: "image/png", sizeBytes: 11 * 1024 * 1024, url: "https://cdn.discordapp.com/file" }), /metadata/);
  await assert.rejects(f.client.send({ commandId: "c", threadId: "t", messageId: "m", text: "", attachments: Array.from({ length: 9 }, () => ({ ...metadata, id: "file", type: "file" as const })) }), /At most 8/);
});

test("pairing rejects credentials that only grant read access", async t => {
  const f = await fixture(t, { http(req, res) {
    if (req.url !== "/oauth/token") return false;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ access_token: "private", expires_in: 3600, scope: "orchestration:read" }));
    return true;
  } });
  await assert.rejects(exchangePairing(f.url, "bootstrap"), /must grant orchestration:read and orchestration:operate/);
});

test("RPC timeout interrupts the request and heartbeat send failures cannot escape the timer", async t => {
  const started = deferred<void>(), interrupted = deferred<void>();
  const f = await fixture(t, { frame(frame) {
    if (frame.tag === "pending") started.resolve();
    if (frame._tag === "Interrupt") interrupted.resolve();
  } });
  await f.client.connect();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.client.rpc("pending", {});
  const rejected = assert.rejects(pending, /timed out/);
  await started.promise;
  t.mock.timers.tick(20_000);
  await rejected;
  await interrupted.promise;
  t.mock.timers.reset();
  await f.client.close();

  const heartbeat = await fixture(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  await heartbeat.client.connect();
  const originalSend = WebSocket.prototype.send;
  let pingAttempted = false;
  t.mock.method(WebSocket.prototype, "send", function(this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
    if (JSON.parse(String(args[0]))._tag === "Ping") { pingAttempted = true; throw new Error("wsTicket=secret"); }
    return originalSend.apply(this, args);
  });
  assert.doesNotThrow(() => t.mock.timers.tick(5_000));
  assert.equal(pingAttempted, true);
  t.mock.timers.reset();
});

test("pending streaming deliveries coalesce across slow callbacks without dropping completion", async t => {
  let socket!: WebSocket, request!: Frame;
  const block = deferred<void>(), release = deferred<void>(), done = deferred<void>();
  const states: T3ThreadState[] = [];
  const f = await fixture(t, { frame(frame, ws) {
    if (frame.tag === "orchestration.subscribeThread") { socket = ws; request = frame; chunk(ws, frame, [snapshot()]); }
    if (frame.tag === "barrier") success(ws, frame, {});
  } });
  const stop = await f.client.watch("thread", null, async state => {
    states.push(state);
    if (state.sequence === 11) { block.resolve(); await release.promise; }
    if (state.sequence === 30) done.resolve();
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  chunk(socket, request, [event(11, "runtime-request.updated", { id: "r", kind: "command", status: "pending", responseCapability: { type: "live" } })]);
  await block.promise;
  for (let sequence = 12; sequence < 18; sequence++) {
    chunk(socket, request, [event(sequence, "message.updated", { id: "m", role: "assistant", text: String(sequence), streaming: true })]);
    await f.client.rpc("barrier", {});
    t.mock.timers.tick(1_000);
  }
  chunk(socket, request, [event(30, "message.updated", { id: "m", role: "assistant", text: "Final", streaming: false })]);
  await f.client.rpc("barrier", {});
  release.resolve();
  await done.promise;
  assert.deepEqual(states.map(state => state.sequence), [10, 11, 17, 30]);
  assert.equal(states[2]?.messages[0]?.text, "17");
  stop();
  t.mock.timers.reset();
});

test("a rejected stale subscription leaves healthy watches and commands on the same socket", async t => {
  const connections = new Set<number>();
  let healthyStarts = 0;
  const f = await fixture(t, { frame(frame, socket, connection) {
    connections.add(connection);
    if (frame.tag === "orchestration.subscribeThread") {
      if (record(frame.payload).threadId === "deleted") socket.send(JSON.stringify({
        _tag: "Exit", requestId: frame.id, exit: { _tag: "Failure", cause: { _tag: "MissingThreadError" } },
      }));
      else { healthyStarts++; chunk(socket, frame, [snapshot()]); }
    }
    if (frame.tag === "orchestration.dispatchCommand") success(socket, frame, {});
  } });
  const stop = await f.client.watch("healthy", null, async () => {});
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(f.client.watch("deleted", null, async () => {}), /MissingThreadError/);
    await f.client.stop("healthy", `stop-${attempt}`);
  }
  assert.equal(healthyStarts, 1);
  assert.equal(connections.size, 1);
  assert.equal(f.upgrades.length, 1);
  stop();
});

test("an established subscription ending retries only that watch without dropping healthy commands", async t => {
  let source!: WebSocket, subscription!: Frame;
  let starts = 0;
  const resumed = deferred<void>();
  const f = await fixture(t, { frame(frame, socket) {
    if (frame.tag === "orchestration.subscribeThread") {
      starts++;
      source = socket; subscription = frame;
      if (starts === 1) chunk(socket, frame, [snapshot()]);
      else {
        assert.equal(record(frame.payload).afterSequence, 10);
        chunk(socket, frame, [event(11, "message.updated", { id: "m", role: "assistant", text: "Recovered", streaming: false })]);
      }
    }
    if (frame.tag === "barrier" || frame.tag === "orchestration.dispatchCommand") success(socket, frame, {});
  } });
  const stop = await f.client.watch("thread", null, async state => { if (state.sequence === 11) resumed.resolve(); });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  source.send(JSON.stringify({ _tag: "Exit", requestId: subscription.id, exit: { _tag: "Success" } }));
  await f.client.rpc("barrier", {});
  await f.client.stop("thread", "stop-during-subscription-retry");
  t.mock.timers.tick(1_000);
  await resumed.promise;
  assert.equal(starts, 2);
  assert.equal(f.upgrades.length, 1);
  stop();
  t.mock.timers.reset();
});
