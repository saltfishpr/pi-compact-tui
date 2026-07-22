import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Model, ModelThinkingLevel, ThinkingLevel, Message } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  DefaultResourceLoader,
  formatSize,
  getAgentDir,
  SessionManager,
  SettingsManager,
  truncateHead,
  type TruncationResult,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

import type { AgentSource, LoadedAgent } from "./agents";

export interface RunningSubagent {
  number: number;
  agent: string;
  title: string;
  messages: Message[];
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface SubagentResult {
  number: number;
  agent: string;
  source: AgentSource;
  task: string;
  finalOutput: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: UsageStats;
  truncation?: TruncationResult;
  fullOutputPath?: string;
  isError: boolean;
}

export interface RunSubagentOptions {
  number: number;
  agent: LoadedAgent;
  task: string;
  signal?: AbortSignal;
  cwd: string;
  model: Model<any>;
  thinkingLevel: ModelThinkingLevel;
  onMessage: (message: Message) => void;
}

function getSupportedToolNames(cwd: string): string[] {
  const tools = [...createCodingTools(cwd), ...createReadOnlyTools(cwd)];
  return [...new Set(tools.map((tool) => tool.name))];
}

function missingItems(requested: readonly string[], available: ReadonlySet<string>): string[] {
  return requested.filter((item) => !available.has(item));
}

async function truncateOutput(result: SubagentResult, output: string): Promise<void> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) {
    result.finalOutput = output;
    return;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "pi-subagent-"));
  const safeAgentName = result.agent.replace(/[^\w.-]+/g, "_");
  const fullOutputPath = join(tempDir, `${safeAgentName}-output.md`);
  await withFileMutationQueue(fullOutputPath, async () => {
    await writeFile(fullOutputPath, output, { encoding: "utf8", mode: 0o600 });
  });

  const omittedLines = truncation.totalLines - truncation.outputLines;
  const omittedBytes = truncation.totalBytes - truncation.outputBytes;
  result.finalOutput = `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ${omittedLines} lines (${formatSize(omittedBytes)}) omitted. Full output saved to: ${fullOutputPath}]`;
  result.truncation = truncation;
  result.fullOutputPath = fullOutputPath;
}

export async function runSubagent(options: RunSubagentOptions): Promise<SubagentResult> {
  const { number, agent, task, signal, cwd, model, thinkingLevel, onMessage } = options;
  const result: SubagentResult = {
    number,
    agent: agent.name,
    source: agent.source,
    task,
    finalOutput: "",
    model: `${model.provider}/${model.id}`,
    isError: false,
  };

  const supportedTools = getSupportedToolNames(cwd);
  const selectedTools = agent.tools ?? supportedTools;
  const unavailableTools = missingItems(selectedTools, new Set(supportedTools));
  if (unavailableTools.length > 0) {
    result.isError = true;
    result.errorMessage = `Subagent "${agent.name}" requires unavailable tools: ${unavailableTools.join(", ")}`;
    return result;
  }
  if ((agent.skills?.length ?? 0) > 0 && !selectedTools.includes("read")) {
    result.isError = true;
    result.errorMessage = `Subagent "${agent.name}" requires the read tool to load configured skills`;
    return result;
  }

  const allowedSkills = new Set(agent.skills ?? []);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: allowedSkills.size === 0,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => agent.body,
    appendSystemPromptOverride: () => [],
    skillsOverride: (base) => ({
      ...base,
      skills: base.skills.filter((skill) => allowedSkills.has(skill.name)),
    }),
  });
  await loader.reload();

  const availableSkills = new Set(loader.getSkills().skills.map((skill) => skill.name));
  const unavailableSkills = missingItems(agent.skills ?? [], availableSkills);
  if (unavailableSkills.length > 0) {
    result.isError = true;
    result.errorMessage = `Subagent "${agent.name}" requires unavailable skills: ${unavailableSkills.join(", ")}`;
    return result;
  }

  // Pi 0.80.8 handles "off" at runtime, but createAgentSession's public type still uses ThinkingLevel.
  const sdkThinkingLevel = thinkingLevel as ThinkingLevel;
  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: sdkThinkingLevel,
    tools: selectedTools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });

  let turnCount = 0;
  let hitMaxTurns = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;

    onMessage(event.message);

    turnCount++;
    if (agent.maxTurns && turnCount >= agent.maxTurns && event.message.stopReason === "toolUse") {
      hitMaxTurns = true;
      void session.abort();
    }
  });

  const onAbort = () => {
    void session.abort();
  };
  if (!signal?.aborted) signal?.addEventListener("abort", onAbort);

  try {
    if (!signal?.aborted) {
      try {
        await session.prompt(task);
      } catch (error) {
        if (!signal?.aborted && !hitMaxTurns) throw error;
      }
    }

    const stats = session.getSessionStats();
    result.usage = {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      cost: stats.cost,
      turns: stats.assistantMessages,
    };

    const stopReason = session.state.messages
      .filter((message): message is Extract<typeof message, { role: "assistant" }> => message.role === "assistant")
      .at(-1)?.stopReason;
    const latestOutput = session.getLastAssistantText() ?? "";
    if (hitMaxTurns) {
      result.stopReason = "max_turns";
      if (!latestOutput) {
        result.isError = true;
        result.errorMessage = `Subagent "${agent.name}" hit the ${agent.maxTurns}-turn limit with no output`;
      }
    } else if (signal?.aborted || stopReason === "aborted") {
      result.isError = true;
      result.stopReason = "aborted";
      result.errorMessage = `Subagent "${agent.name}" was aborted`;
    } else if (stopReason === "error") {
      result.isError = true;
      result.stopReason = "error";
      result.errorMessage = session.state.errorMessage ?? `Subagent "${agent.name}" failed`;
    } else if (!latestOutput) {
      result.isError = true;
      result.errorMessage = `Subagent "${agent.name}" produced no output`;
    }

    if (latestOutput) await truncateOutput(result, latestOutput);
    return result;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    session.dispose();
  }
}
