export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export interface ModelSelection {
  provider?: string;
  instanceId?: string;
  model: string;
  options?: Record<string, string | boolean>;
}
export interface Route {
  channelId: string;
  projectId: string;
  modelSelection?: ModelSelection;
  runtimeMode?: RuntimeMode;
}
export interface BridgeConfig {
  t3Url: string;
  routes: Route[];
  allowedUserIds: string[];
  databasePath: string;
}
export interface Credentials {
  t3Token?: string;
  discordToken?: string;
}
export interface Attachment {
  id: string;
  type: "image" | "file";
  name: string;
  mimeType: string;
  sizeBytes: number;
}
export interface InboundAttachment {
  name: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}
export interface InboundMessage {
  id: string;
  channelId: string;
  parentChannelId: string | null;
  authorId: string;
  authorName: string;
  text: string;
  attachments: InboundAttachment[];
}
export interface T3Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  runId: string | null;
  status?: string;
  attachments: Attachment[];
}
export interface T3Request {
  id: string;
  kind: "approval" | "question";
  text: string;
  questions?: Array<{ id: string; question: string; options: Array<{ label: string; value?: string }> }>;
}
export interface T3Artifact {
  id: string;
  title: string;
  mimeType: string;
}
export interface T3ThreadState {
  threadId: string;
  title: string;
  sequence: number;
  messages: T3Message[];
  runs: Array<{ id: string; status: string }>;
  requests: T3Request[];
  artifacts: T3Artifact[];
}
export interface T3Project {
  id: string;
  title: string;
  defaultModelSelection: ModelSelection | null;
}
export interface T3Port {
  listProjects(): Promise<T3Project[]>;
  launch(input: {
    commandId: string; threadId: string; messageId: string; projectId: string;
    title: string; text: string; attachments: Attachment[];
    modelSelection: ModelSelection; runtimeMode: RuntimeMode;
  }): Promise<string>;
  send(input: {
    commandId: string; threadId: string; messageId: string; text: string;
    attachments: Attachment[];
  }): Promise<void>;
  stop(threadId: string, commandId: string): Promise<void>;
  respond(threadId: string, requestId: string, response: { decision?: string; answers?: Record<string, string[]> }, commandId: string): Promise<void>;
  upload(attachment: InboundAttachment): Promise<Attachment>;
  download(attachmentId: string, name: string, mimeType: string): Promise<Uint8Array>;
  watch(threadId: string, afterSequence: number | null, onState: (state: T3ThreadState) => Promise<void>): Promise<() => void>;
}
export interface DiscordPort {
  ensureThread(message: InboundMessage, title: string): Promise<string>;
  upsertText(threadId: string, deliveryKey: string, text: string, existingMessageIds: string[]): Promise<string[]>;
  sendFile(threadId: string, deliveryKey: string, name: string, bytes: Uint8Array, caption: string): Promise<string>;
  request(threadId: string, request: T3Request): Promise<string>;
}
