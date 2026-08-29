export type ConversationKind = "dm" | "guild";
export type ChatRole = "user" | "assistant";

export interface ChannelRef {
  channelId: string;
  guildId?: string;
  parentChannelId?: string;
}

export interface ConversationIdentity {
  key: string;
  kind: ConversationKind;
  guildId?: string;
  channelId: string;
}

export interface SourceMessage {
  discordMessageId: string;
  authorId: string;
  authorName: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  threadId?: string;
}

export interface InboundMessage extends SourceMessage {
  role: "user";
  guildId?: string;
  channelId: string;
  parentChannelId?: string;
  isBot: boolean;
  mentionsBot: boolean;
  repliesToBot: boolean;
  loadThread?: () => Promise<SourceMessage[]>;
  responseIndicator?: ResponseIndicator;
}

export interface ResponseIndicator {
  start(): Promise<void>;
  stop(): void;
}

export interface SessionRecord {
  id: string;
  conversationId: string;
  conversationKey: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage extends SourceMessage {
  id: number;
  sessionId: string;
  reasoning?: string;
  diagnostics?: unknown;
  model?: string;
}

export interface IncomingMessageRecord {
  discordMessageId: string;
  channelId: string;
  authorId: string;
  authorName?: string;
  isBot: boolean;
  mentionsBot: boolean;
  repliesToBot: boolean;
  content: string;
  createdAt: string;
  guildId?: string;
  parentChannelId?: string;
  threadId?: string;
}

export interface PiGenerationInput {
  logicalSessionId: string;
  conversationKey: string;
  conversationKind: ConversationKind;
  sourceMessageId: string;
  authorId: string;
  prompt: string;
}

export interface PiSessionEntryRecord {
  entryId?: string;
  entryType: string;
  parentId?: string;
  rawJson: string;
}

export interface PersistedPiSession {
  rawEntries: string[];
}

export interface PiSessionStore {
  loadPiSession(sessionId: string): PersistedPiSession | undefined;
  createPiSession(sessionId: string, entries: PiSessionEntryRecord[]): void;
  appendPiSessionEntry(sessionId: string, entry: PiSessionEntryRecord): void;
  replacePiSessionEntries(sessionId: string, entries: PiSessionEntryRecord[]): void;
}

export interface PiGenerationResult {
  text: string;
  reasoning?: string;
  diagnostics?: unknown;
  model: string;
}

/**
 * Per-conversation (DM or Channel Group) settings storage keyed by the stable
 * conversation key. Backed by SQLite; the harness injects the key, so the
 * model can never read or write another conversation's settings.
 */
export interface ChannelTimezoneStore {
  getChannelTimezone(conversationKey: string): string | undefined;
  setChannelTimezone(conversationKey: string, timezone: string): void;
}

export type PromptResponseType = "message" | "silent";

/**
 * A validated prompt schedule. One-time schedules carry an absolute UTC
 * instant; recurring schedules carry a zone-local wall-clock time plus the
 * IANA timezone it is interpreted in. Recurring UTC instants are derived at
 * evaluation time so daylight saving time stays correct.
 */
export type PromptSchedule =
  | { type: "once"; atUtc: string }
  | { type: "daily"; time: string; timezone: string }
  | { type: "weekly"; time: string; dayOfWeek: number; timezone: string }
  | { type: "monthly"; time: string; dayOfMonth: number; timezone: string };

export interface ScheduledPromptRecord {
  id: string;
  conversationKey: string;
  prompt: string;
  schedule: PromptSchedule;
  responseType: PromptResponseType;
  status: "active" | "cancelled";
  createdAt: string;
  cancelledAt?: string;
}

export interface ScheduledPromptInput {
  prompt: string;
  schedule: PromptSchedule;
  responseType: PromptResponseType;
}

/**
 * Durable storage for scheduled prompts, scoped by the stable conversation
 * key. Backed by SQLite so jobs survive restarts. The harness injects the
 * key; the model can only manage schedules for the conversation it is in.
 */
export interface ScheduledPromptStore {
  createScheduledPrompt(conversationKey: string, input: ScheduledPromptInput): ScheduledPromptRecord;
  listScheduledPrompts(conversationKey: string): ScheduledPromptRecord[];
  cancelScheduledPrompt(conversationKey: string, id: string): boolean;
}

export interface PiGateway {
  checkHealth(): Promise<void>;
  generate(input: PiGenerationInput): Promise<PiGenerationResult>;
  setBotDisplayName(name: string): void;
}

export interface LogFields {
  [key: string]: unknown;
}

export interface LogEntry extends LogFields {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
}

export interface Logger {
  audit(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}
