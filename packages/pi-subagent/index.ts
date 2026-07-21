import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  getMarkdownTheme,
  ModelRuntime,
  parseFrontmatter,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import * as z from "zod";

const BUILTIN_AGENTS_DIR = join(import.meta.dirname, "agents");
const GLOBAL_AGENTS_DIR = join(getAgentDir(), "agents");
const PROJECT_AGENTS_DIR = join(".pi", "agents");

// pi's default coding tools, used when an agent omits its own tool allowlist.
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

const COLLAPSED_LINE_COUNT = 3;
const SUBAGENT_WIDGET_ID = "subagent-runs";

// pi's reasoning/thinking levels, matching @earendil-works/pi-ai ThinkingLevel.
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const frontmatterSchema = z.object({
  description: z.string().min(1),
  tools: z.array(z.string()).optional(),
  // Skill names to expose to the subagent's system prompt. Omit to give it none.
  skills: z.array(z.string()).optional(),
  // provider/id, e.g. anthropic/claude-opus-4-5
  model: z
    .string()
    .regex(/^[^/]+\/.+$/)
    .optional(),
  // Reasoning effort for this subagent. Omit to inherit the caller's level.
  effort: z.enum(THINKING_LEVELS).optional(),
  // Hard cap on assistant turns; the subagent is stopped once it is reached.
  maxTurns: z.number().int().positive().optional(),
});

type Frontmatter = z.infer<typeof frontmatterSchema>;

/**
 * Where an agent definition came from. Only "project" agents are repo-controlled
 * and gated behind a confirmation; "builtin" ships with this package.
 */
type AgentSource = "builtin" | "global" | "project";

interface LoadedAgent extends Frontmatter {
  name: string;
  source: AgentSource;
  /** Markdown body used as the subagent's system prompt. */
  body: string;
}

type SubagentActivity =
  | { type: "running" }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown> };

interface RunningSubagent {
  number: number;
  agent: string;
  task: string;
  activity: SubagentActivity;
}

/** Aggregated token/cost usage, filled once the subagent finishes. */
interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

/**
 * Structured outcome of a subagent run, accumulated live from session events
 * and consumed by renderResult. Doubles as the tool's `details`.
 */
interface SubagentResult {
  number: number;
  agent: string;
  source: AgentSource;
  task: string;
  finalOutput: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: UsageStats;
  model?: string;
  isError: boolean;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

// Only the tools a subagent reaches for most (DEFAULT_TOOLS) get a tailored
// preview; everything else falls back to a generic argument dump.
function formatToolCall(name: string, args: Record<string, unknown>, theme: Theme): string {
  const shortenPath = (p: string) => {
    const home = homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (name) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return theme.fg("accent", "$ ") + theme.fg("toolOutput", preview);
    }
    case "read":
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return theme.fg("accent", `${name} `) + theme.fg("muted", shortenPath(rawPath));
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = theme.fg("accent", "write ") + theme.fg("muted", shortenPath(rawPath));
      if (lines > 1) text += theme.fg("dim", ` (${lines} lines)`);
      return text;
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return theme.fg("accent", name) + theme.fg("muted", ` ${preview}`);
    }
  }
}

function formatActivity(activity: SubagentActivity, theme: Theme): string {
  switch (activity.type) {
    case "running":
      return theme.fg("muted", "Running...");
    case "text":
      return theme.fg("muted", "← ") + theme.fg("toolOutput", activity.text.replace(/\s+/g, " ").trim());
    case "tool":
      return theme.fg("muted", "→ ") + formatToolCall(activity.name, activity.args, theme);
  }
}

function updateSubagentWidget(ctx: ExtensionContext, running: ReadonlyMap<string, RunningSubagent>): void {
  if (ctx.mode !== "tui") return;
  if (running.size === 0) {
    ctx.ui.setWidget(SUBAGENT_WIDGET_ID, undefined);
    return;
  }

  const items = [...running.values()].map((item) => ({ ...item }));
  ctx.ui.setWidget(SUBAGENT_WIDGET_ID, (_tui, theme) => ({
    render(width: number): string[] {
      const lines = [theme.fg("accent", theme.bold(`Subagents (${items.length} running)`))];
      for (const item of items) {
        const task = item.task.replace(/\s+/g, " ").trim();
        lines.push(theme.fg("accent", `● #${item.number} `) + theme.bold(item.agent) + theme.fg("dim", ` — ${task}`));
        lines.push(`  ${formatActivity(item.activity, theme)}`);
      }
      lines.push("");
      return lines.map((line) => truncateToWidth(line, width));
    },
    invalidate() {},
  }));
}

function loadAgentsFromDir(dir: string, source: AgentSource, out: Map<string, LoadedAgent>): void {
  if (!existsSync(dir)) return;

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;

    const { frontmatter, body } = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
    const result = frontmatterSchema.safeParse(frontmatter);
    if (!result.success) continue;

    const name = basename(file, ".md");
    out.set(name, { name, source, body, ...result.data });
  }
}

// Precedence low to high: builtin < global < project. Later loads override
// earlier ones with the same name, so users can shadow a builtin agent.
function discoverAgents(cwd: string): LoadedAgent[] {
  const agents = new Map<string, LoadedAgent>();
  loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin", agents);
  loadAgentsFromDir(GLOBAL_AGENTS_DIR, "global", agents);
  loadAgentsFromDir(join(cwd, PROJECT_AGENTS_DIR), "project", agents);
  return [...agents.values()];
}

let runtimePromise: Promise<ModelRuntime> | undefined;
function getModelRuntime(): Promise<ModelRuntime> {
  return (runtimePromise ??= ModelRuntime.create());
}

async function runSubagent(
  number: number,
  agent: LoadedAgent,
  task: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  onActivity: (activity: SubagentActivity) => void,
): Promise<SubagentResult> {
  const result: SubagentResult = {
    number,
    agent: agent.name,
    source: agent.source,
    task,
    finalOutput: "",
    isError: false,
  };

  const runtime = await getModelRuntime();

  let model = ctx.model;
  if (agent.model) {
    const [provider, ...rest] = agent.model.split("/");
    model = runtime.getModel(provider, rest.join("/"));
  }
  if (!model) {
    result.isError = true;
    result.errorMessage = `No valid model for subagent "${agent.name}" (configured: ${agent.model ?? "inherit"})`;
    return result;
  }
  result.model = `${model.provider}/${model.id}`;

  // Isolated session: no extensions (so the subagent can't recurse into this
  // tool), no context files, with the markdown body as its prompt. Skills stay
  // loadable but are filtered down to the agent's `skills` allowlist so only
  // those appear in the subagent's system prompt.
  const allowedSkills = new Set(agent.skills ?? []);
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: allowedSkills.size === 0,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => agent.body,
    skillsOverride: (base) => ({
      ...base,
      skills: base.skills.filter((skill) => allowedSkills.has(skill.name)),
    }),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    modelRuntime: runtime,
    model,
    thinkingLevel: agent.effort,
    tools: agent.tools ?? DEFAULT_TOOLS,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });

  // Counts assistant turns so we can stop a runaway subagent at maxTurns.
  let turnCount = 0;
  let hitMaxTurns = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;

    const textParts: string[] = [];
    let latestActivity: SubagentActivity | undefined;
    for (const part of event.message.content) {
      if (part.type === "text") {
        textParts.push(part.text);
        latestActivity = { type: "text", text: part.text };
      } else if (part.type === "toolCall") {
        latestActivity = { type: "tool", name: part.name, args: part.arguments };
      }
    }
    if (textParts.length > 0) result.finalOutput = textParts.join("\n");
    if (latestActivity) onActivity(latestActivity);

    turnCount++;
    if (agent.maxTurns && turnCount >= agent.maxTurns) {
      hitMaxTurns = true;
      void session.abort();
    }
  });

  const onAbort = () => {
    void session.abort();
  };
  signal?.addEventListener("abort", onAbort);

  try {
    await session.prompt(task);

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
      .filter((m): m is Extract<typeof m, { role: "assistant" }> => m.role === "assistant")
      .at(-1)?.stopReason;
    if (hitMaxTurns) {
      // Stopping at the turn cap is expected, so keep whatever output the
      // subagent produced and only flag an error when it produced nothing.
      result.stopReason = "max_turns";
      if (!result.finalOutput) {
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
    } else if (!result.finalOutput) {
      result.isError = true;
      result.errorMessage = `Subagent "${agent.name}" produced no output`;
    }

    return result;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    session.dispose();
  }
}

function getNextAgentNumber(ctx: ExtensionContext): number {
  let maxNumber = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "toolResult" || message.toolName !== "agent") continue;

    const details = message.details as Partial<SubagentResult> | undefined;
    if (typeof details?.number === "number") maxNumber = Math.max(maxNumber, details.number);
  }
  return maxNumber + 1;
}

function registerAgentTool(
  pi: ExtensionAPI,
  agents: LoadedAgent[],
  running: Map<string, RunningSubagent>,
  initialAgentNumber: number,
): void {
  let nextAgentNumber = initialAgentNumber;
  const description = [
    "Delegate a focused task to a specialized subagent that runs in an isolated context.",
    "The subagent does not see this conversation, so put everything it needs in `prompt`.",
    "Available subagents:",
    ...agents.map((agent) => `- ${agent.name}: ${agent.description}`),
  ].join("\n");

  pi.registerTool({
    name: "agent",
    label: "Agent",
    description,
    parameters: Type.Object({
      name: StringEnum(
        agents.map((agent) => agent.name),
        { description: "Which subagent to run" },
      ),
      prompt: Type.String({ description: "The full task for the subagent, including all needed context" }),
    }),
    renderShell: "self",

    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const agent = agents.find((candidate) => candidate.name === params.name);
      if (!agent) throw new Error(`Unknown subagent: ${params.name}`);

      // Project agents are repo-controlled and can inject arbitrary system
      // prompts and tool allowlists, so confirm before running one.
      if (agent.source === "project" && ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Run project-local subagent?",
          `Subagent "${agent.name}" is defined in ${PROJECT_AGENTS_DIR}. Project agents are repo-controlled; only continue for trusted repositories.`,
        );
        if (!ok) throw new Error(`Canceled: project-local subagent "${agent.name}" not approved`);
      }

      const agentNumber = nextAgentNumber++;
      running.set(toolCallId, {
        number: agentNumber,
        agent: agent.name,
        task: params.prompt,
        activity: { type: "running" },
      });
      updateSubagentWidget(ctx, running);

      const updateActivity = (activity: SubagentActivity) => {
        const current = running.get(toolCallId);
        if (!current) return;
        current.activity = activity;
        updateSubagentWidget(ctx, running);
      };

      try {
        const result = await runSubagent(agentNumber, agent, params.prompt, signal, ctx, updateActivity);
        return {
          content: [{ type: "text", text: result.finalOutput || result.errorMessage || "(no output)" }],
          details: result,
        };
      } finally {
        running.delete(toolCallId);
        updateSubagentWidget(ctx, running);
      }
    },

    renderCall() {
      return new Container();
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Container();

      const details = result.details as SubagentResult | undefined;
      const fallbackText = result.content
        .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("\n")
        .trim();
      const isError = details?.isError ?? context.isError;
      const output = details?.finalOutput.trim() || (!isError ? fallbackText : "");
      const errorMessage = details?.errorMessage || (isError ? fallbackText || "Subagent failed" : "");
      const usageStr = details?.usage ? formatUsageStats(details.usage, details.model) : "";

      const agentName = details?.agent ?? context.args.name;
      const agentNumber = details?.number ? `#${details.number} ` : "";
      const content = new Container();
      content.addChild(
        new Text(`${theme.fg("toolTitle", theme.bold(`agent ${agentNumber}`))}${theme.fg("accent", agentName)}`, 0, 0),
      );
      if (errorMessage) {
        const reason = details?.stopReason ? `[${details.stopReason}] ` : "";
        content.addChild(new Text(theme.fg("error", `${reason}Error: ${errorMessage}`), 0, 0));
      }

      if (output) {
        if (errorMessage) content.addChild(new Spacer(1));
        if (expanded) {
          content.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
        } else {
          const outputLines = output.split("\n");
          content.addChild(
            new Text(theme.fg("toolOutput", outputLines.slice(0, COLLAPSED_LINE_COUNT).join("\n")), 0, 0),
          );
          if (outputLines.length > COLLAPSED_LINE_COUNT) {
            content.addChild(new Text(theme.fg("dim", "(Ctrl+O to expand)"), 0, 0));
          }
        }
      } else if (!errorMessage) {
        content.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
      }

      if (usageStr) {
        content.addChild(new Spacer(1));
        content.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
      }

      const box = new Box(1, 1, (text) => theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", text));
      box.addChild(content);
      return box;
    },
  });
}

export default function (pi: ExtensionAPI) {
  let registered = false;
  const running = new Map<string, RunningSubagent>();

  pi.on("session_start", async (_event, ctx) => {
    if (registered) return;

    const agents = discoverAgents(ctx.cwd);
    if (agents.length === 0) return;

    registerAgentTool(pi, agents, running, getNextAgentNumber(ctx));
    registered = true;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    running.clear();
    updateSubagentWidget(ctx, running);
  });
}
