import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  ModelRuntime,
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../pi-common";
import { extractTextContent, formatToolCallSummary } from "../format";
import { logger } from "../logger";
import type {
  AgentProfile,
  AgentThreadSnapshot,
  IsolationMode,
  SpawnResult,
  SpawnStopReason,
  SubagentActivity,
  SubagentWorktreeState,
  ThreadPhase,
  ToolTraceEntry,
  WorktreeSummary,
} from "../types";
import type { CreateChildSessionOptions } from "./child-session";
import type { SubagentStore } from "./store";
import { finalizeWorktree, prepareWorktree } from "./worktree";

export const MAX_TOOL_TRACE_ENTRIES = 50;
export const MAX_TOOL_TRACE_SUMMARY_LENGTH = 100;

export interface SpawnRequest {
  id: string; // toolCallId
  childSessionId: string;
  sessionManager: SessionManager;
  resumed: boolean;
  background?: boolean;
  profile: AgentProfile;
  title: string;
  task: string;
  model: Model<any>;
  thinkingLevel: ModelThinkingLevel;
  /** 仅本次调用覆盖 profile.maxTurns。 */
  maxTurns?: number;
  /** 墙钟超时（秒），从获得并发槽位开始计时，排队不计。 */
  timeoutSeconds?: number;
  isolation?: IsolationMode;
  existingWorktree?: SubagentWorktreeState;
  projectTrusted: boolean;
  prepare: (signal: AbortSignal, cwd: string) => Promise<string>;
}

export type ThreadEvent =
  | { type: "upsert"; snapshot: AgentThreadSnapshot }
  | { type: "remove"; id: string; childSessionId: string }
  | { type: "session_update"; childSessionId: string };

export interface AgentThreadDeps {
  cwd: string;
  modelRuntime: ModelRuntime | undefined;
  store: SubagentStore | undefined;
  createSession: (options: CreateChildSessionOptions) => Promise<AgentSession>;
  emit: (event: ThreadEvent) => void;
  onFinished: (childSessionId: string) => void;
  onSettled: (thread: AgentThread, result: SpawnResult) => void;
  worktreesRootDir?: string;
}

function diffUsageTotals(current: UsageTotals, baseline: UsageTotals): UsageTotals {
  return {
    input: Math.max(0, current.input - baseline.input),
    output: Math.max(0, current.output - baseline.output),
    cacheRead: Math.max(0, current.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - baseline.cacheWrite),
    cost: Math.max(0, current.cost - baseline.cost),
  };
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
export class AgentThread {
  readonly id: string;
  readonly childSessionId: string;
  readonly name: string;
  readonly title: string;
  background: boolean;
  phase: ThreadPhase = "pending";
  readonly startedAt = Date.now();
  runningSince?: number;
  turns = 0;
  usage = createUsageTotals();
  model = "";
  lastActivity?: SubagentActivity;
  readonly settled: Promise<SpawnResult>;

  private session?: AgentSession;
  private sessionReady = false;
  private worktreeState?: SubagentWorktreeState;
  private worktreeSummary?: WorktreeSummary;
  private readonly pendingSteers: string[] = [];
  private baselineUsage = createUsageTotals();
  private readonly controller = new AbortController();
  private aborted = false;
  private timedOut = false;
  private timeoutTimer?: NodeJS.Timeout;
  private sessionCreated = false;
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
    private readonly deps: AgentThreadDeps,
  ) {
    this.id = request.id;
    this.childSessionId = request.childSessionId;
    this.name = request.profile.name;
    this.title = request.title;
    this.background = Boolean(request.background);
    this.settled = new Promise((resolve, reject) => {
      this.resolveSettled = resolve;
      this.rejectSettled = reject;
    });
  }

  getActiveBranch(): SessionEntry[] | undefined {
    return this.session?.sessionManager.getBranch();
  }

  getRecentToolTrace(limit = 5): ToolTraceEntry[] {
    if (limit <= 0 || this.toolTraceAll.length === 0) return [];
    return this.toolTraceAll.slice(-limit).map((entry) => ({ ...entry }));
  }

  snapshot(): AgentThreadSnapshot {
    return {
      id: this.id,
      childSessionId: this.childSessionId,
      resumed: this.request.resumed,
      background: this.background,
      timeoutSeconds: this.request.timeoutSeconds,
      worktreeBranch: this.worktreeState?.branch ?? this.request.existingWorktree?.branch,
      name: this.name,
      title: this.title,
      phase: this.phase,
      startedAt: this.startedAt,
      runningSince: this.runningSince,
      turns: this.turns,
      usage: { ...this.usage },
      model: this.model,
      lastActivity: this.lastActivity,
    };
  }

  markBackground(): void {
    if (this.background) return;
    this.background = true;
    this.deps.store?.update(this.childSessionId, (record) => {
      record.background = true;
    });
    this.publish();
  }

  /** 向运行中或排队中的子任务发送纠偏指令；返回 true 表示在 session 就绪前已缓冲。 */
  async steer(message: string): Promise<boolean> {
    this.lastActivity = { type: "text", text: `[steer] ${message}` };
    this.deps.store?.update(this.childSessionId, (record) => {
      record.lastActivity = this.lastActivity;
    });
    this.publish();

    if (this.sessionReady && this.session) {
      await this.session.steer(message, undefined, { source: "extension" });
      return false;
    }
    this.pendingSteers.push(message);
    return true;
  }

  async start(): Promise<void> {
    this.phase = "running";
    this.runningSince = Date.now();
    this.deps.store?.update(this.childSessionId, (record) => {
      record.status = "running";
      record.title = this.request.title;
      record.background = this.background;
      record.timeoutSeconds = this.request.timeoutSeconds;
      record.lastError = undefined;
    });
    this.publish();

    const { timeoutSeconds } = this.request;
    if (timeoutSeconds !== undefined) {
      this.timeoutTimer = setTimeout(() => {
        this.timedOut = true;
        void this.abort();
      }, timeoutSeconds * 1000);
    }

    try {
      this.settle(await this.run());
    } catch (error) {
      if (this.aborted) this.settle(this.buildResult("aborted"));
      // 前台模式下，子会话创建前的失败（如授权被拒）直接抛给调用方；后台模式下以 error 结果收尾以便触发通知。
      else if (!this.sessionCreated && !this.background) this.fail(error);
      else this.settle(this.buildResult("error", error instanceof Error ? error.message : String(error)));
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
    this.deps.emit({ type: "upsert", snapshot: this.snapshot() });
  }

  private settle(result: SpawnResult): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    clearTimeout(this.timeoutTimer);
    this.deps.onFinished(this.childSessionId);

    const persisted =
      this.deps.store?.finalizeRun({
        childSessionId: this.childSessionId,
        sessionManager: this.request.sessionManager,
        title: this.request.title,
        background: result.background,
        timeoutSeconds: this.request.timeoutSeconds,
        stopReason: result.stopReason,
        model: result.model || undefined,
        turns: result.turns,
        durationMs: result.durationMs,
        usage: result.usage,
        lastActivity: this.lastActivity,
        errorMessage: result.errorMessage,
        worktree: this.worktreeState ?? this.request.existingWorktree,
        recordWorktree: this.worktreeState,
        appendRunEntry: true,
      }) ?? false;

    const finalResult: SpawnResult = {
      ...result,
      persisted,
      worktree: result.worktree ?? this.worktreeSummary,
    };
    this.deps.emit({ type: "remove", id: this.id, childSessionId: this.childSessionId });
    this.resolveSettled(finalResult);
    this.deps.onSettled(this, finalResult);
  }

  private fail(error: unknown): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    clearTimeout(this.timeoutTimer);
    this.deps.onFinished(this.childSessionId);

    const errorMessage = error instanceof Error ? error.message : String(error);
    this.deps.store?.finalizeRun({
      childSessionId: this.childSessionId,
      sessionManager: this.request.sessionManager,
      title: this.request.title,
      background: this.background,
      timeoutSeconds: this.request.timeoutSeconds,
      stopReason: "error",
      model: this.model || undefined,
      turns: this.turns,
      durationMs: Date.now() - this.startedAt,
      usage: this.usage,
      lastActivity: this.lastActivity,
      errorMessage,
      appendRunEntry: false,
    });

    this.deps.emit({ type: "remove", id: this.id, childSessionId: this.childSessionId });
    this.rejectSettled(error);
  }

  private async run(): Promise<SpawnResult> {
    if (this.request.isolation === "worktree") {
      await this.setupWorktree();
    }

    const effectiveCwd = this.worktreeState?.cwd ?? this.deps.cwd;
    let result: SpawnResult;
    try {
      result = await this.executeInCwd(effectiveCwd);
    } finally {
      await this.teardownWorktree();
    }

    return this.worktreeSummary ? { ...result, worktree: this.worktreeSummary } : result;
  }

  private async setupWorktree(): Promise<void> {
    const worktreeState = await prepareWorktree({
      cwd: this.deps.cwd,
      agentName: this.name,
      childSessionId: this.childSessionId,
      existing: this.request.existingWorktree,
      worktreesRootDir: this.deps.worktreesRootDir,
    });
    this.worktreeState = worktreeState;
    this.deps.store?.update(this.childSessionId, (record) => {
      record.worktree = worktreeState;
    });
    this.publish();
  }

  private async teardownWorktree(): Promise<void> {
    if (!this.worktreeState) return;
    try {
      this.worktreeSummary = await finalizeWorktree(this.worktreeState);
    } catch (error) {
      logger.warn("Failed to finalize subagent worktree", {
        childSessionId: this.childSessionId,
        rootPath: this.worktreeState.rootPath,
        error,
      });
    }
  }

  private async executeInCwd(effectiveCwd: string): Promise<SpawnResult> {
    if (this.aborted) return this.buildResult("aborted");

    const material = await this.request.prepare(this.controller.signal, effectiveCwd);
    if (this.aborted) return this.buildResult("aborted");

    const { profile, model, thinkingLevel, sessionManager, projectTrusted } = this.request;
    const session = await this.deps.createSession({
      cwd: effectiveCwd,
      profile,
      model,
      modelRuntime: this.deps.modelRuntime,
      thinkingLevel,
      sessionManager,
      projectTrusted,
    });
    this.session = session;
    this.sessionCreated = true;
    this.baselineUsage = readSessionUsage(session);

    try {
      return await this.runSession(session, material);
    } finally {
      await this.disposeSession(session);
    }
  }

  private async runSession(session: AgentSession, material: string): Promise<SpawnResult> {
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

    while (this.pendingSteers.length > 0) {
      const queued = this.pendingSteers.shift()!;
      await session.steer(queued, undefined, { source: "extension" });
    }
    if (this.aborted) return this.buildResult("aborted");

    this.sessionReady = true;
    const maxTurns = this.request.maxTurns ?? this.request.profile.maxTurns;
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
      const promptText = material ? `${this.request.task}\n\n${material}` : this.request.task;
      await session.prompt(promptText);
    } finally {
      unsubscribe();
      this.syncUsage();
      this.deps.store?.syncPersistence(this.childSessionId, this.request.sessionManager);
    }

    if (this.aborted) return this.buildResult("aborted");
    if (this.turnLimitReached) return this.buildResult("max_turns");
    // agent-loop 把 provider 错误编码成 assistant stopReason === "error"，而不是 reject prompt()。
    if (this.lastStopReason === "error") {
      return this.buildResult("error", this.lastErrorMessage ?? "Subagent failed");
    }
    return this.buildResult("stop");
  }

  private async disposeSession(session: AgentSession): Promise<void> {
    this.sessionReady = false;
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
        this.deps.store?.update(this.childSessionId, (record) => {
          record.lastActivity = this.lastActivity;
        });
        this.publish();
        this.deps.emit({ type: "session_update", childSessionId: this.childSessionId });
        break;
      }
      case "tool_execution_end": {
        const traceEntry = this.pendingToolTraceByCallId.get(event.toolCallId);
        if (traceEntry) {
          if (event.isError) traceEntry.isError = true;
          this.pendingToolTraceByCallId.delete(event.toolCallId);
        }
        this.deps.emit({ type: "session_update", childSessionId: this.childSessionId });
        break;
      }
      case "compaction_end": {
        if (event.result?.usage) {
          this.syncUsage();
          this.publish();
        }
        this.deps.emit({ type: "session_update", childSessionId: this.childSessionId });
        break;
      }
      case "entry_appended": {
        this.syncUsage();
        this.deps.store?.syncPersistence(this.childSessionId, this.request.sessionManager);
        this.publish();
        this.deps.emit({ type: "session_update", childSessionId: this.childSessionId });
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
            this.deps.store?.update(this.childSessionId, (record) => {
              record.model = this.model;
            });
          }
          this.lastStopReason = message.stopReason;
          this.lastErrorMessage = message.errorMessage;
          const text = extractTextContent(message.content);
          if (text.trim()) {
            this.lastActivity = { type: "text", text };
            this.deps.store?.update(this.childSessionId, (record) => {
              record.lastActivity = this.lastActivity;
            });
          }
          this.lastAssistantText = text; // 记录最后一条 AssistantMessage 的文本，即使为空
        }
        if (message.role === "assistant" || message.role === "toolResult") {
          this.publish();
          this.deps.emit({ type: "session_update", childSessionId: this.childSessionId });
        }
        break;
      }
    }
  }

  private buildResult(stopReason: SpawnStopReason, errorMessage?: string): SpawnResult {
    return {
      childSessionId: this.childSessionId,
      resumed: this.request.resumed,
      background: this.background,
      persisted: false, // settle() 按落盘状态覆盖
      text: this.lastAssistantText || "(no output)",
      errorMessage,
      model: this.model,
      turns: this.turns,
      durationMs: Date.now() - this.startedAt,
      timeoutSeconds: this.request.timeoutSeconds,
      usage: { ...this.usage },
      // 超时通过 abort 收尾，在此统一改判为 timeout。
      stopReason: stopReason === "aborted" && this.timedOut ? "timeout" : stopReason,
      toolTrace: trimToolTrace(this.toolTraceAll),
      toolTraceTotal: this.toolTraceAll.length,
      worktree: this.worktreeSummary,
    };
  }
}
