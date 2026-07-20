import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  parseFrontmatter,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as z from "zod";

const GLOBAL_AGENTS_DIR = join(getAgentDir(), "agents");
const PROJECT_AGENTS_DIR = join(".pi", "agents");

// pi's default coding tools, used when an agent omits its own tool allowlist.
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

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

/** Where an agent definition came from, used to gate repo-controlled agents. */
type AgentSource = "global" | "project";

interface LoadedAgent extends Frontmatter {
  name: string;
  source: AgentSource;
  /** Markdown body used as the subagent's system prompt. */
  body: string;
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

// Project agents override global ones with the same name, so load global first.
function discoverAgents(cwd: string): LoadedAgent[] {
  const agents = new Map<string, LoadedAgent>();
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
): Promise<string> {
  const runtime = await getModelRuntime();

  let model = ctx.model;
  if (agent.model) {
    const [provider, ...rest] = agent.model.split("/");
    model = runtime.getModel(provider, rest.join("/"));
  }
  if (!model) {
    throw new Error(`No valid model for subagent "${agent.name}" (configured: ${agent.model ?? "inherit"})`);
  }

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

  const onAbort = () => {
    void session.abort();
  };
  signal?.addEventListener("abort", onAbort);

  try {
    await session.prompt(task);
    if (signal?.aborted) throw new Error(`Subagent "${agent.name}" was aborted`);

    const text = session.getLastAssistantText();
    if (!text) throw new Error(`Subagent "${agent.name}" produced no output`);
    return text;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    session.dispose();
  }
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
      subagent_type: StringEnum(
        agents.map((agent) => agent.name),
        { description: "Which subagent to run" },
      ),
      prompt: Type.String({ description: "The full task for the subagent, including all needed context" }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agent = agents.find((candidate) => candidate.name === params.subagent_type);
      if (!agent) throw new Error(`Unknown subagent: ${params.subagent_type}`);

      // Project agents are repo-controlled and can inject arbitrary system
      // prompts and tool allowlists, so confirm before running one.
      if (agent.source === "project" && ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Run project-local subagent?",
          `Subagent "${agent.name}" is defined in ${PROJECT_AGENTS_DIR}. Project agents are repo-controlled; only continue for trusted repositories.`,
        );
        if (!ok) throw new Error(`Canceled: project-local subagent "${agent.name}" not approved`);
      }

      onUpdate?.({ content: [{ type: "text", text: `running ${agent.name}…` }], details: {} });

      const text = await runSubagent(agent, params.prompt, signal, ctx);
      return { content: [{ type: "text", text }], details: { agent: agent.name } };
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
