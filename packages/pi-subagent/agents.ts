import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import * as z from "zod";

import { modelSchema, THINKING_LEVELS } from "../pi-common";

const BUILTIN_AGENTS_DIR = join(import.meta.dirname, "agents");
const GLOBAL_AGENTS_DIR = join(getAgentDir(), "agents");

const frontmatterSchema = z.object({
  description: z.string().min(1),
  tools: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  // extensions: z.array(z.string().min(1)).optional(),
  model: modelSchema.shape.model,
  effort: z.enum(THINKING_LEVELS).optional(),
  maxTurns: z.number().int().positive().default(50),
});

type AgentFrontmatter = z.infer<typeof frontmatterSchema>;

export type AgentSource = "builtin" | "global" | "project";

export interface AgentProfile extends AgentFrontmatter {
  name: string;
  source: AgentSource;
  body: string;
  path: string;
  sha256: string;
  commands: string[];
}

export interface AgentDiagnostic {
  path: string;
  message: string;
}

export interface AgentCatalog {
  agents: AgentProfile[];
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

export function profileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function extractCommands(body: string): { body: string; commands: string[] } {
  const commands: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  const lines = body.split("\n").filter((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
        fence = undefined;
      }
      return true;
    }
    if (marker) {
      fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      return true;
    }
    if (!line.startsWith("!")) return true;
    const command = line.slice(1).trim();
    if (!command) throw new Error("Empty ! command in agent profile");
    commands.push(command);
    return false;
  });
  return { body: lines.join("\n"), commands };
}

function loadAgentsFromDir(
  dir: string,
  source: AgentSource,
  agents: Map<string, AgentProfile>,
  diagnostics: AgentDiagnostic[],
): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith(".md"))
      .sort();
  } catch (error) {
    diagnostics.push({ path: dir, message: `Cannot read agent directory: ${errorMessage(error)}` });
    return;
  }

  for (const file of files) {
    const path = join(dir, file);
    try {
      const content = readFileSync(path, "utf8");
      const { frontmatter, body } = parseFrontmatter(content);
      const parsed = frontmatterSchema.safeParse(frontmatter);
      if (!parsed.success) {
        diagnostics.push({ path, message: formatValidationError(parsed.error) });
        continue;
      }

      const name = basename(file, ".md");
      const actualPath = realpathSync(path);
      if (source === "builtin" && !actualPath.startsWith(`${realpathSync(BUILTIN_AGENTS_DIR)}${sep}`)) {
        throw new Error("Bundled agent profile points outside the package");
      }
      agents.set(name, {
        name,
        source,
        path: actualPath,
        sha256: profileHash(content),
        ...extractCommands(body),
        ...parsed.data,
      });
    } catch (error) {
      diagnostics.push({ path, message: errorMessage(error) });
    }
  }
}

export function discoverAgents(cwd: string, includeProjectAgents: boolean): AgentCatalog {
  const agents = new Map<string, AgentProfile>();
  const diagnostics: AgentDiagnostic[] = [];

  loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin", agents, diagnostics);
  loadAgentsFromDir(GLOBAL_AGENTS_DIR, "global", agents, diagnostics);
  if (includeProjectAgents) {
    loadAgentsFromDir(join(cwd, CONFIG_DIR_NAME, "agents"), "project", agents, diagnostics);
  }

  return { agents: [...agents.values()], diagnostics };
}
