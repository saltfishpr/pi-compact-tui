import type { AgentSession, ModelRuntime, SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  stopReasonToStatus,
  type AgentThreadSnapshot,
  type SpawnResult,
  type SubagentStatus,
  type ToolTraceEntry,
} from "../types";
import { createChildSession, type CreateChildSessionOptions } from "./child-session";
import type { SubagentStore } from "./store";
import { AgentThread, MAX_TOOL_TRACE_ENTRIES, trimToolTrace, type SpawnRequest } from "./thread";

export { MAX_TOOL_TRACE_ENTRIES, trimToolTrace, type SpawnRequest };

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

export interface SubagentManagerOptions {
  store?: SubagentStore;
  createSession?: (options: CreateChildSessionOptions) => Promise<AgentSession>;
  worktreesRootDir?: string;
}

/** 追踪后台结果缓存、阻塞等待消费者与取消通知策略。 */
class CompletionTracker {
  private readonly lastResults = new Map<string, { result: SpawnResult; consumed: boolean }>();
  private readonly consumingWaiters = new Map<string, number>();
  private readonly cancelOptions = new Map<string, { notify: boolean }>();

  resetForSpawn(childSessionId: string): void {
    this.lastResults.delete(childSessionId);
    this.cancelOptions.delete(childSessionId);
  }

  markCancelling(childSessionId: string, notify: boolean): void {
    this.cancelOptions.set(childSessionId, { notify });
  }

  addConsumer(childSessionId: string): void {
    this.consumingWaiters.set(childSessionId, (this.consumingWaiters.get(childSessionId) ?? 0) + 1);
  }

  removeConsumer(childSessionId: string): void {
    const nextCount = (this.consumingWaiters.get(childSessionId) ?? 1) - 1;
    if (nextCount <= 0) this.consumingWaiters.delete(childSessionId);
    else this.consumingWaiters.set(childSessionId, nextCount);
  }

  getLastResult(childSessionId: string, consume = false): SpawnResult | undefined {
    const entry = this.lastResults.get(childSessionId);
    if (!entry) return undefined;
    if (consume) entry.consumed = true;
    return entry.result;
  }

  recordSettled(
    childSessionId: string,
    background: boolean,
    result: SpawnResult,
    shuttingDown: boolean,
  ): { shouldNotify: boolean; triggerTurn: boolean } {
    const cancelOption = this.cancelOptions.get(childSessionId);
    this.cancelOptions.delete(childSessionId);
    const hasConsumer = (this.consumingWaiters.get(childSessionId) ?? 0) > 0;
    const silentCancel = Boolean(cancelOption && !cancelOption.notify);
    const consumed = !background || silentCancel || hasConsumer;
    this.lastResults.set(childSessionId, { result, consumed });

    return {
      shouldNotify: background && !shuttingDown && !consumed,
      triggerTurn: !cancelOption,
    };
  }
}

export class SubagentManager {
  private pending: AgentThread[] = [];
  private readonly running = new Set<AgentThread>();
  private readonly activeByChildId = new Map<string, AgentThread>();
  private readonly signalCleanups = new Map<string, () => void>();
  private readonly completions = new CompletionTracker();
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
    return this.completions.getLastResult(childSessionId, Boolean(options?.consume));
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
    this.completions.markCancelling(childSessionId, Boolean(options?.notify));
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

    if (consume) this.completions.addConsumer(childSessionId);

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
      if (consume) this.completions.removeConsumer(childSessionId);
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
    const last = this.completions.getLastResult(childSessionId);
    if (last) {
      const status: SubagentStatus = stopReasonToStatus(last.stopReason);
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

    this.completions.resetForSpawn(req.childSessionId);

    const thread = new AgentThread(req, {
      cwd: this.cwd,
      modelRuntime: this.modelRuntime,
      store: this.store,
      createSession: this.createSessionFn,
      emit: (event) => this.emit(event),
      onFinished: (childSessionId) => {
        if (this.activeByChildId.get(childSessionId) === thread) {
          this.activeByChildId.delete(childSessionId);
        }
        this.signalCleanups.get(childSessionId)?.();
        this.signalCleanups.delete(childSessionId);
      },
      onSettled: (settledThread, result) => {
        const decision = this.completions.recordSettled(
          settledThread.childSessionId,
          settledThread.background,
          result,
          this.shuttingDown,
        );
        if (decision.shouldNotify) {
          this.emit({
            type: "background_settled",
            result,
            name: settledThread.name,
            title: settledThread.title,
            triggerTurn: decision.triggerTurn,
          });
        }
      },
      worktreesRootDir: this.worktreesRootDir,
    });

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
