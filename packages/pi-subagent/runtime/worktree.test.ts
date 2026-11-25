import type { Model } from "@earendil-works/pi-ai";
import { SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { formatWorktreeSummary } from "../tools/result";
import type { AgentProfile } from "../types";
import { SubagentManager } from "./manager";
import { SubagentStore } from "./store";
import { finalizeWorktree, prepareWorktree, validateGitRepoForWorktree } from "./worktree";

const tempDirs: string[] = [];
let prevGitConfigGlobal: string | undefined;
let prevGitConfigNoSystem: string | undefined;

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runGitSync(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  });
}

function initGitRepo(repoDir: string, options?: { withCommit?: boolean }): string {
  runGitSync(["init"], repoDir);
  runGitSync(["config", "user.name", "Test User"], repoDir);
  runGitSync(["config", "user.email", "test@example.com"], repoDir);

  if (options?.withCommit === false) return "";

  mkdirSync(join(repoDir, "packages", "app"), { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# demo\n", "utf8");
  writeFileSync(join(repoDir, "packages", "app", "index.ts"), "export const value = 1;\n", "utf8");
  runGitSync(["add", "."], repoDir);
  runGitSync(["commit", "-m", "initial commit"], repoDir);
  return runGitSync(["rev-parse", "HEAD"], repoDir).trim();
}

function createProfile(name = "worker"): AgentProfile {
  return {
    name,
    source: "builtin",
    description: "test worker",
    maxTurns: 10,
    body: "You are a test worker.",
    path: `/tmp/${name}.md`,
    sha256: "a".repeat(64),
    commands: [],
  };
}

const TEST_MODEL = {
  id: "test-model",
  provider: "test",
  api: "openai-responses",
  name: "Test Model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
} as unknown as Model<any>;

function createFakeSession(
  sessionManager: SessionManager,
  onPrompt: (cwd: string) => void,
  cwd: string,
): AgentSession {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  return {
    sessionManager,
    agent: {},
    extensionRunner: {
      hasHandlers: () => false,
      emit: async () => undefined,
    },
    bindExtensions: async () => undefined,
    subscribe: (fn: (event: AgentSessionEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSessionStats: () => ({
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
      cost: 0,
    }),
    prompt: async () => {
      onPrompt(cwd);
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "done" }],
        api: TEST_MODEL.api,
        provider: TEST_MODEL.provider,
        model: TEST_MODEL.id,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      sessionManager.appendMessage({ role: "user", content: "task", timestamp: Date.now() });
      sessionManager.appendMessage(message);
      for (const listener of listeners) {
        listener({ type: "message_end", message } as AgentSessionEvent);
      }
    },
    steer: async () => undefined,
    abort: async () => undefined,
    dispose: () => undefined,
  } as unknown as AgentSession;
}

beforeAll(() => {
  prevGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  prevGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
  if (prevGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = prevGitConfigGlobal;
  if (prevGitConfigNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = prevGitConfigNoSystem;
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("worktree", () => {
  it("rejects non-git directories without falling back", async () => {
    const dir = createTempDir("pi-wt-nongit-");
    await expect(validateGitRepoForWorktree(dir)).rejects.toThrow(/not inside a Git repository/i);
    await expect(
      prepareWorktree({
        cwd: dir,
        agentName: "worker",
        childSessionId: "12345678-aaaa-bbbb-cccc-ddddeeeeffff",
        worktreesRootDir: createTempDir("pi-wt-root-"),
      }),
    ).rejects.toThrow(/not inside a Git repository/i);
  });

  it("rejects git repositories with no HEAD commit", async () => {
    const repoDir = createTempDir("pi-wt-empty-");
    initGitRepo(repoDir, { withCommit: false });
    await expect(validateGitRepoForWorktree(repoDir)).rejects.toThrow(/at least one commit/i);
  });

  it("creates an isolated worktree and maps monorepo subdirectories", async () => {
    const repoDir = createTempDir("pi-wt-mono-");
    const worktreesRootDir = createTempDir("pi-wt-root-");
    const head = initGitRepo(repoDir);
    const subDir = join(repoDir, "packages", "app");

    const state = await prepareWorktree({
      cwd: subDir,
      agentName: "worker",
      childSessionId: "01a210a0-3456-7890-abcd-ef1234567890",
      worktreesRootDir,
    });

    expect(realpathSync(state.repoRoot)).toBe(realpathSync(repoDir));
    expect(state.branch).toBe("pi-subagent/worker-34567890");
    expect(state.baseCommit).toBe(head);
    expect(existsSync(state.rootPath)).toBe(true);
    expect(realpathSync(state.cwd)).toBe(realpathSync(join(state.rootPath, "packages", "app")));
    expect(existsSync(join(state.cwd, "index.ts"))).toBe(true);
  });

  it("cleans up worktree and branch automatically when there are no changes", async () => {
    const repoDir = createTempDir("pi-wt-clean-");
    const worktreesRootDir = createTempDir("pi-wt-root-");
    initGitRepo(repoDir);

    const state = await prepareWorktree({
      cwd: repoDir,
      agentName: "worker",
      childSessionId: "clean123-0000-0000-0000-000000000000",
      worktreesRootDir,
    });

    const summary = await finalizeWorktree(state);
    expect(summary.cleanedUp).toBe(true);
    expect(summary.hasChanges).toBe(false);
    expect(summary.commitCount).toBe(0);
    expect(existsSync(state.rootPath)).toBe(false);

    const branches = runGitSync(["branch", "--list", state.branch], repoDir).trim();
    expect(branches).toBe("");
    expect(formatWorktreeSummary(summary)).toBe("Worktree cleaned up (no changes).");
  });

  it("preserves worktree and collects commits, diffStat, and untrackedFiles when changes exist", async () => {
    const repoDir = createTempDir("pi-wt-dirty-");
    const worktreesRootDir = createTempDir("pi-wt-root-");
    initGitRepo(repoDir);

    const state = await prepareWorktree({
      cwd: repoDir,
      agentName: "worker",
      childSessionId: "dirty123-0000-0000-0000-000000000000",
      worktreesRootDir,
    });

    writeFileSync(join(state.rootPath, "README.md"), "# demo\nupdated\n", "utf8");
    runGitSync(["add", "README.md"], state.rootPath);
    runGitSync(["commit", "-m", "update readme"], state.rootPath);
    writeFileSync(join(state.rootPath, "notes.txt"), "untracked\n", "utf8");

    const summary = await finalizeWorktree(state);
    expect(summary.cleanedUp).toBe(false);
    expect(summary.hasChanges).toBe(true);
    expect(summary.commitCount).toBe(1);
    expect(summary.commits).toHaveLength(1);
    expect(summary.commits[0]).toContain("update readme");
    expect(summary.diffStat).toContain("README.md");
    expect(summary.untrackedFiles).toContain("notes.txt");
    expect(existsSync(state.rootPath)).toBe(true);

    const formatted = formatWorktreeSummary(summary);
    expect(formatted).toContain("Worktree preserved (changes detected):");
    expect(formatted).toContain(`- Path: ${state.rootPath}`);
    expect(formatted).toContain(`- Branch: ${state.branch}`);
    expect(formatted).toContain("update readme");
    expect(formatted).toContain("notes.txt");
  });

  it("reuses preserved worktree on resume and recreates if previously cleaned up", async () => {
    const repoDir = createTempDir("pi-wt-resume-");
    const worktreesRootDir = createTempDir("pi-wt-root-");
    initGitRepo(repoDir);

    // 模拟 UUIDv7：相同时间戳前缀，不同随机后缀，验证并行/同仓库不冲突
    const first = await prepareWorktree({
      cwd: repoDir,
      agentName: "worker",
      childSessionId: "01a210a0-0000-7000-8000-0000reuse123",
      worktreesRootDir,
    });
    writeFileSync(join(first.rootPath, "wip.txt"), "in progress\n", "utf8");
    const firstSummary = await finalizeWorktree(first);
    expect(firstSummary.cleanedUp).toBe(false);

    const reused = await prepareWorktree({
      cwd: repoDir,
      agentName: "worker",
      childSessionId: "01a210a0-0000-7000-8000-0000reuse123",
      existing: first,
      worktreesRootDir,
    });
    expect(reused).toEqual(first);
    expect(existsSync(join(reused.rootPath, "wip.txt"))).toBe(true);

    // 另一条会话无改动被清理后，resume 应基于当前 HEAD 重新创建 worktree
    const cleanFirst = await prepareWorktree({
      cwd: repoDir,
      agentName: "worker",
      childSessionId: "01a210a0-0000-7000-8000-0000recreate",
      worktreesRootDir,
    });
    const cleanSummary = await finalizeWorktree(cleanFirst);
    expect(cleanSummary.cleanedUp).toBe(true);

    const recreated = await prepareWorktree({
      cwd: repoDir,
      agentName: "worker",
      childSessionId: "01a210a0-0000-7000-8000-0000recreate",
      existing: cleanFirst,
      worktreesRootDir,
    });
    expect(existsSync(recreated.rootPath)).toBe(true);
    expect(recreated.branch).toBe(cleanFirst.branch);
  });

  it("integrates with SubagentManager to run prepare/session in worktree cwd and finalize", async () => {
    const repoDir = createTempDir("pi-wt-mgr-repo-");
    const worktreesRootDir = createTempDir("pi-wt-mgr-root-");
    const sessionDir = createTempDir("pi-wt-mgr-sess-");
    initGitRepo(repoDir);

    const parentSession = SessionManager.create(repoDir, sessionDir);
    const store = new SubagentStore(repoDir, parentSession);

    const observedCwds: string[] = [];
    let shouldModify = false;

    const manager = new SubagentManager(repoDir, 2, undefined, {
      store,
      worktreesRootDir,
      createSession: async (options) => {
        observedCwds.push(options.cwd);
        return createFakeSession(
          options.sessionManager,
          (cwd) => {
            if (shouldModify) {
              writeFileSync(join(cwd, "changed.txt"), "hello\n", "utf8");
            }
          },
          options.cwd,
        );
      },
    });

    // 1. 无改动 -> 自动清理
    const cleanChild = store.createSession("worker", "clean run");
    let prepareCwd = "";
    const cleanResult = await manager.spawn({
      id: "call-1",
      childSessionId: cleanChild.childSessionId,
      sessionManager: cleanChild.sessionManager,
      resumed: false,
      profile: createProfile("worker"),
      title: "clean run",
      task: "inspect",
      model: TEST_MODEL,
      thinkingLevel: "off",
      isolation: "worktree",
      projectTrusted: true,
      prepare: async (_signal, cwd) => {
        prepareCwd = cwd;
        return "";
      },
    });

    expect(cleanResult.worktree?.cleanedUp).toBe(true);
    expect(cleanResult.worktree?.hasChanges).toBe(false);
    expect(prepareCwd).toBe(observedCwds[0]);
    expect(existsSync(cleanResult.worktree!.rootPath)).toBe(false);

    // 2. 有改动 -> 保留并记录在 store 中
    shouldModify = true;
    const dirtyChild = store.createSession("worker", "dirty run");
    const dirtyResult = await manager.spawn({
      id: "call-2",
      childSessionId: dirtyChild.childSessionId,
      sessionManager: dirtyChild.sessionManager,
      resumed: false,
      profile: createProfile("worker"),
      title: "dirty run",
      task: "edit",
      model: TEST_MODEL,
      thinkingLevel: "off",
      isolation: "worktree",
      projectTrusted: true,
      prepare: async () => "",
    });

    expect(dirtyResult.worktree?.cleanedUp).toBe(false);
    expect(dirtyResult.worktree?.hasChanges).toBe(true);
    expect(dirtyResult.worktree?.untrackedFiles).toContain("changed.txt");
    expect(existsSync(dirtyResult.worktree!.rootPath)).toBe(true);
    expect(store.get(dirtyChild.childSessionId)?.worktree?.branch).toBe(dirtyResult.worktree?.branch);
  });
});
