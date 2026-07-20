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
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import * as z from "zod";

const BUILTIN_AGENTS_DIR = join(import.meta.dirname, "agents");
const GLOBAL_AGENTS_DIR = join(getAgentDir(), "agents");
const PROJECT_AGENTS_DIR = join(".pi", "agents");

// pi's default coding tools, used when an agent omits its own tool allowlist.
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

// Collapsed renderResult shows only the most recent activity; the rest is
// available via Ctrl+O.
const COLLAPSED_ITEM_COUNT = 2;

const frontmatterSchema = z.object({
  description: z.string().min(1),
  tools: z.array(z.string()).optional(),
  // provider/id, e.g. anthropic/claude-opus-4-5
  model: z
    .string()
    .regex(/^[^/]+\/.+$/)
    .optional(),
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

/** One assistant activity extracted from the subagent's transcript. */
type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

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
  agent: string;
  source: AgentSource;
  task: string;
  displayItems: DisplayItem[];
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
  agent: LoadedAgent,
  task: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  onUpdate: (result: SubagentResult) => void,
): Promise<SubagentResult> {
  const result: SubagentResult = {
    agent: agent.name,
    source: agent.source,
    task,
    displayItems: [],
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
  // tool), no skills, no context files, with the markdown body as its prompt.
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => agent.body,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    modelRuntime: runtime,
    model,
    tools: agent.tools ?? DEFAULT_TOOLS,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  });

  // Accumulate the subagent's activity as it happens so the main TUI can stream
  // it live. Usage is filled once at the end (from getSessionStats), so it is
  // intentionally absent from these mid-run updates.
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    for (const part of event.message.content) {
      if (part.type === "text") {
        result.finalOutput = part.text;
        result.displayItems.push({ type: "text", text: part.text });
      } else if (part.type === "toolCall") {
        result.displayItems.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
    onUpdate(result);
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
    if (signal?.aborted || stopReason === "aborted") {
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

// Render the tail of the activity list for the collapsed result view. Text
// items are clipped to 3 lines; tool calls get a one-line preview.
function renderDisplayItems(items: DisplayItem[], theme: Theme, limit: number): string[] {
  const toShow = items.slice(-limit);
  const skipped = items.length - toShow.length;
  const lines: string[] = [];
  if (skipped > 0) lines.push(theme.fg("muted", `... ${skipped} earlier items`));
  for (const item of toShow) {
    if (item.type === "text") {
      const preview = item.text.split("\n").slice(0, 3).join("\n");
      lines.push(theme.fg("toolOutput", preview));
    } else {
      lines.push(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme));
    }
  }
  return lines;
}

function registerAgentTool(pi: ExtensionAPI, agents: LoadedAgent[]): void {
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
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
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

      const emitUpdate = (partial: SubagentResult) => {
        onUpdate?.({
          content: [{ type: "text", text: partial.finalOutput || "(running...)" }],
          details: partial,
        });
      };

      const result = await runSubagent(agent, params.prompt, signal, ctx, emitUpdate);
      return {
        content: [{ type: "text", text: result.finalOutput || result.errorMessage || "(no output)" }],
        details: result,
        isError: result.isError,
      };
    },

    renderCall(args, theme) {
      const preview = args.prompt ? (args.prompt.length > 60 ? `${args.prompt.slice(0, 60)}...` : args.prompt) : "...";
      const text = `${theme.fg("toolTitle", theme.bold("agent "))}${theme.fg("accent", args.name)}\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const usageStr = details.usage ? formatUsageStats(details.usage, details.model) : "";

      if (expanded) {
        const container = new Container();
        if (details.isError && details.stopReason) {
          container.addChild(new Text(theme.fg("error", `[${details.stopReason}]`), 0, 0));
        }
        if (details.isError && details.errorMessage) {
          container.addChild(new Text(theme.fg("error", `Error: ${details.errorMessage}`), 0, 0));
        }
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
        container.addChild(new Text(theme.fg("dim", details.task), 0, 0));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
        const toolCalls = details.displayItems.filter((item) => item.type === "toolCall");
        for (const item of toolCalls) {
          container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme), 0, 0));
        }
        if (details.finalOutput) {
          container.addChild(new Spacer(1));
          container.addChild(new Markdown(details.finalOutput.trim(), 0, 0, getMarkdownTheme()));
        } else if (toolCalls.length === 0) {
          container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
        }
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        }
        return container;
      }

      const lines: string[] = [];
      if (details.isError && details.stopReason) {
        lines.push(theme.fg("error", `[${details.stopReason}]`));
      }
      if (details.isError && details.errorMessage) {
        lines.push(theme.fg("error", `Error: ${details.errorMessage}`));
      } else if (details.displayItems.length === 0) {
        lines.push(theme.fg("muted", details.usage ? "(no output)" : "(running...)"));
      } else {
        lines.push(...renderDisplayItems(details.displayItems, theme, COLLAPSED_ITEM_COUNT));
        if (details.displayItems.length > COLLAPSED_ITEM_COUNT) {
          lines.push(theme.fg("muted", "(Ctrl+O to expand)"));
        }
      }
      if (usageStr) lines.push(theme.fg("dim", usageStr));
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}

export default function (pi: ExtensionAPI) {
  let registered = false;

  pi.on("session_start", async (_event, ctx) => {
    if (registered) return;

    const agents = discoverAgents(ctx.cwd);
    if (agents.length === 0) return;

    registerAgentTool(pi, agents);
    registered = true;
  });
}
