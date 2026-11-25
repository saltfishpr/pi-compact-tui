import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import type { UsageTotals } from "../pi-common";

// --- Profile ---

export const ISOLATION_MODES = ["none", "worktree"] as const;

export type IsolationMode = (typeof ISOLATION_MODES)[number];

export type AgentSource = "builtin" | "global" | "project";

export interface AgentProfile {
  name: string;
  source: AgentSource;
  description: string;
  tools?: string[];
  skills?: string[];
  extensions?: string[];
  model?: string;
  effort?: ModelThinkingLevel;
  maxTurns: number;
  isolation?: IsolationMode;
  body: string;
  path: string;
  sha256: string;
  commands: string[];
  /** 可由 subagent.json 的 agents.<name>.timeoutSeconds 配置 */
  timeoutSeconds?: number;
}

export interface AgentDiagnostic {
  path: string;
  message: string;
}

// --- Runtime ---

export type SpawnStopReason = "stop" | "aborted" | "max_turns" | "timeout" | "error";

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

export type SubagentStatus = "pending" | "running" | "completed" | "max_turns" | "timeout" | "aborted" | "error";

export function stopReasonToStatus(stopReason: SpawnStopReason): SubagentStatus {
  return stopReason === "stop" ? "completed" : stopReason;
}

export function isActiveStatus(status: SubagentStatus): boolean {
  return status === "pending" || status === "running";
}

export type ThreadPhase = "pending" | "running";

export type SubagentActivity =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

export interface SubagentWorktreeState {
  repoRoot: string;
  rootPath: string;
  cwd: string;
  branch: string;
  baseCommit: string;
}

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

export function cloneUsage(usage: UsageTotals): UsageTotals {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost,
  };
}

export function addUsageTotals(target: UsageTotals, delta: Partial<UsageTotals>): void {
  target.input += delta.input ?? 0;
  target.output += delta.output ?? 0;
  target.cacheRead += delta.cacheRead ?? 0;
  target.cacheWrite += delta.cacheWrite ?? 0;
  target.cost += delta.cost ?? 0;
}

// --- UI ---

/** 合并持久化记录与实时运行快照后的统一视图，供工具层与 UI 层共用。 */
export interface SubagentView {
  childSessionId: string;
  name: string;
  title: string;
  status: SubagentStatus;
  isActive: boolean;
  background: boolean;
  timeoutSeconds?: number;
  worktree?: SubagentWorktreeState;
  worktreeBranch?: string;
  persisted: boolean;
  model: string;
  turns: number;
  usage: UsageTotals;
  durationMs: number;
  createdAt: number;
  updatedAt: number;
  lastActivity?: SubagentActivity;
  lastError?: string;
}

export interface AgentToolDetails {
  childSessionId: string;
  resumed?: boolean;
  background?: boolean;
  backgroundStatus?: "started" | "detached";
  name: string;
  title: string;
  model: string;
  turns: number;
  durationMs: number;
  usage: UsageTotals;
  stopReason: SpawnStopReason;
  persisted?: boolean;
  errorMessage?: string;
  toolTrace?: ToolTraceEntry[];
  toolTraceTotal?: number;
  worktree?: WorktreeSummary;
}
