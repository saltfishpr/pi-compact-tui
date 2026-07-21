import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as z from "zod";

const BUILTIN_AGENTS_DIR = join(import.meta.dirname, "agents");
const GLOBAL_AGENTS_DIR = join(getAgentDir(), "agents");

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const frontmatterSchema = z.object({
  description: z.string().min(1),
  tools: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  model: z
    .string()
    .regex(/^[^/]+\/.+$/)
    .optional(),
  effort: z.enum(THINKING_LEVELS).optional(),
  maxTurns: z.number().int().positive().optional(),
});

type AgentFrontmatter = z.infer<typeof frontmatterSchema>;

export type AgentSource = "builtin" | "global" | "project";

export interface LoadedAgent extends AgentFrontmatter {
  name: string;
  source: AgentSource;
  body: string;
}

export interface AgentDiagnostic {
  path: string;
  message: string;
}

export interface AgentCatalog {
  agents: LoadedAgent[];
  diagnostics: AgentDiagnostic[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.join(".");
      return field ? `${field}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function loadAgentsFromDir(
  dir: string,
  source: AgentSource,
  agents: Map<string, LoadedAgent>,
  diagnostics: AgentDiagnostic[],
): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".md"));
  } catch (error) {
    diagnostics.push({ path: dir, message: `Cannot read agent directory: ${errorMessage(error)}` });
    return;
  }

  for (const file of files) {
    const path = join(dir, file);
    try {
      const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
      const parsed = frontmatterSchema.safeParse(frontmatter);
      if (!parsed.success) {
        diagnostics.push({ path, message: formatValidationError(parsed.error) });
        continue;
      }

      const name = basename(file, ".md");
      agents.set(name, { name, source, body, ...parsed.data });
    } catch (error) {
      diagnostics.push({ path, message: errorMessage(error) });
    }
  }
}

export function discoverAgents(cwd: string, includeProjectAgents: boolean): AgentCatalog {
  const agents = new Map<string, LoadedAgent>();
  const diagnostics: AgentDiagnostic[] = [];

  loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin", agents, diagnostics);
  loadAgentsFromDir(GLOBAL_AGENTS_DIR, "global", agents, diagnostics);
  if (includeProjectAgents) {
    loadAgentsFromDir(join(cwd, CONFIG_DIR_NAME, "agents"), "project", agents, diagnostics);
  }

  return { agents: [...agents.values()], diagnostics };
}
