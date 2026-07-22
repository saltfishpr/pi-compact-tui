import type { Model, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export type AuditRisk = "low" | "medium" | "high";

export type AuditResult =
  | { kind: "ok"; risk: AuditRisk; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "aborted" };

const AUDIT_TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT = `You are a bash command security auditor. Analyze the given command for risk.

Output ONLY a single JSON object with this exact shape:
{"risk": "low" | "medium" | "high", "reason": "<short explanation>"}

Risk levels:
- low: Safe read-only operations, standard build/test/git commands with no destructive flags.
- medium: Writes to project files, installs packages, modifies git history in safe ways (commit, branch).
- high: Deletes files/directories, force-push, sudo, system-wide changes, network operations to unknown hosts, credential exposure, or anything irreversible on user data.

Do not include markdown, code fences, or any text outside the JSON.`;

type ReadOnlyEntry = true | Record<string, true>;

// Two-level dictionary: leaf `true` allows the top-level command outright; a nested
// record matches subcommand tokens (or `subcmd + flag` joined by a single space).
const READ_ONLY_COMMANDS: Record<string, ReadOnlyEntry> = {
  ls: true,
  pwd: true,
  echo: true,
  cat: true,
  head: true,
  tail: true,
  wc: true,
  whoami: true,
  hostname: true,
  date: true,
  uptime: true,
  which: true,
  whereis: true,
  type: true,
  env: true,
  printenv: true,
  grep: true,
  rg: true,
  find: true,
  fd: true,
  tree: true,
  file: true,
  stat: true,
  du: true,
  df: true,
  ps: true,
  top: true,
  git: {
    status: true,
    diff: true,
    log: true,
    show: true,
    branch: true,
    remote: true,
    "config --get": true,
  },
  go: { doc: true, version: true, env: true },
  node: { "--version": true },
  npm: { "--version": true },
  pnpm: { "--version": true },
  python: { "--version": true },
  pip: { "--version": true },
  uv: { "--version": true },
};

// Any of these turn a plain-looking command into a compound one where the
// whitelist should not apply (e.g. `ls && rm -rf /`).
const COMPOUND_MARKERS = ["&&", "||", ";", "|", "`", "$(", "\n"];

export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  for (const marker of COMPOUND_MARKERS) {
    if (trimmed.includes(marker)) return false;
  }

  const tokens = trimmed.split(/\s+/);
  const head = tokens[0];
  const entry = READ_ONLY_COMMANDS[head];
  if (!entry) return false;
  if (entry === true) return true;

  const sub1 = tokens[1];
  if (sub1 && entry[sub1] === true) return true;
  const sub2 = tokens[2];
  if (sub1 && sub2 && entry[`${sub1} ${sub2}`] === true) return true;
  return false;
}

export interface AuditCommandOptions {
  command: string;
  cwd: string;
  model: Model<any>;
  thinkingLevel: ModelThinkingLevel;
  signal?: AbortSignal;
}

export async function auditCommand(options: AuditCommandOptions): Promise<AuditResult> {
  const { command, cwd, model, thinkingLevel, signal } = options;

  const controller = new AbortController();
  const timedOut = { value: false };
  const timeout = setTimeout(() => {
    timedOut.value = true;
    controller.abort();
  }, AUDIT_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort);

  try {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => SYSTEM_PROMPT,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    // Pi 0.80.8 handles "off" at runtime but the public type still uses ThinkingLevel.
    const sdkThinkingLevel = thinkingLevel as ThinkingLevel;
    const { session } = await createAgentSession({
      cwd,
      model,
      thinkingLevel: sdkThinkingLevel,
      tools: [],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    });

    const onSessionAbort = () => {
      void session.abort();
    };
    controller.signal.addEventListener("abort", onSessionAbort);

    try {
      const userPrompt = `cwd: ${cwd}\ncommand: ${command}`;
      try {
        await session.prompt(userPrompt);
      } catch (error) {
        if (controller.signal.aborted) {
          return timedOut.value ? { kind: "failed", reason: "audit timed out after 10s" } : { kind: "aborted" };
        }
        throw error;
      }

      if (controller.signal.aborted) {
        return timedOut.value ? { kind: "failed", reason: "audit timed out after 10s" } : { kind: "aborted" };
      }

      const text = session.getLastAssistantText();
      if (!text) return { kind: "failed", reason: "empty response" };

      const parsed = JSON.parse(text) as { risk?: unknown; reason?: unknown };
      if (
        (parsed.risk !== "low" && parsed.risk !== "medium" && parsed.risk !== "high") ||
        typeof parsed.reason !== "string"
      ) {
        return { kind: "failed", reason: "invalid audit JSON shape" };
      }
      return { kind: "ok", risk: parsed.risk, reason: parsed.reason };
    } finally {
      controller.signal.removeEventListener("abort", onSessionAbort);
      session.dispose();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason: message };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}
