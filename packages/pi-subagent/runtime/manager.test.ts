import type { Model } from "@earendil-works/pi-ai";
import { SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { AgentProfile } from "../types";
import type { CreateChildSessionOptions } from "./child-session";
import { MAX_TOOL_TRACE_ENTRIES, SubagentManager, trimToolTrace, type SpawnRequest } from "./manager";
import { SubagentStore } from "./store";

const MOCK_MODEL = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 8192,
} as unknown as Model<any>;

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "explore",
    source: "builtin",
    description: "Explore codebase",
    body: "You explore code.",
    path: "/mock/explore.md",
    sha256: "a".repeat(64),
    commands: [],
    maxTurns: 50,
    ...overrides,
  };
}

interface FakeRunScript {
  turns: Array<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    tools?: Array<{ id: string; name: string; args: Record<string, unknown>; isError?: boolean }>;
  }>;
  delayMs?: number;
  /** prompt 挂起直到 session.abort() 或调用方手动释放。 */
  hang?: boolean;
  /** 外部注入的挂起释放钩子，便于测试运行中 steer / detach。 */
  onPromptStarted?: (controls: { finish: () => void }) => void;
  /** 记录该 session 收到的 steer 调用。 */
  onSteer?: (message: string, images: unknown, options: unknown) => void;
  /** 未产生任何消息就抛错。 */
  throwBeforeMessages?: string;
  /** 追加一条 stopReason 为 error 的 assistant 消息。 */
  providerError?: string;
}

function createFakeSessionFactory(scripts: FakeRunScript[]) {
  let runIndex = 0;

  return async (options: CreateChildSessionOptions): Promise<AgentSession> => {
    const script = scripts[runIndex++] ?? {
      turns: [{ text: "ok", inputTokens: 10, outputTokens: 5, cost: 0.001 }],
    };

    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const sm = options.sessionManager;

    const computeStats = () => {
      let input = 0;
      let output = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let cost = 0;
      for (const entry of sm.getEntries()) {
        if (entry.type === "message" && entry.message.role === "assistant" && entry.message.usage) {
          input += entry.message.usage.input;
          output += entry.message.usage.output;
          cacheRead += entry.message.usage.cacheRead;
          cacheWrite += entry.message.usage.cacheWrite;
          cost += entry.message.usage.cost.total;
        }
      }
      return {
        tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
        cost,
      };
    };

    let releaseHang: (() => void) | undefined;
    const agent: { finishTurn?: (ctx: { message: any }) => { action: "end" } | void } = {};

    const session = {
      sessionManager: sm,
      agent,
      extensionRunner: {
        hasHandlers: () => false,
        emit: async () => undefined,
      },
      bindExtensions: async () => undefined,
      subscribe: (listener: (event: AgentSessionEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSessionStats: computeStats,
      abort: async () => {
        releaseHang?.();
      },
      steer: async (text: string, images?: unknown, steerOptions?: unknown) => {
        script.onSteer?.(text, images, steerOptions);
        return "queued";
      },
      dispose: () => undefined,
      prompt: async (promptText: string) => {
        if (script.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, script.delayMs));
        }
        if (script.throwBeforeMessages) throw new Error(script.throwBeforeMessages);

        sm.appendMessage({
          role: "user",
          content: [{ type: "text", text: promptText }],
          timestamp: Date.now(),
        });
        for (const listener of listeners) {
          listener({ type: "entry_appended", entry: sm.getLeafEntry()! } as AgentSessionEvent);
        }

        if (script.hang) {
          await new Promise<void>((resolve) => {
            releaseHang = resolve;
            script.onPromptStarted?.({ finish: resolve });
          });
          if (script.turns.length === 0) return;
        }

        if (script.providerError) {
          const errorMessage = {
            role: "assistant" as const,
            content: [],
            api: "anthropic-messages" as const,
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            usage: {
              input: 1,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 1,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error" as const,
            errorMessage: script.providerError,
            timestamp: Date.now(),
          };
          for (const listener of listeners) listener({ type: "message_end", message: errorMessage } as AgentSessionEvent);
          sm.appendMessage(errorMessage);
          return;
        }

        for (const turn of script.turns) {
          for (const tool of turn.tools ?? []) {
            for (const listener of listeners) {
              listener({
                type: "tool_execution_start",
                toolCallId: tool.id,
                toolName: tool.name,
                args: tool.args,
              } as AgentSessionEvent);
              listener({
                type: "tool_execution_end",
                toolCallId: tool.id,
                toolName: tool.name,
                result: { content: [], details: {} },
                isError: Boolean(tool.isError),
              } as AgentSessionEvent);
            }
          }

          const assistantMessage = {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: turn.text }],
            api: "anthropic-messages" as const,
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            usage: {
              input: turn.inputTokens,
              output: turn.outputTokens,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: turn.inputTokens + turn.outputTokens,
              cost: { input: turn.cost / 2, output: turn.cost / 2, cacheRead: 0, cacheWrite: 0, total: turn.cost },
            },
            stopReason: "stop" as const,
            timestamp: Date.now(),
          };

          for (const listener of listeners) {
            listener({ type: "message_end", message: assistantMessage } as AgentSessionEvent);
          }
          sm.appendMessage(assistantMessage);
          for (const listener of listeners) {
            listener({ type: "entry_appended", entry: sm.getLeafEntry()! } as AgentSessionEvent);
          }

          const decision = agent.finishTurn?.({ message: assistantMessage });
          if (decision?.action === "end") break;
        }
      },
    };

    return session as unknown as AgentSession;
  };
}

describe("SubagentManager", () => {
  it("preserves childSessionId across resume, tracks incremental vs cumulative usage, and resets maxTurns budget", async () => {
    const parentSm = SessionManager.inMemory("/tmp/workspace");
    const store = new SubagentStore("/tmp/workspace", parentSm);
    const factory = createFakeSessionFactory([
      {
        turns: [
          {
            text: "turn 1",
            inputTokens: 100,
            outputTokens: 20,
            cost: 0.01,
            tools: [{ id: "t1", name: "read", args: { path: "src/index.ts" } }],
          },
          { text: "turn 2 hit limit", inputTokens: 150, outputTokens: 30, cost: 0.02 },
          { text: "should not execute", inputTokens: 999, outputTokens: 999, cost: 9 },
        ],
      },
      {
        turns: [
          {
            text: "resumed turn 1",
            inputTokens: 80,
            outputTokens: 15,
            cost: 0.005,
            tools: [{ id: "t2", name: "bash", args: { command: "pnpm test" }, isError: true }],
          },
        ],
      },
    ]);

    const manager = new SubagentManager("/tmp/workspace", 4, undefined, {
      store,
      createSession: factory,
    });

    const profile = makeProfile({ maxTurns: 2 });
    const created = store.createSession(profile.name, "Initial exploration");
    const prepareFirst = vi.fn(async () => "pre-run material");

    const firstResult = await manager.spawn({
      id: "tool-call-1",
      childSessionId: created.childSessionId,
      sessionManager: created.sessionManager,
      resumed: false,
      profile,
      title: "Initial exploration",
      task: "Find main entry",
      model: MOCK_MODEL,
      thinkingLevel: "medium",
      projectTrusted: true,
      prepare: prepareFirst,
    });

    expect(prepareFirst).toHaveBeenCalledTimes(1);
    expect(firstResult.childSessionId).toBe(created.childSessionId);
    expect(firstResult.stopReason).toBe("max_turns");
    expect(firstResult.turns).toBe(2);
    expect(firstResult.usage.input).toBe(250);
    expect(firstResult.usage.output).toBe(50);
    expect(firstResult.usage.cost).toBeCloseTo(0.03);
    expect(firstResult.toolTrace).toEqual([{ name: "read", summary: "read src/index.ts" }]);

    // 续聊：childSessionId 保持不变，usage 为本次增量，Store 中为累计总量
    const opened = store.openSessionForResume(created.childSessionId);
    const secondResult = await manager.spawn({
      id: "tool-call-2",
      childSessionId: created.childSessionId,
      sessionManager: opened.sessionManager,
      resumed: true,
      profile,
      title: "Initial exploration",
      task: "Continue finishing",
      model: MOCK_MODEL,
      thinkingLevel: "medium",
      projectTrusted: true,
      prepare: async () => "",
    });

    expect(secondResult.childSessionId).toBe(created.childSessionId);
    expect(secondResult.resumed).toBe(true);
    expect(secondResult.stopReason).toBe("stop");
    expect(secondResult.turns).toBe(1);
    expect(secondResult.usage.input).toBe(80);
    expect(secondResult.usage.output).toBe(15);
    expect(secondResult.usage.cost).toBeCloseTo(0.005);
    expect(secondResult.toolTrace).toEqual([{ name: "bash", summary: "$ pnpm test", isError: true }]);

    const record = store.get(created.childSessionId)!;
    expect(record.status).toBe("completed");
    expect(record.totalTurns).toBe(3);
    expect(record.totalUsage.input).toBe(330);
    expect(record.totalUsage.output).toBe(65);
    expect(record.totalUsage.cost).toBeCloseTo(0.035);
  });

  it("rejects concurrent resume targeting the same childSessionId", async () => {
    const parentSm = SessionManager.inMemory("/tmp/workspace");
    const store = new SubagentStore("/tmp/workspace", parentSm);
    const factory = createFakeSessionFactory([
      {
        delayMs: 50,
        turns: [{ text: "slow run", inputTokens: 10, outputTokens: 5, cost: 0.001 }],
      },
    ]);

    const manager = new SubagentManager("/tmp/workspace", 4, undefined, {
      store,
      createSession: factory,
    });

    const profile = makeProfile();
    const created = store.createSession(profile.name, "Concurrent guard");

    const firstPromise = manager.spawn({
      id: "tc-a",
      childSessionId: created.childSessionId,
      sessionManager: created.sessionManager,
      resumed: false,
      profile,
      title: "Concurrent guard",
      task: "task 1",
      model: MOCK_MODEL,
      thinkingLevel: "medium",
      projectTrusted: true,
      prepare: async () => "",
    });

    await expect(
      manager.spawn({
        id: "tc-b",
        childSessionId: created.childSessionId,
        sessionManager: created.sessionManager,
        resumed: true,
        profile,
        title: "Concurrent guard",
        task: "task 2",
        model: MOCK_MODEL,
        thinkingLevel: "medium",
        projectTrusted: true,
        prepare: async () => "",
      }),
    ).rejects.toThrow(/concurrent resume is not allowed/i);

    await firstPromise;
  });

  function spawnOptions(store: SubagentStore, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
    const profile = makeProfile();
    const created = store.createSession(profile.name, "t");
    return {
      id: `tc-${created.childSessionId}`,
      childSessionId: created.childSessionId,
      sessionManager: created.sessionManager,
      resumed: false,
      profile,
      title: "t",
      task: "do it",
      model: MOCK_MODEL,
      thinkingLevel: "medium",
      projectTrusted: true,
      prepare: async () => "",
      ...overrides,
    };
  }

  it("settles provider errors as a result with persisted progress instead of rejecting", async () => {
    const store = new SubagentStore("/tmp/workspace", SessionManager.inMemory("/tmp/workspace"));
    const factory = createFakeSessionFactory([
      { turns: [], providerError: "rate limited" },
      { turns: [], throwBeforeMessages: "boom" },
    ]);
    const manager = new SubagentManager("/tmp/workspace", 4, undefined, { store, createSession: factory });

    const withProgress = await manager.spawn(spawnOptions(store));
    expect(withProgress.stopReason).toBe("error");
    expect(withProgress.errorMessage).toBe("rate limited");
    expect(withProgress.persisted).toBe(true);
    expect(store.get(withProgress.childSessionId)).toMatchObject({ status: "error", lastError: "rate limited" });

    const noProgress = await manager.spawn(spawnOptions(store));
    expect(noProgress.stopReason).toBe("error");
    expect(noProgress.errorMessage).toBe("boom");
    expect(noProgress.persisted).toBe(false);
  });

  it("times out running work, frees the slot, and does not count queue time", async () => {
    const store = new SubagentStore("/tmp/workspace", SessionManager.inMemory("/tmp/workspace"));
    const factory = createFakeSessionFactory([
      { turns: [{ text: "slow", inputTokens: 1, outputTokens: 1, cost: 0 }], delayMs: 150 },
      { turns: [{ text: "queued ok", inputTokens: 1, outputTokens: 1, cost: 0 }], delayMs: 20 },
      { turns: [], hang: true },
      { turns: [{ text: "after timeout", inputTokens: 1, outputTokens: 1, cost: 0 }] },
    ]);
    const manager = new SubagentManager("/tmp/workspace", 1, undefined, { store, createSession: factory });

    const first = manager.spawn(spawnOptions(store));
    // 排队超过 timeoutSeconds，但开始执行后只运行 20ms，不应超时。
    const queued = manager.spawn(spawnOptions(store, { timeoutSeconds: 0.1 }));
    expect((await first).stopReason).toBe("stop");
    expect((await queued).stopReason).toBe("stop");

    const hung = manager.spawn(spawnOptions(store, { timeoutSeconds: 0.05 }));
    const next = manager.spawn(spawnOptions(store));
    const hungResult = await hung;
    expect(hungResult.stopReason).toBe("timeout");
    expect(store.get(hungResult.childSessionId)!.status).toBe("timeout");
    expect((await next).text).toBe("after timeout");
  });

  it("lets a call override maxTurns", async () => {
    const store = new SubagentStore("/tmp/workspace", SessionManager.inMemory("/tmp/workspace"));
    const turns = Array.from({ length: 5 }, (_, i) => ({ text: `t${i}`, inputTokens: 1, outputTokens: 1, cost: 0 }));
    const manager = new SubagentManager("/tmp/workspace", 1, undefined, {
      store,
      createSession: createFakeSessionFactory([{ turns }]),
    });
    const result = await manager.spawn(spawnOptions(store, { maxTurns: 3 }));
    expect(result.stopReason).toBe("max_turns");
    expect(result.turns).toBe(3);
  });

  it("trims toolTrace to MAX_TOOL_TRACE_ENTRIES while preserving head and tail", () => {
    const entries = Array.from({ length: 80 }, (_, index) => ({
      name: "read",
      summary: `read file-${index}.ts`,
    }));
    const trimmed = trimToolTrace(entries);
    expect(trimmed).toHaveLength(MAX_TOOL_TRACE_ENTRIES);
    expect(trimmed[0]!.summary).toBe("read file-0.ts");
    expect(trimmed[trimmed.length - 1]!.summary).toBe("read file-79.ts");
  });

  it("ignores caller abort signal for background tasks and emits background_settled on completion", async () => {
    const store = new SubagentStore("/tmp/workspace", SessionManager.inMemory("/tmp/workspace"));
    let finishPrompt: (() => void) | undefined;
    const factory = createFakeSessionFactory([
      {
        hang: true,
        turns: [{ text: "bg done", inputTokens: 12, outputTokens: 6, cost: 0.002 }],
        onPromptStarted: ({ finish }) => {
          finishPrompt = finish;
        },
      },
    ]);
    const manager = new SubagentManager("/tmp/workspace", 2, undefined, { store, createSession: factory });
    const notifications: Array<{ childSessionId: string; text: string; background: boolean }> = [];
    manager.subscribe((event) => {
      if (event.type === "background_settled") {
        notifications.push({
          childSessionId: event.result.childSessionId,
          text: event.result.text,
          background: event.result.background,
        });
      }
    });

    const callerAbort = new AbortController();
    const req = spawnOptions(store, { background: true, title: "BG task" });
    const promise = manager.spawn(req, callerAbort.signal);

    // 等待 prompt 启动后再中止派发方 signal，后台任务不应受影响。
    await vi.waitFor(() => expect(finishPrompt).toBeDefined());
    callerAbort.abort();
    expect(manager.isChildActive(req.childSessionId)).toBe(true);

    finishPrompt!();
    const result = await promise;
    expect(result.stopReason).toBe("stop");
    expect(result.background).toBe(true);
    expect(result.text).toBe("bg done");
    expect(notifications).toEqual([{ childSessionId: req.childSessionId, text: "bg done", background: true }]);
    expect(manager.getLastResult(req.childSessionId)?.text).toBe("bg done");
  });

  it("suppresses duplicate background_settled when consumed by wait() or cancel(), and keeps running on wait timeout/abort", async () => {
    const store = new SubagentStore("/tmp/workspace", SessionManager.inMemory("/tmp/workspace"));
    const finishes: Array<() => void> = [];
    const factory = createFakeSessionFactory([
      {
        hang: true,
        turns: [{ text: "waited done", inputTokens: 10, outputTokens: 5, cost: 0.001 }],
        onPromptStarted: ({ finish }) => finishes.push(finish),
      },
      {
        hang: true,
        turns: [{ text: "cancelled", inputTokens: 10, outputTokens: 5, cost: 0.001 }],
        onPromptStarted: ({ finish }) => finishes.push(finish),
      },
      {
        hang: true,
        turns: [{ text: "after wait timeout", inputTokens: 10, outputTokens: 5, cost: 0.001 }],
        onPromptStarted: ({ finish }) => finishes.push(finish),
      },
    ]);
    const manager = new SubagentManager("/tmp/workspace", 4, undefined, { store, createSession: factory });
    const notifiedIds: string[] = [];
    manager.subscribe((event) => {
      if (event.type === "background_settled") notifiedIds.push(event.result.childSessionId);
    });

    // 1) 被 wait(consume: true) 消费 -> 不发自动通知
    const req1 = spawnOptions(store, { background: true });
    const p1 = manager.spawn(req1);
    await vi.waitFor(() => expect(finishes.length).toBeGreaterThanOrEqual(1));
    const waitPromise = manager.wait(req1.childSessionId, { consume: true });
    finishes[0]!();
    const waited = await waitPromise;
    await p1;
    expect(waited).toMatchObject({ done: true, result: { text: "waited done" } });
    expect(notifiedIds).not.toContain(req1.childSessionId);

    // 2) 被 cancel() 取消 -> 不发自动通知
    const req2 = spawnOptions(store, { background: true });
    const p2 = manager.spawn(req2);
    await vi.waitFor(() => expect(finishes.length).toBeGreaterThanOrEqual(2));
    const cancelled = await manager.cancel(req2.childSessionId);
    await p2;
    expect(cancelled?.stopReason).toBe("aborted");
    expect(notifiedIds).not.toContain(req2.childSessionId);

    // 3) waitSeconds 超时与 signal 中止只结束等待，不中止子任务，最终完成仍触发自动通知
    const req3 = spawnOptions(store, { background: true });
    const p3 = manager.spawn(req3);
    await vi.waitFor(() => expect(finishes.length).toBeGreaterThanOrEqual(3));

    const timedOutWait = await manager.wait(req3.childSessionId, { waitSeconds: 0.02, consume: true });
    expect(timedOutWait?.done).toBe(false);
    if (timedOutWait && !timedOutWait.done) expect(timedOutWait.reason).toBe("timeout");
    expect(manager.isChildActive(req3.childSessionId)).toBe(true);

    const waitAbort = new AbortController();
    const abortedWaitPromise = manager.wait(req3.childSessionId, { signal: waitAbort.signal, consume: true });
    waitAbort.abort();
    const abortedWait = await abortedWaitPromise;
    expect(abortedWait?.done).toBe(false);
    if (abortedWait && !abortedWait.done) expect(abortedWait.reason).toBe("aborted");
    expect(manager.isChildActive(req3.childSessionId)).toBe(true);

    finishes[2]!();
    await p3;
    expect(notifiedIds).toContain(req3.childSessionId);
  });

  it("detaches a foreground task to background, unbinding caller signal and notifying on finish", async () => {
    const store = new SubagentStore("/tmp/workspace", SessionManager.inMemory("/tmp/workspace"));
    let finishPrompt: (() => void) | undefined;
    const factory = createFakeSessionFactory([
      {
        hang: true,
        turns: [{ text: "detached result", inputTokens: 10, outputTokens: 5, cost: 0.001 }],
        onPromptStarted: ({ finish }) => {
          finishPrompt = finish;
        },
      },
    ]);
    const manager = new SubagentManager("/tmp/workspace", 2, undefined, { store, createSession: factory });
    const detachedIds: string[] = [];
    const notifiedIds: string[] = [];
    manager.subscribe((event) => {
      if (event.type === "detached") detachedIds.push(event.childSessionId);
      if (event.type === "background_settled") notifiedIds.push(event.result.childSessionId);
    });

    const callerAbort = new AbortController();
    const req = spawnOptions(store, { background: false });
    const settledPromise = manager.spawn(req, callerAbort.signal);
    await vi.waitFor(() => expect(finishPrompt).toBeDefined());

    expect(manager.detach(req.childSessionId)).toBe(true);
    expect(manager.detach(req.childSessionId)).toBe(false); // 幂等
    expect(detachedIds).toEqual([req.childSessionId]);
    expect(manager.getSnapshot(req.childSessionId)?.background).toBe(true);
    expect(store.get(req.childSessionId)?.background).toBe(true);

    // 原前台调用的 signal 中止不应再杀掉已移到后台的任务
    callerAbort.abort();
    expect(manager.isChildActive(req.childSessionId)).toBe(true);

    finishPrompt!();
    const result = await settledPromise;
    expect(result.stopReason).toBe("stop");
    expect(result.background).toBe(true);
    expect(notifiedIds).toEqual([req.childSessionId]);
  });

  it("steers pending (buffered), running (direct), and finished (error) subagents correctly", async () => {
    const store = new SubagentStore("/tmp/workspace", SessionManager.inMemory("/tmp/workspace"));
    const steeredCalls: Array<{ session: number; message: string; options: unknown }> = [];
    let finishFirst: (() => void) | undefined;
    let finishSecond: (() => void) | undefined;

    const factory = createFakeSessionFactory([
      {
        hang: true,
        turns: [{ text: "first done", inputTokens: 5, outputTokens: 5, cost: 0 }],
        onPromptStarted: ({ finish }) => {
          finishFirst = finish;
        },
        onSteer: (message, _images, options) => steeredCalls.push({ session: 1, message, options }),
      },
      {
        hang: true,
        turns: [{ text: "second done", inputTokens: 5, outputTokens: 5, cost: 0 }],
        onPromptStarted: ({ finish }) => {
          finishSecond = finish;
        },
        onSteer: (message, _images, options) => steeredCalls.push({ session: 2, message, options }),
      },
    ]);

    // maxConcurrent = 1，使第二个任务处于 pending 状态
    const manager = new SubagentManager("/tmp/workspace", 1, undefined, { store, createSession: factory });
    const req1 = spawnOptions(store, { background: true });
    const req2 = spawnOptions(store, { background: true });
    const p1 = manager.spawn(req1);
    const p2 = manager.spawn(req2);

    await vi.waitFor(() => expect(finishFirst).toBeDefined());

    // running 态直接 steer
    const runningSteer = await manager.steer(req1.childSessionId, "focus on tests");
    expect(runningSteer).toEqual({ ok: true, queued: false });

    // pending 态先缓冲，等 session 创建后 flush
    const pendingSteer = await manager.steer(req2.childSessionId, "check edge cases");
    expect(pendingSteer).toEqual({ ok: true, queued: true });
    expect(steeredCalls).toEqual([{ session: 1, message: "focus on tests", options: { source: "extension" } }]);

    finishFirst!();
    await p1;

    // 已结束态 steer 返回 not_active 与终态
    const finishedSteer = await manager.steer(req1.childSessionId, "too late");
    expect(finishedSteer).toEqual({ ok: false, reason: "not_active", status: "completed" });

    // 第二个任务启动后，缓冲的 steer 自动 flush 到 session.steer
    await vi.waitFor(() => expect(finishSecond).toBeDefined());
    expect(steeredCalls).toEqual([
      { session: 1, message: "focus on tests", options: { source: "extension" } },
      { session: 2, message: "check edge cases", options: { source: "extension" } },
    ]);

    finishSecond!();
    await p2;
  });

  it("does not emit background notifications on shutdown or after switching to a new manager", async () => {
    const store1 = new SubagentStore("/tmp/workspace", SessionManager.inMemory("/tmp/workspace"));
    const store2 = new SubagentStore("/tmp/workspace", SessionManager.inMemory("/tmp/workspace"));
    let finishOld: (() => void) | undefined;

    const factory1 = createFakeSessionFactory([
      {
        hang: true,
        turns: [{ text: "old done", inputTokens: 1, outputTokens: 1, cost: 0 }],
        onPromptStarted: ({ finish }) => {
          finishOld = finish;
        },
      },
    ]);
    const factory2 = createFakeSessionFactory([
      { turns: [{ text: "new done", inputTokens: 1, outputTokens: 1, cost: 0 }] },
    ]);

    const oldManager = new SubagentManager("/tmp/workspace", 2, undefined, { store: store1, createSession: factory1 });
    let currentManager: SubagentManager = oldManager;
    const delivered: string[] = [];

    const bindNotifications = (mgr: SubagentManager) => {
      mgr.subscribe((event) => {
        if (event.type !== "background_settled") return;
        if (currentManager !== mgr || mgr.isShuttingDown()) return;
        delivered.push(event.result.text);
      });
    };
    bindNotifications(oldManager);

    const oldReq = spawnOptions(store1, { background: true });
    const oldPromise = oldManager.spawn(oldReq);
    await vi.waitFor(() => expect(finishOld).toBeDefined());

    // 模拟 session_start 切换 manager 并 shutdown 旧 manager
    const newManager = new SubagentManager("/tmp/workspace", 2, undefined, { store: store2, createSession: factory2 });
    currentManager = newManager;
    bindNotifications(newManager);

    await oldManager.shutdown();
    const oldResult = await oldPromise;
    expect(oldResult.stopReason).toBe("aborted");
    expect(oldManager.isShuttingDown()).toBe(true);

    const newReq = spawnOptions(store2, { background: true });
    await newManager.spawn(newReq);
    expect(delivered).toEqual(["new done"]);
  });

  it("settles background prepare errors as error results and notifies instead of rejecting", async () => {
    const store = new SubagentStore("/tmp/workspace", SessionManager.inMemory("/tmp/workspace"));
    const manager = new SubagentManager("/tmp/workspace", 2, undefined, {
      store,
      createSession: createFakeSessionFactory([]),
    });
    const notifications: Array<{ stopReason: string; errorMessage?: string }> = [];
    manager.subscribe((event) => {
      if (event.type === "background_settled") {
        notifications.push({ stopReason: event.result.stopReason, errorMessage: event.result.errorMessage });
      }
    });

    const req = spawnOptions(store, {
      background: true,
      prepare: async () => {
        throw new Error("pre-run command failed");
      },
    });
    const result = await manager.spawn(req);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("pre-run command failed");
    expect(notifications).toEqual([{ stopReason: "error", errorMessage: "pre-run command failed" }]);
  });
});
