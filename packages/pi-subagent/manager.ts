import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../pi-common";
import type { AgentProfile } from "./agents";
import { createChildSession } from "./child-session";

export type SpawnStopReason = "stop" | "aborted" | "max_turns";

/** 一次子会话运行的结果（与 tool result 的 envelope 无关，由 agent tool 组装成 AgentToolResult）。 */
export interface SpawnResult {
  text: string;
  model: string;
  turns: number;
  durationMs: number;
  usage: UsageTotals;
  stopReason: SpawnStopReason;
}

export type ThreadPhase = "pending" | "running";

type AgentThreadActivity =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, any> };

export interface AgentThreadSnapshot {
  id: string;
  name: string;
  title: string;
  phase: ThreadPhase;
  startedAt: number;
  runningSince?: number;
  turns: number;
  usage: UsageTotals;
  model: string;
  lastActivity?: AgentThreadActivity;
}

export type SubagentManagerEvent = { type: "upsert"; snapshot: AgentThreadSnapshot } | { type: "remove"; id: string };

export interface SpawnRequest {
  id: string; // toolCallId
  profile: AgentProfile;
  title: string;
  task: string;
  model: Model<any>;
  thinkingLevel: ModelThinkingLevel;
}

/** 一个子任务派发的运行时单元：拥有隔离子会话并驱动其生命周期。 */
class AgentThread {
  readonly id: string;
  phase: ThreadPhase = "pending";
  readonly startedAt = Date.now();
  runningSince?: number;
  turns = 0;
  usage = createUsageTotals();
  model = "";
  lastActivity?: AgentThreadActivity;
  readonly settled: Promise<SpawnResult>;

  private session?: AgentSession;
  private aborted = false;
  private turnLimitReached = false;
  private lastStopReason = "";
  private lastErrorMessage?: string;
  private lastAssistantText = "";
  private settledFlag = false;
  private resolveSettled!: (result: SpawnResult) => void;
  private rejectSettled!: (error: unknown) => void;

  constructor(
    private readonly request: SpawnRequest,
    private readonly cwd: string,
    private readonly emit: (event: SubagentManagerEvent) => void,
  ) {
    this.id = request.id;
    this.settled = new Promise((resolve, reject) => {
      this.resolveSettled = resolve;
      this.rejectSettled = reject;
    });
  }

  snapshot(): AgentThreadSnapshot {
    return {
      id: this.id,
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
    this.publish();
    try {
      this.settle(await this.run());
    } catch (error) {
      this.fail(error);
    }
  }

  /** 运行中的线程：中止子会话；`run()` 会观察到 aborted 并以 aborted 结果收尾。 */
  async abort(): Promise<void> {
    this.aborted = true;
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
    this.emit({ type: "remove", id: this.id });
    this.resolveSettled(result);
  }

  private fail(error: unknown): void {
    if (this.settledFlag) return;
    this.settledFlag = true;
    this.emit({ type: "remove", id: this.id });
    this.rejectSettled(error);
  }

  private async run(): Promise<SpawnResult> {
    const { profile, task, model, thinkingLevel } = this.request;

    const session = await createChildSession({ cwd: this.cwd, profile, model, thinkingLevel });
    this.session = session;
    try {
      await session.bindExtensions({
        mode: "print",
        onError: (error) => {
          process.stderr.write(
            `[pi-subagent] extension error (${error.extensionPath}) ${error.event}: ${error.error}\n`,
          );
        },
      });

      if (this.aborted) return this.buildResult("aborted");

      const maxTurns = this.request.profile.maxTurns;
      session.agent.shouldStopAfterTurn = () => {
        this.turns++;
        this.publish();
        if (maxTurns && this.turns >= maxTurns) {
          this.turnLimitReached = true;
          return true;
        }
        return false;
      };

      const unsubscribe = session.subscribe((event) => this.onEvent(event));
      try {
        await session.prompt(task);
      } finally {
        unsubscribe();
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

  private onEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "tool_execution_start": {
        this.lastActivity = { type: "toolCall", name: event.toolName, args: event.args };
        this.publish();
        break;
      }
      case "message_end": {
        const message = event.message;
        if (message.role === "assistant") {
          if (message.usage) addUsageToTotals(this.usage, message.usage);
          if (!this.model && message.model) this.model = message.model;
          this.lastStopReason = message.stopReason;
          this.lastErrorMessage = message.errorMessage;
          const text = message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          if (text.trim()) this.lastActivity = { type: "text", text };
          this.lastAssistantText = text; // 记录最后一条 AssistantMessage 的文本，即使为空
          this.publish();
        }
      }
    }
  }

  private buildResult(stopReason: SpawnStopReason): SpawnResult {
    return {
      text: this.lastAssistantText || "(no output)",
      model: this.model,
      turns: this.turns,
      durationMs: Date.now() - this.startedAt,
      usage: this.usage,
      stopReason,
    };
  }
}

export class SubagentManager {
  private pending: AgentThread[] = [];
  private readonly running = new Set<AgentThread>();
  private shuttingDown = false;
  private readonly listeners = new Set<(event: SubagentManagerEvent) => void>();

  constructor(
    private readonly cwd: string,
    private readonly maxConcurrent: number,
  ) {}

  spawn(req: SpawnRequest, signal?: AbortSignal): Promise<SpawnResult> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("Subagent manager is shutting down"));
    }

    const thread = new AgentThread(req, this.cwd, (event) => this.emit(event));
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
    await Promise.all(running.map((thread) => thread.settled));
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
