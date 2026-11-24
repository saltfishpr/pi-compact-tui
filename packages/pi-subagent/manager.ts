import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  ModelRuntime,
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../pi-common";
import type { AgentProfile } from "./agents";
import { createChildSession, type CreateChildSessionOptions } from "./child-session";
import { formatToolCallSummary } from "./format";
import { logger } from "./logger";
import { addUsageTotals, diffUsageTotals, type SubagentActivity, type SubagentStore } from "./store";

export type SpawnStopReason = "stop" | "aborted" | "max_turns";

export const MAX_TOOL_TRACE_ENTRIES = 50;
export const MAX_TOOL_TRACE_SUMMARY_LENGTH = 100;

export interface ToolTraceEntry {
  name: string;
  summary: string;
  isError?: boolean;
}

/** 一次子会话运行的结果（与 tool result 的 envelope 无关，由 agent tool 组装成 AgentToolResult）。 */
export interface SpawnResult {
  childSessionId: string;
  resumed: boolean;
  text: string;
  model: string;
  turns: number;
  durationMs: number;
  usage: UsageTotals;
  stopReason: SpawnStopReason;
  toolTrace: ToolTraceEntry[];
  toolTraceTotal: number;
}

export type ThreadPhase = "pending" | "running";

export interface AgentThreadSnapshot {
  id: string;
  childSessionId: string;
  resumed: boolean;
  name: string;
  title: string;
  phase: ThreadPhase;
  startedAt: number;
  runningSince?: number;
  turns: number;
  usage: UsageTotals;
  model: string;
  lastActivity?: SubagentActivity;
}

export type SubagentManagerEvent =
  | { type: "upsert"; snapshot: AgentThreadSnapshot }
  | { type: "remove"; id: string; childSessionId: string }
  | { type: "session_update"; childSessionId: string };

export interface SpawnRequest {
  id: string; // toolCallId
  childSessionId: string;
  sessionManager: SessionManager;
  resumed: boolean;
  profile: AgentProfile;
  title: string;
  task: string;
  model: Model<any>;
  thinkingLevel: ModelThinkingLevel;
  projectTrusted: boolean;
  prepare: (signal: AbortSignal) => Promise<string>;
}

export interface SubagentManagerOptions {
  store?: SubagentStore;
  createSession?: (options: CreateChildSessionOptions) => Promise<AgentSession>;
}

function readSessionUsage(session: AgentSession): UsageTotals {
  const { tokens, cost } = session.getSessionStats();
  return {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    cost,
  };
}

export function trimToolTrace(entries: readonly ToolTraceEntry[], maxEntries = MAX_TOOL_TRACE_ENTRIES): ToolTraceEntry[] {
  if (entries.length <= maxEntries) return [...entries];
  const headCount = Math.floor(maxEntries / 2);
  const tailCount = maxEntries - headCount;
  return [...entries.slice(0, headCount), ...entries.slice(entries.length - tailCount)];
}

/** 一个子任务派发的运行时单元：拥有隔离子会话并驱动其生命周期。 */
class AgentThread {
  readonly id: string;
  readonly childSessionId: string;
  phase: ThreadPhase = "pending";
  readonly startedAt = Date.now();
  runningSince?: number;
  turns = 0;
  usage = createUsageTotals();
  model = "";
  lastActivity?: SubagentActivity;
  readonly settled: Promise<SpawnResult>;

  private session?: AgentSession;
  private baselineUsage = createUsageTotals();
  private readonly controller = new AbortController();
  private aborted = false;
  private turnLimitReached = false;
  private lastStopReason = "";
  private lastErrorMessage?: string;
  private lastAssistantText = "";
  private readonly toolTraceAll: ToolTraceEntry[] = [];
  private readonly pendingToolTraceByCallId = new Map<string, ToolTraceEntry>();
  private settledFlag = false;
  private resolveSettled!: (result: SpawnResult) => void;
  private rejectSettled!: (error: unknown) => void;

  constructor(
    private readonly request: SpawnRequest,
    private readonly cwd: string,
    private readonly modelRuntime: ModelRuntime | undefined,
    private readonly store: SubagentStore | undefined,
    private readonly createSessionFn: (options: CreateChildSessionOptions) => Promise<AgentSession>,
    private readonly emit: (event: SubagentManagerEvent) => void,
    private readonly onFinished: (childSessionId: string) => void,
  ) {
    this.id = request.id;
    this.childSessionId = request.childSessionId;
    this.settled = new Promise((resolve, reject) => {
      this.resolveSettled = resolve;
      this.rejectSettled = reject;
    });
  }

  getActiveBranch(): SessionEntry[] | undefined {
    return this.session?.sessionManager.getBranch();
  }

  snapshot(): AgentThreadSnapshot {
    return {
      id: this.id,
      childSessionId: this.childSessionId,
      resumed: this.request.resumed,
      name: this.request.profile.name,
      title: this.request.title,
      phase: this.phase,
      startedAt: this.startedAt,
      runningSince: this.runningSince,
      turns: this.turns,
      usage: { ...this.usage },
      model: this.model,
      lastActivity: this.lastActivity,
    };
  }

  async start(): Promise<void> {
    this.phase = "running";
    this.runningSince = Date.now();
    this.store?.update(this.childSessionId, (record) => {
      record.status = "running";
      record.title = this.request.title;
      record.lastError = undefined;
    });
    this.publish();
    try {
      this.settle(await this.run());
    } catch (error) {
      if (this.aborted) this.settle(this.buildResult("aborted"));
      else this.fail(error);
    }
  }

  /** 运行中的线程：中止子会话；`run()` 会观察到 aborted 并以 aborted 结果收尾。 */
  async abort(): Promise<void> {
    this.aborted = true;
    this.controller.abort();
    await this.session?.abort();
  }

  /** 排队中的线程：不创建子会话，直接以 aborted 结果收尾。 */
  settleAborted(): void {
    this.aborted = true;
    this.settle(this.buildResult("aborted"));
  }

  private publish(): void {
    this.emit({ type: "upsert", snapshot: this.snapshot() });
  }

  private settle(result: SpawnResult): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    this.onFinished(this.childSessionId);

    this.store?.update(this.childSessionId, (record) => {
      record.status =
        result.stopReason === "max_turns" ? "max_turns" : result.stopReason === "aborted" ? "aborted" : "completed";
      record.title = this.request.title;
      if (result.model) record.model = result.model;
      record.totalTurns += result.turns;
      record.totalDurationMs += result.durationMs;
      addUsageTotals(record.totalUsage, result.usage);
      record.lastActivity = this.lastActivity;
      record.lastError = undefined;
    });
    this.store?.syncPersistence(this.childSessionId, this.request.sessionManager);

    this.emit({ type: "remove", id: this.id, childSessionId: this.childSessionId });
    this.resolveSettled(result);
  }

  private fail(error: unknown): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    this.onFinished(this.childSessionId);

    const errorMessage = error instanceof Error ? error.message : String(error);
    this.store?.update(this.childSessionId, (record) => {
      record.status = "error";
      record.title = this.request.title;
      if (this.model) record.model = this.model;
      record.totalTurns += this.turns;
      record.totalDurationMs += Date.now() - this.startedAt;
      addUsageTotals(record.totalUsage, this.usage);
      record.lastActivity = this.lastActivity;
      record.lastError = errorMessage;
    });
    this.store?.syncPersistence(this.childSessionId, this.request.sessionManager);

    this.emit({ type: "remove", id: this.id, childSessionId: this.childSessionId });
    this.rejectSettled(error);
  }

  private async run(): Promise<SpawnResult> {
    const { profile, task, model, thinkingLevel, sessionManager, projectTrusted } = this.request;
    const material = await this.request.prepare(this.controller.signal);
    if (this.aborted) return this.buildResult("aborted");

    const session = await this.createSessionFn({
      cwd: this.cwd,
      profile,
      model,
      modelRuntime: this.modelRuntime,
      thinkingLevel,
      sessionManager,
      projectTrusted,
    });
    this.session = session;
    this.baselineUsage = readSessionUsage(session);

    try {
      await session.bindExtensions({
        mode: "print",
        onError: (error) => {
          logger.error("bindExtensions", {
            toolCallId: this.id,
            childSessionId: this.childSessionId,
            extensionPath: error.extensionPath,
            event: error.event,
            error: error.error,
            stack: error.stack,
          });
        },
      });

      if (this.aborted) return this.buildResult("aborted");

      const maxTurns = this.request.profile.maxTurns;
      session.agent.finishTurn = ({ message }) => {
        if (message.stopReason === "error" || message.stopReason === "aborted") return;

        this.turns++;
        this.publish();
        if (maxTurns && this.turns >= maxTurns) {
          this.turnLimitReached = true;
          return { action: "end" };
        }
      };

      const unsubscribe = session.subscribe((event) => this.onEvent(event));
      try {
        await session.prompt(material ? `${task}\n\n${material}` : task);
      } finally {
        unsubscribe();
        this.syncUsage();
        this.store?.syncPersistence(this.childSessionId, sessionManager);
      }

      if (this.aborted) return this.buildResult("aborted");
      if (this.turnLimitReached) return this.buildResult("max_turns");
      // agent-loop 把 provider 错误编码成 assistant stopReason === "error"，而不是 reject prompt()。
      if (this.lastStopReason === "error") {
        throw new Error(this.lastErrorMessage ?? "Subagent failed");
      }
      return this.buildResult("stop");
    } finally {
      // 对称于 bindExtensions 发出的 session_start：让子会话的扩展清理 session 级资源。
      try {
        const runner = session.extensionRunner;
        if (runner.hasHandlers("session_shutdown")) {
          await runner.emit({ type: "session_shutdown", reason: "quit" });
        }
      } catch {
        // session_shutdown 处理器是尽力清理，不能阻止 dispose。
      }
      session.dispose();
      this.session = undefined;
    }
  }

  private syncUsage(): void {
    if (!this.session) return;
    this.usage = diffUsageTotals(readSessionUsage(this.session), this.baselineUsage);
  }

  private onEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "tool_execution_start": {
        const args = (event.args ?? {}) as Record<string, unknown>;
        this.lastActivity = { type: "toolCall", name: event.toolName, args };
        const traceEntry: ToolTraceEntry = {
          name: event.toolName,
          summary: formatToolCallSummary(event.toolName, args, MAX_TOOL_TRACE_SUMMARY_LENGTH),
        };
        this.toolTraceAll.push(traceEntry);
        this.pendingToolTraceByCallId.set(event.toolCallId, traceEntry);
        this.store?.update(this.childSessionId, (record) => {
          record.lastActivity = this.lastActivity;
        });
        this.publish();
        this.emit({ type: "session_update", childSessionId: this.childSessionId });
        break;
      }
      case "tool_execution_end": {
        const traceEntry = this.pendingToolTraceByCallId.get(event.toolCallId);
        if (traceEntry) {
          if (event.isError) traceEntry.isError = true;
          this.pendingToolTraceByCallId.delete(event.toolCallId);
        }
        this.emit({ type: "session_update", childSessionId: this.childSessionId });
        break;
      }
      case "compaction_end": {
        if (event.result?.usage) {
          this.syncUsage();
          this.publish();
        }
        this.emit({ type: "session_update", childSessionId: this.childSessionId });
        break;
      }
      case "entry_appended": {
        this.syncUsage();
        this.store?.syncPersistence(this.childSessionId, this.request.sessionManager);
        this.publish();
        this.emit({ type: "session_update", childSessionId: this.childSessionId });
        break;
      }
      case "message_end": {
        const message = event.message;
        // message_end is emitted before persistence, so include its usage directly for the live widget.
        if ((message.role === "assistant" || message.role === "toolResult") && message.usage) {
          addUsageToTotals(this.usage, message.usage);
        }
        if (message.role === "assistant") {
          if (!this.model && message.model) {
            this.model = message.model;
            this.store?.update(this.childSessionId, (record) => {
              record.model = this.model;
            });
          }
          this.lastStopReason = message.stopReason;
          this.lastErrorMessage = message.errorMessage;
          const text = message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          if (text.trim()) {
            this.lastActivity = { type: "text", text };
            this.store?.update(this.childSessionId, (record) => {
              record.lastActivity = this.lastActivity;
            });
          }
          this.lastAssistantText = text; // 记录最后一条 AssistantMessage 的文本，即使为空
        }
        if (message.role === "assistant" || message.role === "toolResult") {
          this.publish();
          this.emit({ type: "session_update", childSessionId: this.childSessionId });
        }
        break;
      }
    }
  }

  private buildResult(stopReason: SpawnStopReason): SpawnResult {
    return {
      childSessionId: this.childSessionId,
      resumed: this.request.resumed,
      text: this.lastAssistantText || "(no output)",
      model: this.model,
      turns: this.turns,
      durationMs: Date.now() - this.startedAt,
      usage: { ...this.usage },
      stopReason,
      toolTrace: trimToolTrace(this.toolTraceAll),
      toolTraceTotal: this.toolTraceAll.length,
    };
  }
}

export class SubagentManager {
  private pending: AgentThread[] = [];
  private readonly running = new Set<AgentThread>();
  private readonly activeByChildId = new Map<string, AgentThread>();
  private shuttingDown = false;
  private readonly listeners = new Set<(event: SubagentManagerEvent) => void>();
  private readonly store?: SubagentStore;
  private readonly createSessionFn: (options: CreateChildSessionOptions) => Promise<AgentSession>;

  constructor(
    private readonly cwd: string,
    private readonly maxConcurrent: number,
    private readonly modelRuntime: ModelRuntime | undefined,
    options: SubagentManagerOptions = {},
  ) {
    this.store = options.store;
    this.createSessionFn = options.createSession ?? createChildSession;
  }

  isChildActive(childSessionId: string): boolean {
    return this.activeByChildId.has(childSessionId);
  }

  getActiveBranch(childSessionId: string): SessionEntry[] | undefined {
    return this.activeByChildId.get(childSessionId)?.getActiveBranch();
  }

  spawn(req: SpawnRequest, signal?: AbortSignal): Promise<SpawnResult> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("Subagent manager is shutting down"));
    }

    if (this.activeByChildId.has(req.childSessionId)) {
      return Promise.reject(
        new Error(
          `Subagent session "${req.childSessionId}" is already pending or running; concurrent resume is not allowed.`,
        ),
      );
    }

    const thread = new AgentThread(
      req,
      this.cwd,
      this.modelRuntime,
      this.store,
      this.createSessionFn,
      (event) => this.emit(event),
      (childSessionId) => {
        if (this.activeByChildId.get(childSessionId) === thread) {
          this.activeByChildId.delete(childSessionId);
        }
      },
    );

    this.activeByChildId.set(req.childSessionId, thread);
    this.store?.update(req.childSessionId, (record) => {
      record.status = "pending";
      record.title = req.title;
      record.lastError = undefined;
    });

    this.pending.push(thread);
    this.emit({ type: "upsert", snapshot: thread.snapshot() });

    if (signal) {
      const onAbort = () => {
        if (thread.phase === "pending") {
          this.pending = this.pending.filter((item) => item !== thread);
          thread.settleAborted();
        } else {
          void thread.abort();
        }
      };
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      void thread.settled.then(cleanup, cleanup);
    }

    this.schedule();
    return thread.settled;
  }

  subscribe(listener: (event: SubagentManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const thread of [...this.pending]) {
      thread.settleAborted();
    }
    this.pending = [];

    const running = [...this.running];
    await Promise.all(running.map((thread) => thread.abort()));
    await Promise.all(running.map((thread) => thread.settled.catch(() => undefined)));
  }

  private schedule(): void {
    while (!this.shuttingDown && this.running.size < this.maxConcurrent && this.pending.length > 0) {
      const thread = this.pending.shift()!;
      this.running.add(thread);
      void thread.start().finally(() => {
        this.running.delete(thread);
        this.schedule();
      });
    }
  }

  private emit(event: SubagentManagerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
