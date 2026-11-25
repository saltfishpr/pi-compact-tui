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
import {
  addUsageTotals,
  diffUsageTotals,
  SUBAGENT_RUN_ENTRY_TYPE,
  type SubagentActivity,
  type SubagentRunEntryData,
  type SubagentStatus,
  type SubagentStore,
} from "./store";
import {
  finalizeWorktree,
  prepareWorktree,
  type IsolationMode,
  type SubagentWorktreeState,
  type WorktreeSummary,
} from "./worktree";

export type SpawnStopReason = "stop" | "aborted" | "max_turns" | "timeout" | "error";

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
  background: boolean;
  /** 子会话是否已有可 resume 的落盘内容。 */
  persisted: boolean;
  text: string;
  /** stopReason 为 "error" 时的错误信息。 */
  errorMessage?: string;
  model: string;
  turns: number;
  durationMs: number;
  timeoutSeconds?: number;
  usage: UsageTotals;
  stopReason: SpawnStopReason;
  toolTrace: ToolTraceEntry[];
  toolTraceTotal: number;
  worktree?: WorktreeSummary;
}

export type ThreadPhase = "pending" | "running";

export interface AgentThreadSnapshot {
  id: string;
  childSessionId: string;
  resumed: boolean;
  background: boolean;
  timeoutSeconds?: number;
  worktreeBranch?: string;
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
  | { type: "session_update"; childSessionId: string }
  | { type: "detached"; childSessionId: string }
  | { type: "background_settled"; result: SpawnResult; name: string; title: string; triggerTurn: boolean };

export type WaitResult =
  | { done: true; result: SpawnResult }
  | { done: false; reason: "timeout" | "aborted"; snapshot?: AgentThreadSnapshot };

export type SteerResult =
  | { ok: true; queued: boolean }
  | { ok: false; reason: "not_found" | "not_active"; status?: SubagentStatus };

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

export interface SubagentManagerOptions {
  store?: SubagentStore;
  createSession?: (options: CreateChildSessionOptions) => Promise<AgentSession>;
  worktreesRootDir?: string;
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
    private readonly cwd: string,
    private readonly modelRuntime: ModelRuntime | undefined,
    private readonly store: SubagentStore | undefined,
    private readonly createSessionFn: (options: CreateChildSessionOptions) => Promise<AgentSession>,
    private readonly emit: (event: SubagentManagerEvent) => void,
    private readonly onFinished: (childSessionId: string) => void,
    private readonly onSettled: (thread: AgentThread, result: SpawnResult) => void,
    private readonly worktreesRootDir?: string,
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
    this.store?.update(this.childSessionId, (record) => {
      record.background = true;
    });
    this.publish();
  }

  /** 向运行中或排队中的子任务发送纠偏指令；返回 true 表示在 session 就绪前已缓冲。 */
  async steer(message: string): Promise<boolean> {
    this.lastActivity = { type: "text", text: `[steer] ${message}` };
    this.store?.update(this.childSessionId, (record) => {
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
    this.store?.update(this.childSessionId, (record) => {
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
    this.emit({ type: "upsert", snapshot: this.snapshot() });
  }

  private settle(result: SpawnResult): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    clearTimeout(this.timeoutTimer);
    this.onFinished(this.childSessionId);

    this.store?.update(this.childSessionId, (record) => {
      record.status = result.stopReason === "stop" ? "completed" : result.stopReason;
      record.title = this.request.title;
      record.background = result.background;
      record.timeoutSeconds = this.request.timeoutSeconds;
      if (result.model) record.model = result.model;
      record.totalTurns += result.turns;
      record.totalDurationMs += result.durationMs;
      addUsageTotals(record.totalUsage, result.usage);
      record.lastActivity = this.lastActivity;
      record.lastError = result.errorMessage;
      if (this.worktreeState) record.worktree = this.worktreeState;
    });
    // 落盘失败（如磁盘满）不能阻止调用方拿到结果。
    let persisted = false;
    try {
      persisted = this.store?.syncPersistence(this.childSessionId, this.request.sessionManager) ?? false;
      if (persisted) {
        this.request.sessionManager.appendCustomEntry(SUBAGENT_RUN_ENTRY_TYPE, {
          title: this.request.title,
          stopReason: result.stopReason,
          durationMs: result.durationMs,
          model: result.model || undefined,
          errorMessage: result.errorMessage,
          worktree: this.worktreeState ?? this.request.existingWorktree,
        } satisfies SubagentRunEntryData);
      }
    } catch {
      persisted = false;
    }

    const finalResult: SpawnResult = {
      ...result,
      persisted,
      worktree: result.worktree ?? this.worktreeSummary,
    };
    this.emit({ type: "remove", id: this.id, childSessionId: this.childSessionId });
    this.resolveSettled(finalResult);
    this.onSettled(this, finalResult);
  }

  private fail(error: unknown): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    clearTimeout(this.timeoutTimer);
    this.onFinished(this.childSessionId);

    const errorMessage = error instanceof Error ? error.message : String(error);
    this.store?.update(this.childSessionId, (record) => {
      record.status = "error";
      record.title = this.request.title;
      record.background = this.background;
      record.timeoutSeconds = this.request.timeoutSeconds;
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
    const { profile, task, model, thinkingLevel, sessionManager, projectTrusted, isolation, existingWorktree } =
      this.request;

    if (isolation === "worktree") {
      const worktreeState = await prepareWorktree({
        cwd: this.cwd,
        agentName: this.name,
        childSessionId: this.childSessionId,
        existing: existingWorktree,
        worktreesRootDir: this.worktreesRootDir,
      });
      this.worktreeState = worktreeState;
      this.store?.update(this.childSessionId, (record) => {
        record.worktree = worktreeState;
      });
      this.publish();
    }

    const effectiveCwd = this.worktreeState?.cwd ?? this.cwd;
    let result: SpawnResult;

    try {
      if (this.aborted) {
        result = this.buildResult("aborted");
      } else {
        const material = await this.request.prepare(this.controller.signal, effectiveCwd);
        if (this.aborted) {
          result = this.buildResult("aborted");
        } else {
          const session = await this.createSessionFn({
            cwd: effectiveCwd,
            profile,
            model,
            modelRuntime: this.modelRuntime,
            thinkingLevel,
            sessionManager,
            projectTrusted,
          });
          this.session = session;
          this.sessionCreated = true;
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

            if (this.aborted) {
              result = this.buildResult("aborted");
            } else {
              while (this.pendingSteers.length > 0) {
                const queued = this.pendingSteers.shift()!;
                await session.steer(queued, undefined, { source: "extension" });
              }
              if (this.aborted) {
                result = this.buildResult("aborted");
              } else {
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
                  await session.prompt(material ? `${task}\n\n${material}` : task);
                } finally {
                  unsubscribe();
                  this.syncUsage();
                  this.store?.syncPersistence(this.childSessionId, sessionManager);
                }

                if (this.aborted) result = this.buildResult("aborted");
                else if (this.turnLimitReached) result = this.buildResult("max_turns");
                // agent-loop 把 provider 错误编码成 assistant stopReason === "error"，而不是 reject prompt()。
                else if (this.lastStopReason === "error") {
                  result = this.buildResult("error", this.lastErrorMessage ?? "Subagent failed");
                } else {
                  result = this.buildResult("stop");
                }
              }
            }
          } finally {
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
        }
      }
    } finally {
      if (this.worktreeState) {
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
    }

    return this.worktreeSummary ? { ...result, worktree: this.worktreeSummary } : result;
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

export class SubagentManager {
  private pending: AgentThread[] = [];
  private readonly running = new Set<AgentThread>();
  private readonly activeByChildId = new Map<string, AgentThread>();
  private readonly signalCleanups = new Map<string, () => void>();
  private readonly lastResults = new Map<string, { result: SpawnResult; consumed: boolean }>();
  private readonly consumingWaiters = new Map<string, number>();
  private readonly cancelOptions = new Map<string, { notify: boolean }>();
  private shuttingDown = false;
  private readonly listeners = new Set<(event: SubagentManagerEvent) => void>();
  private readonly store?: SubagentStore;
  private readonly createSessionFn: (options: CreateChildSessionOptions) => Promise<AgentSession>;
  private readonly worktreesRootDir?: string;

  constructor(
    private readonly cwd: string,
    private readonly maxConcurrent: number,
    private readonly modelRuntime: ModelRuntime | undefined,
    options: SubagentManagerOptions = {},
  ) {
    this.store = options.store;
    this.createSessionFn = options.createSession ?? createChildSession;
    this.worktreesRootDir = options.worktreesRootDir;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  isChildActive(childSessionId: string): boolean {
    return this.activeByChildId.has(childSessionId);
  }

  getSnapshot(childSessionId: string): AgentThreadSnapshot | undefined {
    return this.activeByChildId.get(childSessionId)?.snapshot();
  }

  listSnapshots(): AgentThreadSnapshot[] {
    return [...this.activeByChildId.values()].map((thread) => thread.snapshot());
  }

  getRecentToolTrace(childSessionId: string, limit = 5): ToolTraceEntry[] {
    return this.activeByChildId.get(childSessionId)?.getRecentToolTrace(limit) ?? [];
  }

  getActiveBranch(childSessionId: string): SessionEntry[] | undefined {
    return this.activeByChildId.get(childSessionId)?.getActiveBranch();
  }

  getLastResult(childSessionId: string, options?: { consume?: boolean }): SpawnResult | undefined {
    const entry = this.lastResults.get(childSessionId);
    if (!entry) return undefined;
    if (options?.consume) entry.consumed = true;
    return entry.result;
  }

  /** 将正在排队或运行中的前台任务移到后台，解绑调用方 signal 并通知调用方提前返回。 */
  detach(childSessionId: string): boolean {
    const thread = this.activeByChildId.get(childSessionId);
    if (!thread || thread.background) return false;
    this.signalCleanups.get(childSessionId)?.();
    this.signalCleanups.delete(childSessionId);
    thread.markBackground();
    this.emit({ type: "detached", childSessionId });
    return true;
  }

  /** 取消单个排队或运行中的子任务；已结束时幂等返回上次结果。notify 为 true 时对后台任务发出不触发 turn 的通知。 */
  async cancel(childSessionId: string, options?: { notify?: boolean }): Promise<SpawnResult | undefined> {
    const thread = this.activeByChildId.get(childSessionId);
    if (!thread) {
      return this.getLastResult(childSessionId, { consume: true });
    }
    this.cancelOptions.set(childSessionId, { notify: Boolean(options?.notify) });
    if (thread.phase === "pending") {
      this.pending = this.pending.filter((item) => item !== thread);
      thread.settleAborted();
    } else {
      await thread.abort();
    }
    return thread.settled.catch(() => undefined);
  }

  /** 等待子任务完成；waitSeconds 超时或 signal 中止仅结束等待，不中止子任务。 */
  async wait(
    childSessionId: string,
    options?: { waitSeconds?: number; signal?: AbortSignal; consume?: boolean },
  ): Promise<WaitResult | undefined> {
    const consume = options?.consume ?? true;
    const thread = this.activeByChildId.get(childSessionId);
    if (!thread) {
      const last = this.getLastResult(childSessionId, { consume });
      return last ? { done: true, result: last } : undefined;
    }

    if (options?.signal?.aborted) {
      return { done: false, reason: "aborted", snapshot: thread.snapshot() };
    }

    if (consume) {
      this.consumingWaiters.set(childSessionId, (this.consumingWaiters.get(childSessionId) ?? 0) + 1);
    }

    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const racers: Array<Promise<WaitResult>> = [
        thread.settled.then(
          (result): WaitResult => ({ done: true, result }),
          (): WaitResult => ({ done: false, reason: "aborted", snapshot: thread.snapshot() }),
        ),
      ];
      if (options?.waitSeconds !== undefined) {
        racers.push(
          new Promise<WaitResult>((resolve) => {
            timer = setTimeout(() => {
              resolve({ done: false, reason: "timeout", snapshot: thread.snapshot() });
            }, options.waitSeconds! * 1000);
          }),
        );
      }
      if (options?.signal) {
        const sig = options.signal;
        racers.push(
          new Promise<WaitResult>((resolve) => {
            onAbort = () => resolve({ done: false, reason: "aborted", snapshot: thread.snapshot() });
            sig.addEventListener("abort", onAbort, { once: true });
          }),
        );
      }
      return await Promise.race(racers);
    } finally {
      if (timer) clearTimeout(timer);
      if (options?.signal && onAbort) {
        options.signal.removeEventListener("abort", onAbort);
      }
      if (consume) {
        const nextCount = (this.consumingWaiters.get(childSessionId) ?? 1) - 1;
        if (nextCount <= 0) this.consumingWaiters.delete(childSessionId);
        else this.consumingWaiters.set(childSessionId, nextCount);
      }
    }
  }

  /** 向活跃子任务发送纠偏指令；若任务已结束则返回终态以便调用方改用 resume。 */
  async steer(childSessionId: string, message: string): Promise<SteerResult> {
    const thread = this.activeByChildId.get(childSessionId);
    if (thread) {
      const queued = await thread.steer(message);
      return { ok: true, queued };
    }
    const record = this.store?.get(childSessionId);
    if (record) {
      return { ok: false, reason: "not_active", status: record.status };
    }
    const last = this.lastResults.get(childSessionId);
    if (last) {
      const status: SubagentStatus = last.result.stopReason === "stop" ? "completed" : last.result.stopReason;
      return { ok: false, reason: "not_active", status };
    }
    return { ok: false, reason: "not_found" };
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

    this.lastResults.delete(req.childSessionId);
    this.cancelOptions.delete(req.childSessionId);

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
        this.signalCleanups.get(childSessionId)?.();
        this.signalCleanups.delete(childSessionId);
      },
      (settledThread, result) => {
        const cancelOption = this.cancelOptions.get(settledThread.childSessionId);
        this.cancelOptions.delete(settledThread.childSessionId);
        const hasConsumer = (this.consumingWaiters.get(settledThread.childSessionId) ?? 0) > 0;
        const silentCancel = Boolean(cancelOption && !cancelOption.notify);
        const consumed = !settledThread.background || silentCancel || hasConsumer;
        this.lastResults.set(settledThread.childSessionId, { result, consumed });

        if (settledThread.background && !this.shuttingDown && !consumed) {
          this.emit({
            type: "background_settled",
            result,
            name: settledThread.name,
            title: settledThread.title,
            triggerTurn: !cancelOption,
          });
        }
      },
      this.worktreesRootDir,
    );

    this.activeByChildId.set(req.childSessionId, thread);
    this.store?.update(req.childSessionId, (record) => {
      record.status = "pending";
      record.title = req.title;
      record.background = Boolean(req.background);
      record.timeoutSeconds = req.timeoutSeconds;
      record.lastError = undefined;
    });

    this.pending.push(thread);
    this.emit({ type: "upsert", snapshot: thread.snapshot() });

    if (signal && !req.background) {
      const onAbort = () => {
        if (thread.phase === "pending") {
          this.pending = this.pending.filter((item) => item !== thread);
          thread.settleAborted();
        } else {
          void thread.abort();
        }
      };
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      this.signalCleanups.set(req.childSessionId, cleanup);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
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
