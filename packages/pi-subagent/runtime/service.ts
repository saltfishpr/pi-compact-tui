import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

import { resolveModel } from "../../pi-common";
import type { SubagentConfig } from "../config";
import { runProfileCommands } from "../profile/commands";
import type { ProfileTrust } from "../profile/trust";
import {
  addUsageTotals,
  cloneUsage,
  isActiveStatus,
  type AgentProfile,
  type AgentThreadSnapshot,
  type IsolationMode,
  type SpawnResult,
  type SubagentView,
  type SubagentWorktreeState,
  type ToolTraceEntry,
} from "../types";
import type { SteerResult, SubagentManager, SubagentManagerEvent, WaitResult } from "./manager";
import type { SubagentRecord, SubagentStore } from "./store";
import { validateGitRepoForWorktree } from "./worktree";

export interface DelegateInput {
  toolCallId: string;
  name?: string;
  resume?: string;
  title?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
  maxTurns?: number;
  timeoutSeconds?: number;
  background?: boolean;
  isolation?: IsolationMode;
  task: string;
}

export type DelegateOutcome =
  | {
      kind: "background";
      backgroundStatus: "started" | "detached";
      phase: "pending" | "running";
      childSessionId: string;
      resumed: boolean;
      name: string;
      title: string;
      model: string;
    }
  | {
      kind: "settled";
      name: string;
      title: string;
      result: SpawnResult;
    };

function mergeSubagentView(record: SubagentRecord, snapshot?: AgentThreadSnapshot): SubagentView {
  if (!snapshot) {
    return {
      childSessionId: record.childSessionId,
      name: record.name,
      title: record.title,
      status: record.status,
      isActive: false,
      background: Boolean(record.background),
      timeoutSeconds: record.timeoutSeconds,
      worktree: record.worktree,
      worktreeBranch: record.worktree?.branch,
      persisted: record.persisted,
      model: record.model,
      turns: record.totalTurns,
      usage: cloneUsage(record.totalUsage),
      durationMs: record.totalDurationMs,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastActivity: record.lastActivity,
      lastError: record.lastError,
    };
  }

  const usage = cloneUsage(record.totalUsage);
  addUsageTotals(usage, snapshot.usage);
  const activeElapsed = Math.max(0, Date.now() - (snapshot.runningSince ?? snapshot.startedAt));

  return {
    childSessionId: record.childSessionId,
    name: record.name,
    title: record.title,
    status: snapshot.phase,
    isActive: true,
    background: snapshot.background,
    timeoutSeconds: snapshot.timeoutSeconds ?? record.timeoutSeconds,
    worktree: record.worktree,
    worktreeBranch: snapshot.worktreeBranch ?? record.worktree?.branch,
    persisted: record.persisted,
    model: snapshot.model || record.model,
    turns: record.totalTurns + snapshot.turns,
    usage,
    durationMs: record.totalDurationMs + activeElapsed,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastActivity: snapshot.lastActivity ?? record.lastActivity,
    lastError: record.lastError,
  };
}

/**
 * 统一门面：封装 store + manager 的双源读模型合并，以及 agent 委派的参数校验、授权与 detach 编排。
 */
export class SubagentService {
  constructor(
    readonly store: SubagentStore,
    readonly manager: SubagentManager,
    private readonly agents: readonly AgentProfile[],
    private readonly config: SubagentConfig,
    private readonly profileTrust: ProfileTrust,
  ) {}

  getView(childSessionId: string): SubagentView | undefined {
    const record = this.store.get(childSessionId);
    if (!record) return undefined;
    return mergeSubagentView(record, this.manager.getSnapshot(childSessionId));
  }

  listViews(options?: { activeOnly?: boolean }): SubagentView[] {
    const views = this.store
      .list()
      .map((record) => mergeSubagentView(record, this.manager.getSnapshot(record.childSessionId)));
    if (!options?.activeOnly) return views;
    return views.filter((view) => view.isActive || isActiveStatus(view.status));
  }

  isActive(childSessionId: string): boolean {
    return this.manager.isChildActive(childSessionId);
  }

  getSnapshot(childSessionId: string): AgentThreadSnapshot | undefined {
    return this.manager.getSnapshot(childSessionId);
  }

  getRecentToolTrace(childSessionId: string, limit = 5): ToolTraceEntry[] {
    return this.manager.getRecentToolTrace(childSessionId, limit);
  }

  getLastResult(childSessionId: string, options?: { consume?: boolean }): SpawnResult | undefined {
    return this.manager.getLastResult(childSessionId, options);
  }

  loadTranscript(childSessionId: string): SessionEntry[] {
    return this.manager.getActiveBranch(childSessionId) ?? this.store.loadTranscript(childSessionId);
  }

  detach(childSessionId: string): boolean {
    return this.manager.detach(childSessionId);
  }

  cancel(childSessionId: string, options?: { notify?: boolean }): Promise<SpawnResult | undefined> {
    return this.manager.cancel(childSessionId, options);
  }

  wait(
    childSessionId: string,
    options?: { waitSeconds?: number; signal?: AbortSignal; consume?: boolean },
  ): Promise<WaitResult | undefined> {
    return this.manager.wait(childSessionId, options);
  }

  steer(childSessionId: string, message: string): Promise<SteerResult> {
    return this.manager.steer(childSessionId, message);
  }

  subscribeStore(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  subscribeManager(listener: (event: SubagentManagerEvent) => void): () => void {
    return this.manager.subscribe(listener);
  }

  isShuttingDown(): boolean {
    return this.manager.isShuttingDown();
  }

  shutdown(): Promise<void> {
    return this.manager.shutdown();
  }

  async delegate(input: DelegateInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<DelegateOutcome> {
    const resumeId = input.resume?.trim();
    const resumed = Boolean(resumeId);
    const background = Boolean(input.background);

    let profile: AgentProfile | undefined;
    let title: string;
    let child: { childSessionId: string; sessionManager: SessionManager } | undefined;
    let effectiveIsolation: IsolationMode;
    let existingWorktree: SubagentWorktreeState | undefined;

    if (resumeId) {
      if (this.manager.isChildActive(resumeId)) {
        throw new Error(
          `Subagent session "${resumeId}" is already pending or running; concurrent resume is not allowed.`,
        );
      }

      const opened = this.store.openSessionForResume(resumeId);
      if (input.name && input.name !== opened.record.name) {
        throw new Error(
          `Cannot resume subagent "${resumeId}" (profile "${opened.record.name}") with different profile "${input.name}".`,
        );
      }

      profile = this.agents.find((agent) => agent.name === opened.record.name);
      if (!profile) {
        throw new Error(`Unknown subagent "${opened.record.name}" for resumed session "${resumeId}"`);
      }

      const previousIsolation: IsolationMode = opened.record.worktree ? "worktree" : "none";
      if (input.isolation !== undefined && input.isolation !== previousIsolation) {
        throw new Error(
          `Cannot change \`isolation\` when resuming subagent "${resumeId}" (was "${previousIsolation}", got "${input.isolation}").`,
        );
      }
      effectiveIsolation = previousIsolation;
      existingWorktree = opened.record.worktree;

      title = input.title?.trim() || opened.record.title || profile.name;
      child = { childSessionId: resumeId, sessionManager: opened.sessionManager };
    } else {
      if (!input.name?.trim()) {
        throw new Error("Parameter `name` is required when starting a new subagent");
      }
      if (!input.title?.trim()) {
        throw new Error("Parameter `title` is required when starting a new subagent");
      }

      profile = this.agents.find((agent) => agent.name === input.name);
      if (!profile) {
        throw new Error(`Unknown subagent "${input.name}"`);
      }

      effectiveIsolation = input.isolation ?? profile.isolation ?? "none";
      title = input.title.trim();
    }

    if (
      input.model &&
      !ctx.modelRegistry.getAvailable().some((model) => `${model.provider}/${model.id}` === input.model)
    ) {
      throw new Error(`Model "${input.model}" is not available. Use the \`models\` tool to find available models.`);
    }

    const resolved = resolveModel(ctx, {
      model: input.model ?? profile.model,
      thinkingLevel: input.thinkingLevel ?? profile.effort,
      fallbackModel: ctx.model,
      fallbackThinkingLevel: ctx.thinkingLevel,
    });
    if (!resolved) {
      throw new Error(`No model available for subagent "${profile.name}"`);
    }
    if (input.thinkingLevel !== undefined) {
      const supported = getSupportedThinkingLevels(resolved.model);
      if (!supported.includes(input.thinkingLevel)) {
        throw new Error(
          `Model "${resolved.model.provider}/${resolved.model.id}" does not support \`thinkingLevel\` "${input.thinkingLevel}". Supported: ${supported.join(", ")}.`,
        );
      }
    }

    const activeProfile = profile;
    if (effectiveIsolation === "worktree") {
      await validateGitRepoForWorktree(ctx.cwd);
    }

    // 后台任务不能在返回后静默弹交互式授权窗，须在返回前同步完成 !cmd 授权。
    if (background && !resumed && activeProfile.commands.length > 0) {
      await this.profileTrust.authorize(activeProfile, ctx, signal ?? new AbortController().signal);
    }

    const { childSessionId, sessionManager } = child ?? this.store.createSession(activeProfile.name, title);
    const modelId = `${resolved.model.provider}/${resolved.model.id}`;
    const spawnReq = {
      id: input.toolCallId,
      childSessionId,
      sessionManager,
      resumed,
      background,
      profile: activeProfile,
      title,
      task: input.task,
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel,
      maxTurns: input.maxTurns,
      timeoutSeconds: input.timeoutSeconds ?? activeProfile.timeoutSeconds ?? this.config.defaultTimeoutSeconds,
      isolation: effectiveIsolation,
      existingWorktree,
      projectTrusted: ctx.isProjectTrusted(),
      prepare: async (prepareSignal: AbortSignal, prepareCwd: string) => {
        if (resumed) return "";
        if (!background) {
          await this.profileTrust.authorize(activeProfile, ctx, prepareSignal);
        }
        if (activeProfile.commands.length === 0) return "";
        return runProfileCommands(activeProfile.commands, prepareCwd, prepareSignal);
      },
    };

    if (background) {
      void this.manager.spawn(spawnReq, undefined).catch(() => undefined);
      const snapshot = this.manager.getSnapshot(childSessionId);
      return {
        kind: "background",
        backgroundStatus: "started",
        phase: snapshot?.phase ?? "pending",
        childSessionId,
        resumed,
        name: activeProfile.name,
        title,
        model: modelId,
      };
    }

    const settledPromise = this.manager.spawn(spawnReq, signal);
    const outcome = await this.awaitForegroundOrDetach(childSessionId, settledPromise);
    if (outcome.kind === "detached") {
      void settledPromise.catch(() => undefined);
      return {
        kind: "background",
        backgroundStatus: "detached",
        phase: this.manager.getSnapshot(childSessionId)?.phase ?? "running",
        childSessionId,
        resumed,
        name: activeProfile.name,
        title,
        model: modelId,
      };
    }

    return {
      kind: "settled",
      name: activeProfile.name,
      title,
      result: outcome.result,
    };
  }

  private awaitForegroundOrDetach(
    childSessionId: string,
    settledPromise: Promise<SpawnResult>,
  ): Promise<{ kind: "settled"; result: SpawnResult } | { kind: "detached" }> {
    return new Promise((resolve, reject) => {
      const unsub = this.manager.subscribe((event) => {
        if (event.type === "detached" && event.childSessionId === childSessionId) {
          unsub();
          resolve({ kind: "detached" });
        }
      });
      settledPromise.then(
        (result) => {
          unsub();
          resolve({ kind: "settled", result });
        },
        (error) => {
          unsub();
          reject(error);
        },
      );
    });
  }
}
