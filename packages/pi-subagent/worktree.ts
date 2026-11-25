import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const MAX_COMMITS = 20;
const MAX_DIFF_STAT_LINES = 40;
const MAX_UNTRACKED_FILES = 30;

export const ISOLATION_MODES = ["none", "worktree"] as const;

export type IsolationMode = (typeof ISOLATION_MODES)[number];

export interface SubagentWorktreeState {
  repoRoot: string;
  rootPath: string;
  cwd: string;
  branch: string;
  baseCommit: string;
}

export interface WorktreeSummary {
  rootPath: string;
  cwd: string;
  branch: string;
  baseCommit: string;
  cleanedUp: boolean;
  hasChanges: boolean;
  commitCount: number;
  commits: string[];
  diffStat: string;
  untrackedFiles: string[];
}

export interface ValidatedGitRepo {
  repoRoot: string;
  prefix: string;
  headCommit: string;
}

export interface PrepareWorktreeOptions {
  cwd: string;
  agentName: string;
  childSessionId: string;
  existing?: SubagentWorktreeState;
  /** 仅用于测试隔离，默认使用 ~/.pi/agent/worktrees。 */
  worktreesRootDir?: string;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout;
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    const detail = err.stderr?.trim() || err.message || String(error);
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || fallback;
}

function normalizePath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

async function isRegisteredWorktree(repoRoot: string, rootPath: string): Promise<boolean> {
  const output = await runGit(["-C", repoRoot, "worktree", "list", "--porcelain"], repoRoot);
  const expected = normalizePath(rootPath);
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) continue;
    const listedPath = line.slice("worktree ".length).trim();
    if (listedPath && normalizePath(listedPath) === expected) {
      return true;
    }
  }
  return false;
}

/** 校验目标目录是否处于有效 Git 仓库且存在 HEAD commit；不满足时直接抛错，绝不降级。 */
export async function validateGitRepoForWorktree(cwd: string): Promise<ValidatedGitRepo> {
  let repoRoot: string;
  try {
    repoRoot = (await runGit(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    throw new Error(`Worktree isolation requires a Git repository, but "${cwd}" is not inside a Git repository.`);
  }
  if (!repoRoot) {
    throw new Error(`Worktree isolation requires a Git repository, but "${cwd}" has no Git repository root.`);
  }

  let headCommit: string;
  try {
    headCommit = (await runGit(["rev-parse", "--verify", "HEAD"], cwd)).trim();
  } catch {
    throw new Error(
      `Worktree isolation requires at least one commit in the Git repository ("${repoRoot}" has no HEAD commit).`,
    );
  }

  const rawPrefix = (await runGit(["rev-parse", "--show-prefix"], cwd)).trim();
  const prefix = rawPrefix.replace(/\/+$/, "");

  return { repoRoot, prefix, headCommit };
}

export async function prepareWorktree(options: PrepareWorktreeOptions): Promise<SubagentWorktreeState> {
  const { cwd, agentName, childSessionId, existing, worktreesRootDir } = options;
  const { repoRoot, prefix, headCommit } = await validateGitRepoForWorktree(cwd);

  if (existing && existsSync(existing.rootPath)) {
    const registered = await isRegisteredWorktree(existing.repoRoot, existing.rootPath).catch(() => false);
    if (registered) {
      const reusedCwd = existsSync(existing.cwd) ? existing.cwd : existing.rootPath;
      return { ...existing, cwd: reusedCwd };
    }
  }

  const repoHash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
  const repoSlug = sanitizeSegment(basename(repoRoot), "repo");
  // Pi 的 session ID 是 UUIDv7，前 8 位是时间戳，同一分钟内并行创建必然碰撞；取末尾 8 位随机段避免冲突。
  const shortId = sanitizeSegment(childSessionId.replace(/-/g, "").slice(-8), "session");
  const baseDir = worktreesRootDir ?? join(getAgentDir(), "worktrees");
  const rootPath = join(baseDir, `${repoSlug}-${repoHash}`, shortId);
  const branch = `pi-subagent/${sanitizeSegment(agentName, "agent")}-${shortId}`;

  mkdirSync(dirname(rootPath), { recursive: true });
  await runGit(["-C", repoRoot, "worktree", "add", "-b", branch, rootPath, "HEAD"], repoRoot);

  const mappedCwd = prefix ? join(rootPath, prefix) : rootPath;
  const effectiveCwd = existsSync(mappedCwd) ? mappedCwd : rootPath;

  return {
    repoRoot,
    rootPath,
    cwd: effectiveCwd,
    branch,
    baseCommit: headCommit,
  };
}

export async function finalizeWorktree(state: SubagentWorktreeState): Promise<WorktreeSummary> {
  const statusOutput = await runGit(["-C", state.rootPath, "status", "--porcelain", "--untracked-files=all"], state.rootPath);
  const statusLines = statusOutput
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

  const commitCountRaw = (
    await runGit(["-C", state.rootPath, "rev-list", "--count", `${state.baseCommit}..HEAD`], state.rootPath)
  ).trim();
  const commitCount = Number.parseInt(commitCountRaw, 10) || 0;

  if (statusLines.length === 0 && commitCount === 0) {
    await runGit(["-C", state.repoRoot, "worktree", "remove", "--force", state.rootPath], state.repoRoot);
    await runGit(["-C", state.repoRoot, "branch", "-D", state.branch], state.repoRoot);
    return {
      rootPath: state.rootPath,
      cwd: state.cwd,
      branch: state.branch,
      baseCommit: state.baseCommit,
      cleanedUp: true,
      hasChanges: false,
      commitCount: 0,
      commits: [],
      diffStat: "",
      untrackedFiles: [],
    };
  }

  let commits: string[] = [];
  if (commitCount > 0) {
    const logOutput = await runGit(
      ["-C", state.rootPath, "log", "--oneline", "-n", String(MAX_COMMITS), `${state.baseCommit}..HEAD`],
      state.rootPath,
    );
    commits = logOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MAX_COMMITS);
  }

  const rawDiffStat = (await runGit(["-C", state.rootPath, "diff", "--stat", state.baseCommit], state.rootPath)).trimEnd();
  let diffStat = rawDiffStat;
  if (rawDiffStat) {
    const diffLines = rawDiffStat.split(/\r?\n/);
    if (diffLines.length > MAX_DIFF_STAT_LINES) {
      diffStat = [
        ...diffLines.slice(0, MAX_DIFF_STAT_LINES),
        `... (${diffLines.length - MAX_DIFF_STAT_LINES} more lines)`,
      ].join("\n");
    }
  }

  const untrackedFiles = statusLines
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3))
    .slice(0, MAX_UNTRACKED_FILES);

  return {
    rootPath: state.rootPath,
    cwd: state.cwd,
    branch: state.branch,
    baseCommit: state.baseCommit,
    cleanedUp: false,
    hasChanges: true,
    commitCount,
    commits,
    diffStat,
    untrackedFiles,
  };
}

export function formatWorktreeSummary(summary: WorktreeSummary): string {
  if (summary.cleanedUp) {
    return "Worktree cleaned up (no changes).";
  }

  const lines = [
    "Worktree preserved (changes detected):",
    `- Path: ${summary.rootPath}`,
    `- Branch: ${summary.branch}`,
  ];

  if (summary.commitCount > 0) {
    const suffix = summary.commitCount > summary.commits.length ? ` (showing ${summary.commits.length})` : "";
    lines.push(`- Commits (${summary.commitCount})${suffix}:`);
    for (const commit of summary.commits) {
      lines.push(`  ${commit}`);
    }
  }

  if (summary.diffStat) {
    lines.push("- Diff stat:");
    for (const line of summary.diffStat.split(/\r?\n/)) {
      lines.push(`  ${line}`);
    }
  }

  if (summary.untrackedFiles.length > 0) {
    lines.push(`- Untracked files (${summary.untrackedFiles.length}):`);
    for (const file of summary.untrackedFiles) {
      lines.push(`  ${file}`);
    }
  }

  return lines.join("\n");
}
