import {
  parseSessionEntries,
  SessionManager,
  type CustomEntry,
  type FileEntry,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../pi-common";
import { logger } from "./logger";

export const SUBAGENT_META_ENTRY_TYPE = "pi-subagent:meta";

export type SubagentStatus = "pending" | "running" | "completed" | "max_turns" | "aborted" | "error";

export type SubagentActivity =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

export interface SubagentMetaEntryData {
  name: string;
  title: string;
}

export interface SubagentRecord {
  childSessionId: string;
  name: string;
  title: string;
  status: SubagentStatus;
  sessionFile?: string;
  persisted: boolean;
  model: string;
  totalTurns: number;
  totalUsage: UsageTotals;
  totalDurationMs: number;
  createdAt: number;
  updatedAt: number;
  lastActivity?: SubagentActivity;
  lastError?: string;
}

export type ParentSessionHandle = Pick<
  SessionManager,
  "getSessionDir" | "getSessionId" | "getSessionFile" | "getEntries"
>;

interface RestoredToolDetails {
  childSessionId?: string;
  name?: string;
  title?: string;
  model?: string;
  turns?: number;
  durationMs?: number;
  usage?: Partial<UsageTotals>;
  stopReason?: string;
}

function cloneUsage(usage: UsageTotals): UsageTotals {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost,
  };
}

export function addUsageTotals(target: UsageTotals, delta: Partial<UsageTotals>): void {
  target.input += delta.input ?? 0;
  target.output += delta.output ?? 0;
  target.cacheRead += delta.cacheRead ?? 0;
  target.cacheWrite += delta.cacheWrite ?? 0;
  target.cost += delta.cost ?? 0;
}

export function diffUsageTotals(current: UsageTotals, baseline: UsageTotals): UsageTotals {
  return {
    input: Math.max(0, current.input - baseline.input),
    output: Math.max(0, current.output - baseline.output),
    cacheRead: Math.max(0, current.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - baseline.cacheWrite),
    cost: Math.max(0, current.cost - baseline.cost),
  };
}

function mapStopReasonToStatus(stopReason: string | undefined, isError: boolean): SubagentStatus {
  if (stopReason === "max_turns") return "max_turns";
  if (stopReason === "aborted") return "aborted";
  if (isError) return "error";
  return "completed";
}

function parseTimestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasConversationMessage(entries: readonly SessionEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === "message" &&
      (entry.message.role === "user" || entry.message.role === "assistant"),
  );
}

function extractMetaFromEntries(entries: readonly FileEntry[]): SubagentMetaEntryData | undefined {
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const custom = entry as CustomEntry<unknown>;
    if (custom.customType !== SUBAGENT_META_ENTRY_TYPE || !custom.data || typeof custom.data !== "object") continue;
    const data = custom.data as Partial<SubagentMetaEntryData>;
    if (typeof data.name === "string" && data.name.length > 0) {
      return {
        name: data.name,
        title: typeof data.title === "string" ? data.title : "",
      };
    }
  }
  return undefined;
}

function summarizeFileEntries(entries: readonly FileEntry[]): {
  header?: SessionHeader;
  meta?: SubagentMetaEntryData;
  model: string;
  turns: number;
  usage: UsageTotals;
  createdAt: number;
  updatedAt: number;
  status: SubagentStatus;
  lastError?: string;
} {
  let header: SessionHeader | undefined;
  const meta = extractMetaFromEntries(entries);
  const now = Date.now();
  let createdAt = now;
  let updatedAt = 0;
  let model = "";
  let turns = 0;
  const usage = createUsageTotals();
  let status: SubagentStatus = "completed";
  let lastError: string | undefined;

  for (const entry of entries) {
    if (entry.type === "session") {
      header = entry;
      createdAt = parseTimestamp(entry.timestamp, now);
      updatedAt = Math.max(updatedAt, createdAt);
      continue;
    }

    updatedAt = Math.max(updatedAt, parseTimestamp(entry.timestamp, createdAt));

    if (entry.type === "model_change") {
      model = entry.modelId;
    } else if (entry.type === "message") {
      const msg = entry.message;
      if (msg.role === "assistant") {
        if (msg.model) model = msg.model;
        if (msg.usage) addUsageToTotals(usage, msg.usage);
        if (msg.stopReason === "error") {
          status = "error";
          lastError = msg.errorMessage;
        } else if (msg.stopReason === "aborted") {
          status = "aborted";
        } else {
          turns++;
          status = "completed";
          lastError = undefined;
        }
      } else if (msg.role === "toolResult" && msg.usage) {
        addUsageToTotals(usage, msg.usage);
      }
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
      addUsageToTotals(usage, entry.usage);
    } else if (entry.type === "usage") {
      addUsageToTotals(usage, entry.usage);
    }
  }

  return {
    header,
    meta,
    model,
    turns,
    usage,
    createdAt,
    updatedAt: updatedAt || createdAt,
    status,
    lastError,
  };
}

function isActiveStatus(status: SubagentStatus): boolean {
  return status === "pending" || status === "running";
}

export class SubagentStore {
  readonly isPersistent: boolean;
  readonly subagentDir?: string;

  private readonly parentSessionFile?: string;
  private readonly records = new Map<string, SubagentRecord>();
  private readonly inMemorySessions = new Map<string, SessionManager>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly cwd: string,
    parentSessionManager: ParentSessionHandle,
  ) {
    const parentSessionFile = parentSessionManager.getSessionFile();
    this.parentSessionFile = parentSessionFile;
    this.isPersistent = parentSessionFile !== undefined;
    this.subagentDir = this.isPersistent
      ? join(parentSessionManager.getSessionDir(), "subagents", parentSessionManager.getSessionId())
      : undefined;

    this.restore(parentSessionManager);
  }

  createSession(name: string, title: string): {
    childSessionId: string;
    sessionManager: SessionManager;
    record: SubagentRecord;
  } {
    const sessionManager = this.isPersistent
      ? SessionManager.create(this.cwd, this.subagentDir, { parentSession: this.parentSessionFile })
      : SessionManager.inMemory(this.cwd);

    sessionManager.appendCustomEntry(SUBAGENT_META_ENTRY_TYPE, { name, title } satisfies SubagentMetaEntryData);

    const childSessionId = sessionManager.getSessionId();
    if (!this.isPersistent) {
      this.inMemorySessions.set(childSessionId, sessionManager);
    }

    const now = Date.now();
    const record: SubagentRecord = {
      childSessionId,
      name,
      title,
      status: "pending",
      sessionFile: sessionManager.getSessionFile(),
      persisted: false,
      model: "",
      totalTurns: 0,
      totalUsage: createUsageTotals(),
      totalDurationMs: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.records.set(childSessionId, record);
    this.emit();

    return { childSessionId, sessionManager, record: this.cloneRecord(record) };
  }

  openSessionForResume(childSessionId: string): {
    sessionManager: SessionManager;
    record: SubagentRecord;
  } {
    const record = this.records.get(childSessionId);
    if (!record) {
      throw new Error(
        `Unknown subagent session "${childSessionId}". It may belong to another session or a forked parent; start a new subagent instead.`,
      );
    }

    if (this.isPersistent) {
      if (!record.sessionFile || !existsSync(record.sessionFile)) {
        throw new Error(
          `Subagent session "${childSessionId}" has no persisted transcript to resume (it may have failed or been aborted before starting). Start a new subagent instead.`,
        );
      }
      const sessionManager = SessionManager.open(record.sessionFile, this.subagentDir);
      return { sessionManager, record: this.cloneRecord(record) };
    }

    const sessionManager = this.inMemorySessions.get(childSessionId);
    if (!sessionManager || !hasConversationMessage(sessionManager.getEntries())) {
      throw new Error(
        `Subagent session "${childSessionId}" has no conversation history to resume. Start a new subagent instead.`,
      );
    }
    return { sessionManager, record: this.cloneRecord(record) };
  }

  loadTranscript(childSessionId: string): SessionEntry[] {
    const record = this.records.get(childSessionId);
    if (!record) return [];

    if (!this.isPersistent) {
      return this.inMemorySessions.get(childSessionId)?.getBranch() ?? [];
    }

    if (!record.sessionFile || !existsSync(record.sessionFile)) return [];
    try {
      return SessionManager.open(record.sessionFile, this.subagentDir).getBranch();
    } catch (error) {
      logger.warn("Failed to load subagent transcript", { childSessionId, sessionFile: record.sessionFile, error });
      return [];
    }
  }

  get(childSessionId: string): SubagentRecord | undefined {
    const record = this.records.get(childSessionId);
    return record ? this.cloneRecord(record) : undefined;
  }

  list(): SubagentRecord[] {
    return [...this.records.values()]
      .sort((a, b) => {
        const aActive = isActiveStatus(a.status);
        const bActive = isActiveStatus(b.status);
        if (aActive !== bActive) return aActive ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      })
      .map((record) => this.cloneRecord(record));
  }

  update(childSessionId: string, updater: (record: SubagentRecord) => void): void {
    const record = this.records.get(childSessionId);
    if (!record) return;
    updater(record);
    record.updatedAt = Date.now();
    this.emit();
  }

  syncPersistence(childSessionId: string, sessionManager: SessionManager): boolean {
    const record = this.records.get(childSessionId);
    if (!record) return false;

    const persisted = this.isPersistent
      ? Boolean(record.sessionFile && existsSync(record.sessionFile))
      : hasConversationMessage(sessionManager.getEntries());

    if (record.persisted !== persisted) {
      record.persisted = persisted;
      this.emit();
    }
    return persisted;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private cloneRecord(record: SubagentRecord): SubagentRecord {
    return {
      ...record,
      totalUsage: cloneUsage(record.totalUsage),
      lastActivity: record.lastActivity ? { ...record.lastActivity } : undefined,
    };
  }

  private restore(parentSessionManager: ParentSessionHandle): void {
    if (!this.isPersistent || !this.subagentDir || !existsSync(this.subagentDir)) return;

    let files: string[];
    try {
      files = readdirSync(this.subagentDir)
        .filter((file) => file.endsWith(".jsonl"))
        .sort();
    } catch (error) {
      logger.warn("Failed to scan subagent session directory", { subagentDir: this.subagentDir, error });
      return;
    }

    for (const file of files) {
      const sessionFile = join(this.subagentDir, file);
      try {
        const raw = readFileSync(sessionFile, "utf8");
        const entries = parseSessionEntries(raw);
        const summary = summarizeFileEntries(entries);
        if (!summary.header?.id) continue;

        const childSessionId = summary.header.id;
        this.records.set(childSessionId, {
          childSessionId,
          name: summary.meta?.name ?? "unknown",
          title: summary.meta?.title ?? "",
          status: summary.status,
          sessionFile,
          persisted: true,
          model: summary.model,
          totalTurns: summary.turns,
          totalUsage: summary.usage,
          totalDurationMs: 0,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          lastError: summary.lastError,
        });
      } catch (error) {
        logger.warn("Failed to restore subagent session file", { sessionFile, error });
      }
    }

    // 关联父会话历史中的 agent toolResult details，补齐累计 durationMs、最新 title 与 stopReason
    const parentAggregates = new Map<
      string,
      {
        name?: string;
        title?: string;
        model?: string;
        turns: number;
        durationMs: number;
        usage: UsageTotals;
        status: SubagentStatus;
        updatedAt: number;
      }
    >();

    for (const entry of parentSessionManager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
      if (entry.message.toolName !== "agent") continue;
      const details = entry.message.details as RestoredToolDetails | undefined;
      if (!details?.childSessionId) continue;
      if (!this.records.has(details.childSessionId)) continue;

      const ts = parseTimestamp(entry.timestamp, 0);
      const existing = parentAggregates.get(details.childSessionId) ?? {
        turns: 0,
        durationMs: 0,
        usage: createUsageTotals(),
        status: "completed" as SubagentStatus,
        updatedAt: 0,
      };
      if (details.name) existing.name = details.name;
      if (details.title) existing.title = details.title;
      if (details.model) existing.model = details.model;
      existing.turns += details.turns ?? 0;
      existing.durationMs += details.durationMs ?? 0;
      if (details.usage) addUsageTotals(existing.usage, details.usage);
      existing.status = mapStopReasonToStatus(details.stopReason, entry.message.isError);
      existing.updatedAt = Math.max(existing.updatedAt, ts);
      parentAggregates.set(details.childSessionId, existing);
    }

    for (const [childSessionId, agg] of parentAggregates) {
      const record = this.records.get(childSessionId);
      if (!record) continue;
      if (agg.name && record.name === "unknown") record.name = agg.name;
      if (agg.title) record.title = agg.title;
      if (agg.model) record.model = agg.model;
      if (agg.turns > 0) record.totalTurns = agg.turns;
      if (agg.durationMs > 0) record.totalDurationMs = agg.durationMs;
      if (agg.usage.input > 0 || agg.usage.output > 0 || agg.usage.cost > 0) {
        record.totalUsage = agg.usage;
      }
      record.status = agg.status;
      if (agg.updatedAt > record.updatedAt) record.updatedAt = agg.updatedAt;
    }
  }
}
