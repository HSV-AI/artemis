import { randomUUID } from "node:crypto";
import {
  buildContextEntries,
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  type FileEntry,
  type SessionContext,
  type SessionEntry,
  type SessionHeader,
  type SessionManager,
  type SessionMessageEntry,
  type SessionTreeNode
} from "@earendil-works/pi-coding-agent";
import type {
  ImageContent,
  TextContent,
  Usage
} from "@earendil-works/pi-ai";
import type {
  PiSessionEntryRecord,
  PiSessionStore
} from "./domain.js";

/**
 * Public PI methods exercised by Artemis's create-session, prompt, extension,
 * compaction, and tree-editing paths. The installed SDK types check every
 * signature here even though PI's concrete SessionManager cannot be
 * structurally implemented because it contains private file-storage state.
 */
type PiSessionManagerRuntimeContract = Pick<
  SessionManager,
  | "isPersisted"
  | "getCwd"
  | "getSessionDir"
  | "usesDefaultSessionDir"
  | "getSessionId"
  | "getSessionFile"
  | "appendMessage"
  | "appendThinkingLevelChange"
  | "appendModelChange"
  | "appendCompaction"
  | "appendCustomEntry"
  | "appendSessionInfo"
  | "getSessionName"
  | "appendCustomMessageEntry"
  | "getLeafId"
  | "getLeafEntry"
  | "getEntry"
  | "getChildren"
  | "getLabel"
  | "appendLabelChange"
  | "getBranch"
  | "buildContextEntries"
  | "buildSessionContext"
  | "getHeader"
  | "getEntries"
  | "getTree"
  | "branch"
  | "resetLeaf"
  | "branchWithSummary"
>;

function createEntryId(existing: ReadonlyMap<string, unknown> | ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) {
      return id;
    }
  }
  return randomUUID();
}

function toEntryRecord(entry: FileEntry): PiSessionEntryRecord {
  if (entry.type === "session") {
    return { entryType: entry.type, rawJson: JSON.stringify(entry) };
  }
  return {
    entryId: entry.id,
    entryType: entry.type,
    ...(entry.parentId !== null ? { parentId: entry.parentId } : {}),
    rawJson: JSON.stringify(entry)
  };
}

function parseEntries(sessionId: string, rawEntries: string[]): FileEntry[] {
  const entries = rawEntries.map((rawEntry) => JSON.parse(rawEntry) as FileEntry);
  const header = entries[0];
  if (header?.type !== "session" || header.id !== sessionId) {
    throw new Error(`PI session has an invalid header: ${sessionId}`);
  }
  return entries;
}

/**
 * PI 0.84.2 accepts only its concrete file/in-memory SessionManager type and
 * does not expose a storage-provider interface. This adapter implements the
 * SessionManager surface used by createAgentSession while preserving PI's
 * native entries in Artemis SQLite. Keep the cast isolated in
 * {@link asPiSessionManager} until the SDK exposes a public storage port.
 */
export class SqlitePiSessionManager implements PiSessionManagerRuntimeContract {
  private readonly fileEntries: FileEntry[];
  private readonly byId = new Map<string, SessionEntry>();
  private readonly labelsById = new Map<string, string>();
  private readonly labelTimestampsById = new Map<string, string>();
  private leafId: string | null = null;
  private constructor(
    private readonly store: PiSessionStore,
    private readonly cwd: string,
    private readonly sessionId: string
  ) {
    const persisted = store.loadPiSession(sessionId);
    if (!persisted) {
      const header: SessionHeader = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd
      };
      this.fileEntries = [header];
      store.createPiSession(sessionId, [toEntryRecord(header)]);
    } else {
      this.fileEntries = parseEntries(sessionId, persisted.rawEntries);
      const beforeMigration = JSON.stringify(this.fileEntries);
      migrateSessionEntries(this.fileEntries);
      if (JSON.stringify(this.fileEntries) !== beforeMigration) {
        store.replacePiSessionEntries(sessionId, this.fileEntries.map(toEntryRecord));
      }
    }
    this.buildIndex();
  }

  public static open(store: PiSessionStore, cwd: string, sessionId: string): SqlitePiSessionManager {
    return new SqlitePiSessionManager(store, cwd, sessionId);
  }

  public isPersisted(): boolean {
    return true;
  }

  public getCwd(): string {
    return this.cwd;
  }

  public getSessionDir(): string {
    return "";
  }

  public usesDefaultSessionDir(): boolean {
    return false;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getSessionFile(): undefined {
    return undefined;
  }

  public appendMessage(message: SessionMessageEntry["message"]): string {
    return this.appendEntry({
      type: "message",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message
    });
  }

  public appendThinkingLevelChange(thinkingLevel: string): string {
    return this.appendEntry({
      type: "thinking_level_change",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      thinkingLevel
    });
  }

  public appendModelChange(provider: string, modelId: string): string {
    return this.appendEntry({
      type: "model_change",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      provider,
      modelId
    });
  }

  public appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean,
    usage?: Usage
  ): string {
    return this.appendEntry({
      type: "compaction",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      ...(details !== undefined ? { details } : {}),
      ...(fromHook !== undefined ? { fromHook } : {}),
      ...(usage !== undefined ? { usage } : {})
    });
  }

  public appendCustomEntry(customType: string, data?: unknown): string {
    return this.appendEntry({
      type: "custom",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      customType,
      data
    });
  }

  public appendSessionInfo(name: string): string {
    return this.appendEntry({
      type: "session_info",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      name: name.replace(/[\r\n]+/g, " ").trim()
    });
  }

  public getSessionName(): string | undefined {
    const entries = this.getEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type === "session_info") {
        return entry.name?.trim() || undefined;
      }
    }
    return undefined;
  }

  public appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: T
  ): string {
    return this.appendEntry({
      type: "custom_message",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      customType,
      content,
      display,
      details
    });
  }

  public getLeafId(): string | null {
    return this.leafId;
  }

  public getLeafEntry(): SessionEntry | undefined {
    return this.leafId ? this.byId.get(this.leafId) : undefined;
  }

  public getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  public getChildren(parentId: string): SessionEntry[] {
    return [...this.byId.values()].filter((entry) => entry.parentId === parentId);
  }

  public getLabel(id: string): string | undefined {
    return this.labelsById.get(id);
  }

  public appendLabelChange(targetId: string, label: string | undefined): string {
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const entry: SessionEntry = {
      type: "label",
      id: this.nextId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      targetId,
      label
    };
    const id = this.appendEntry(entry);
    if (label) {
      this.labelsById.set(targetId, label);
      this.labelTimestampsById.set(targetId, entry.timestamp);
    } else {
      this.labelsById.delete(targetId);
      this.labelTimestampsById.delete(targetId);
    }
    return id;
  }

  public getBranch(fromId?: string): SessionEntry[] {
    const path: SessionEntry[] = [];
    let current = this.byId.get(fromId ?? this.leafId ?? "");
    while (current) {
      path.push(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    return path.reverse();
  }

  public buildContextEntries(): SessionEntry[] {
    return buildContextEntries(this.getEntries(), this.leafId, this.byId);
  }

  public buildSessionContext(): SessionContext {
    return buildSessionContext(this.getEntries(), this.leafId, this.byId);
  }

  public getHeader(): SessionHeader | null {
    const header = this.fileEntries[0];
    return header?.type === "session" ? header : null;
  }

  public getEntries(): SessionEntry[] {
    return this.fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
  }

  public getTree(): SessionTreeNode[] {
    const entries = this.getEntries();
    const nodes = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];
    for (const entry of entries) {
      const label = this.labelsById.get(entry.id);
      const labelTimestamp = this.labelTimestampsById.get(entry.id);
      nodes.set(entry.id, {
        entry,
        children: [],
        ...(label !== undefined ? { label } : {}),
        ...(labelTimestamp !== undefined ? { labelTimestamp } : {})
      });
    }
    for (const entry of entries) {
      const node = nodes.get(entry.id);
      if (!node) {
        continue;
      }
      const parent = entry.parentId ? nodes.get(entry.parentId) : undefined;
      if (!parent || entry.parentId === entry.id) {
        roots.push(node);
      } else {
        parent.children.push(node);
      }
    }
    const stack = [...roots];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      node.children.sort(
        (left, right) => Date.parse(left.entry.timestamp) - Date.parse(right.entry.timestamp)
      );
      stack.push(...node.children);
    }
    return roots;
  }

  public branch(branchFromId: string): void {
    if (!this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
  }

  public resetLeaf(): void {
    this.leafId = null;
  }

  public branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
    usage?: Usage
  ): string {
    if (branchFromId !== null && !this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
    return this.appendEntry({
      type: "branch_summary",
      id: this.nextId(),
      parentId: branchFromId,
      timestamp: new Date().toISOString(),
      fromId: branchFromId ?? "root",
      summary,
      ...(details !== undefined ? { details } : {}),
      ...(fromHook !== undefined ? { fromHook } : {}),
      ...(usage !== undefined ? { usage } : {})
    });
  }

  private nextId(): string {
    return createEntryId(this.byId);
  }

  private appendEntry(entry: SessionEntry): string {
    this.store.appendPiSessionEntry(this.sessionId, toEntryRecord(entry));
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    return entry.id;
  }

  private buildIndex(): void {
    for (const entry of this.getEntries()) {
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
      if (entry.type !== "label") {
        continue;
      }
      if (entry.label) {
        this.labelsById.set(entry.targetId, entry.label);
        this.labelTimestampsById.set(entry.targetId, entry.timestamp);
      } else {
        this.labelsById.delete(entry.targetId);
        this.labelTimestampsById.delete(entry.targetId);
      }
    }
  }
}

export function asPiSessionManager(manager: SqlitePiSessionManager): SessionManager {
  return manager as unknown as SessionManager;
}
