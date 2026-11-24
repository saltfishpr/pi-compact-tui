import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SubagentStore } from "./store";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-store-"));
  tempDirs.push(dir);
  return dir;
}

function appendSampleConversation(sm: SessionManager, userText: string, assistantText: string): void {
  sm.appendMessage({
    role: "user",
    content: [{ type: "text", text: userText }],
    timestamp: Date.now(),
  });
  sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: assistantText }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: {
      input: 100,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 140,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SubagentStore", () => {
  it("isolates persisted child sessions under subagents/<parentSessionId> without polluting SessionManager.list()", async () => {
    const root = createTempDir();
    const cwd = join(root, "workspace");
    const sessionDir = join(root, "sessions");
    const parentSm = SessionManager.create(cwd, sessionDir);
    appendSampleConversation(parentSm, "hello parent", "hi parent");

    const store = new SubagentStore(cwd, parentSm);
    expect(store.isPersistent).toBe(true);
    expect(store.subagentDir).toBe(join(sessionDir, "subagents", parentSm.getSessionId()));

    const created = store.createSession("explore", "Inspect repo");
    expect(created.record.persisted).toBe(false);
    // 尚未追加对话消息，文件未落盘，不可 resume
    expect(() => store.openSessionForResume(created.childSessionId)).toThrow(/no persisted transcript/i);

    appendSampleConversation(created.sessionManager, "find entry point", "index.ts is the entry");
    expect(store.syncPersistence(created.childSessionId, created.sessionManager)).toBe(true);
    expect(created.record.sessionFile).toBeDefined();
    expect(existsSync(created.record.sessionFile!)).toBe(true);

    // 主会话目录 list() 不包含子会话
    const parentSessions = await SessionManager.list(cwd, sessionDir);
    expect(parentSessions.map((s) => s.id)).toEqual([parentSm.getSessionId()]);

    // 可正常 resume 且保留原 ID 与历史
    const resumed = store.openSessionForResume(created.childSessionId);
    expect(resumed.sessionManager.getSessionId()).toBe(created.childSessionId);
    expect(resumed.sessionManager.getBranch().some((entry) => entry.type === "message")).toBe(true);
  });

  it("rebuilds index after parent restart using persisted child JSONL and parent toolResult details", () => {
    const root = createTempDir();
    const cwd = join(root, "workspace");
    const sessionDir = join(root, "sessions");
    const parentSm = SessionManager.create(cwd, sessionDir);
    appendSampleConversation(parentSm, "start", "ok");

    const store1 = new SubagentStore(cwd, parentSm);
    const created = store1.createSession("reviewer", "Review PR");
    appendSampleConversation(created.sessionManager, "review diff", "looks good");
    store1.syncPersistence(created.childSessionId, created.sessionManager);

    // 模拟父会话中落盘了两次 agent toolResult（首次 + resume）
    parentSm.appendMessage({
      role: "toolResult",
      toolCallId: "tc-1",
      toolName: "agent",
      content: [{ type: "text", text: "looks good" }],
      isError: false,
      timestamp: Date.now(),
      details: {
        childSessionId: created.childSessionId,
        name: "reviewer",
        title: "Review PR",
        model: "claude-sonnet-4-5",
        turns: 2,
        durationMs: 1200,
        usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0.003 },
        stopReason: "stop",
      },
    });
    parentSm.appendMessage({
      role: "toolResult",
      toolCallId: "tc-2",
      toolName: "agent",
      content: [{ type: "text", text: "follow-up ok" }],
      isError: false,
      timestamp: Date.now() + 1000,
      details: {
        childSessionId: created.childSessionId,
        resumed: true,
        name: "reviewer",
        title: "Review PR follow-up",
        model: "claude-sonnet-4-5",
        turns: 1,
        durationMs: 800,
        usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
        stopReason: "max_turns",
      },
    });

    // 模拟重启后重新打开父会话
    const reopenedParent = SessionManager.open(parentSm.getSessionFile()!, sessionDir);
    const store2 = new SubagentStore(cwd, reopenedParent);
    const restored = store2.get(created.childSessionId);

    expect(restored).toBeDefined();
    expect(restored!.name).toBe("reviewer");
    expect(restored!.title).toBe("Review PR follow-up");
    expect(restored!.totalTurns).toBe(3);
    expect(restored!.totalDurationMs).toBe(2000);
    expect(restored!.totalUsage.input).toBe(150);
    expect(restored!.totalUsage.output).toBe(60);
    expect(restored!.status).toBe("max_turns");
    expect(restored!.persisted).toBe(true);
    expect(store2.loadTranscript(created.childSessionId).length).toBeGreaterThan(0);
  });

  it("rejects resuming a child session from a forked parent session", () => {
    const root = createTempDir();
    const cwd = join(root, "workspace");
    const sessionDir = join(root, "sessions");
    const parentSm = SessionManager.create(cwd, sessionDir);
    appendSampleConversation(parentSm, "hello", "world");

    const store1 = new SubagentStore(cwd, parentSm);
    const created = store1.createSession("explore", "Original explore");
    appendSampleConversation(created.sessionManager, "q1", "a1");
    store1.syncPersistence(created.childSessionId, created.sessionManager);

    // 模拟父会话 fork 出新 sessionId
    const forkedParent = SessionManager.forkFrom(parentSm.getSessionFile()!, cwd, sessionDir);
    const forkedStore = new SubagentStore(cwd, forkedParent);
    expect(forkedStore.get(created.childSessionId)).toBeUndefined();
    expect(() => forkedStore.openSessionForResume(created.childSessionId)).toThrow(/Unknown subagent session/i);
  });

  it("supports in-memory fallback when parent session is not persisted", () => {
    const parentSm = SessionManager.inMemory("/tmp/workspace");
    const store = new SubagentStore("/tmp/workspace", parentSm);

    expect(store.isPersistent).toBe(false);
    expect(store.subagentDir).toBeUndefined();

    const created = store.createSession("worker", "In-memory task");
    expect(() => store.openSessionForResume(created.childSessionId)).toThrow(/no conversation history/i);

    appendSampleConversation(created.sessionManager, "edit file", "done");
    expect(store.syncPersistence(created.childSessionId, created.sessionManager)).toBe(true);

    const resumed = store.openSessionForResume(created.childSessionId);
    expect(resumed.sessionManager).toBe(created.sessionManager);
    expect(store.loadTranscript(created.childSessionId).length).toBeGreaterThan(0);
  });
});
