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

export type PiHistoryCompleteness = "complete" | "legacy_import_incomplete";

export interface PiSessionEntryRecord {
  entryId?: string;
  entryType: string;
  parentId?: string;
  rawJson: string;
}

export interface PersistedPiSession {
  historyCompleteness: PiHistoryCompleteness;
  rawEntries: string[];
}

export interface LegacyPiSession {
  sessionId: string;
  createdAt: string;
  messages: StoredMessage[];
}

export interface PiSessionStore {
  loadPiSession(sessionId: string): PersistedPiSession | undefined;
  createPiSession(
    sessionId: string,
    historyCompleteness: PiHistoryCompleteness,
    entries: PiSessionEntryRecord[]
  ): void;
  appendPiSessionEntry(sessionId: string, entry: PiSessionEntryRecord): void;
  replacePiSessionEntries(sessionId: string, entries: PiSessionEntryRecord[]): void;
  listLegacyPiSessions(): LegacyPiSession[];
}

export interface PiGenerationResult {
  text: string;
  reasoning?: string;
  diagnostics?: unknown;
  model: string;
}

export interface PiGateway {
  checkHealth(): Promise<void>;
  generate(input: PiGenerationInput): Promise<PiGenerationResult>;
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
