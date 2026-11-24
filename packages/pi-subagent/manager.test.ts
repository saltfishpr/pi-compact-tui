import type { Model } from "@earendil-works/pi-ai";
import { SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

vi.mock("./logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { AgentProfile } from "./agents";
import type { CreateChildSessionOptions } from "./child-session";
import { MAX_TOOL_TRACE_ENTRIES, SubagentManager, trimToolTrace } from "./manager";
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
      abort: async () => undefined,
      dispose: () => undefined,
      prompt: async (promptText: string) => {
        if (script.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, script.delayMs));
        }

        sm.appendMessage({
          role: "user",
          content: [{ type: "text", text: promptText }],
          timestamp: Date.now(),
        });
        for (const listener of listeners) {
          listener({ type: "entry_appended", entry: sm.getLeafEntry()! } as AgentSessionEvent);
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
});
