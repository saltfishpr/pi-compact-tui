import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  AgentSession,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";

import type { AgentProfile } from "./agents";
import { runInChildSessionContext } from "./child-context";
import { logger } from "./logger";

const BUILTIN_TOOLS = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
  ...(process.platform === "win32" ? ["powershell"] : []),
];

const BUILTIN_EXTENSION_FACTORIES: Record<string, () => ExtensionFactory> = {
  mcp: () => createMcpExtension(),
  codemode: () => createCodemodeExtension(),
  "tool-search": () => createToolSearchExtension(),
};

const INDEX_FILE_BASENAMES = new Set(["index.ts", "index.js", "index.mts", "index.mjs", "index.cts", "index.cjs"]);

export interface ResolveWhitelistExtensionsOptions {
  cwd?: string;
  homeDir?: string;
  selfDir?: string;
}

export interface ResolvedWhitelistExtensions {
  builtinNames: string[];
  extensionPaths: string[];
  unmatched: string[];
  excludedSelf: string[];
}

function expandHome(input: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/") || input.startsWith(`~${sep}`)) {
    return join(homeDir, input.slice(2));
  }
  return input;
}

function normalizePathInput(input: string, cwd: string, homeDir: string): string {
  const expanded = expandHome(input, homeDir);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function extractExtensionLogicalName(extensionPath: string): string {
  const file = basename(extensionPath);
  if (INDEX_FILE_BASENAMES.has(file)) {
    return basename(dirname(extensionPath));
  }
  const ext = extname(file);
  return ext ? file.slice(0, -ext.length) : file;
}

function looksLikePathSpec(spec: string): boolean {
  return (
    spec.startsWith("~") ||
    spec.startsWith(".") ||
    spec.includes("/") ||
    spec.includes("\\") ||
    /\.(?:[cm]?[jt]s)$/.test(spec)
  );
}

export function isSelfSubagentExtension(extensionPath: string, selfDir: string = import.meta.dirname): boolean {
  const normalizedTarget = resolve(extensionPath);
  const normalizedSelfDir = resolve(selfDir);
  if (normalizedTarget === normalizedSelfDir || normalizedTarget.startsWith(`${normalizedSelfDir}${sep}`)) {
    return true;
  }
  return extractExtensionLogicalName(normalizedTarget) === "pi-subagent";
}

export function resolveWhitelistExtensions(
  whitelist: readonly string[],
  candidatePaths: readonly string[],
  options: ResolveWhitelistExtensionsOptions = {},
): ResolvedWhitelistExtensions {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const selfDir = options.selfDir ?? import.meta.dirname;

  const builtinNames = new Set<string>();
  const extensionPaths = new Set<string>();
  const unmatched: string[] = [];
  const excludedSelf: string[] = [];

  const normalizedCandidates = candidatePaths
    .filter((candidate) => !candidate.startsWith("builtin:"))
    .map((candidate) => {
      const normalized = normalizePathInput(candidate, cwd, homeDir);
      return {
        raw: candidate,
        normalized,
        logicalName: extractExtensionLogicalName(normalized),
        fileName: basename(normalized),
      };
    });

  for (const rawSpec of whitelist) {
    const spec = rawSpec.trim();
    if (!spec) continue;

    // 1. 内置扩展匹配（如 mcp / builtin:mcp / codemode / tool-search）
    const builtinKey = spec.startsWith("builtin:") ? spec.slice("builtin:".length) : spec;
    if (Object.prototype.hasOwnProperty.call(BUILTIN_EXTENSION_FACTORIES, builtinKey)) {
      builtinNames.add(builtinKey);
      continue;
    }

    // 2. 禁止配置 pi-subagent 自身
    if (spec === "pi-subagent") {
      excludedSelf.push(spec);
      continue;
    }

    // 3. 按路径规范化匹配当前信任上下文中已启用的具体扩展入口（不放行未启用的本地路径或目录）
    const specLooksLikePath = looksLikePathSpec(spec);
    if (specLooksLikePath) {
      const normalizedSpec = normalizePathInput(spec, cwd, homeDir);
      if (isSelfSubagentExtension(normalizedSpec, selfDir)) {
        excludedSelf.push(spec);
        continue;
      }

      const pathMatches = normalizedCandidates.filter(
        (candidate) =>
          candidate.normalized === normalizedSpec ||
          (INDEX_FILE_BASENAMES.has(candidate.fileName) && dirname(candidate.normalized) === normalizedSpec),
      );
      if (pathMatches.length > 0) {
        for (const match of pathMatches) {
          if (isSelfSubagentExtension(match.normalized, selfDir)) {
            excludedSelf.push(spec);
          } else {
            extensionPaths.add(match.normalized);
          }
        }
        continue;
      }
    }

    // 4. 按扩展目录名 / 文件名（去后缀）匹配
    const nameMatches = normalizedCandidates.filter(
      (candidate) => candidate.logicalName === spec || candidate.fileName === spec,
    );
    if (nameMatches.length > 0) {
      let added = false;
      for (const match of nameMatches) {
        if (isSelfSubagentExtension(match.normalized, selfDir)) {
          excludedSelf.push(spec);
        } else {
          extensionPaths.add(match.normalized);
          added = true;
        }
      }
      if (!added && excludedSelf.includes(spec)) continue;
      if (added) continue;
    }

    unmatched.push(spec);
  }

  return {
    builtinNames: [...builtinNames],
    extensionPaths: [...extensionPaths],
    unmatched,
    excludedSelf,
  };
}

function isToolModifierEntry(entry: string): boolean {
  return entry.startsWith("+") || entry.startsWith("-");
}

export function resolveSessionTools(
  profileTools: readonly string[] | undefined,
  extensionToolNames: readonly string[],
): string[] {
  const tools = profileTools ?? BUILTIN_TOOLS;
  if (tools.length === 0) {
    return [];
  }
  if (tools.some(isToolModifierEntry)) {
    return [...tools];
  }
  return [...new Set([...tools, ...extensionToolNames])];
}

export interface CreateChildSessionOptions {
  cwd: string;
  profile: AgentProfile;
  model: Model<any>;
  modelRuntime?: ModelRuntime;
  thinkingLevel: ModelThinkingLevel;
  sessionManager: SessionManager;
  projectTrusted: boolean;
}

export async function createChildSession(options: CreateChildSessionOptions): Promise<AgentSession> {
  const { cwd, profile, model, modelRuntime, thinkingLevel, sessionManager, projectTrusted } = options;

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const skillWhitelist = new Set(profile.skills ?? []);

  const requestedExtensions = profile.extensions ?? [];
  const hasRequestedExtensions = requestedExtensions.length > 0;

  let additionalExtensionPaths: string[] = [];
  let extensionFactories: ExtensionFactory[] = [];

  if (hasRequestedExtensions) {
    const packageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager,
    });
    const resolved = await packageManager.resolve();
    const enabledCandidates = resolved.extensions.filter((entry) => entry.enabled).map((entry) => entry.path);

    const matched = resolveWhitelistExtensions(requestedExtensions, enabledCandidates, { cwd });
    if (matched.excludedSelf.length > 0) {
      logger.warn("Ignored pi-subagent in subagent extensions whitelist to prevent recursion", {
        profile: profile.name,
        excluded: matched.excludedSelf,
      });
    }
    if (matched.unmatched.length > 0) {
      logger.warn("Some subagent extensions in whitelist could not be resolved", {
        profile: profile.name,
        unmatched: matched.unmatched,
      });
    }

    additionalExtensionPaths = matched.extensionPaths;
    extensionFactories = matched.builtinNames.flatMap((name) => {
      const factory = BUILTIN_EXTENSION_FACTORIES[name];
      return factory ? [factory()] : [];
    });
  }

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths,
    extensionFactories,
    skillsOverride: (base) => ({
      ...base,
      skills: base.skills.filter((skill) => skillWhitelist.has(skill.name)),
    }),
    appendSystemPromptOverride: (base) => (profile.body.trim() ? [...base, "", "", profile.body] : base),
  });

  if (hasRequestedExtensions) {
    await runInChildSessionContext(() => loader.reload());
  } else {
    await loader.reload();
  }

  const extensionToolNames = hasRequestedExtensions
    ? loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])
    : [];

  const tools = resolveSessionTools(profile.tools, extensionToolNames);

  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime,
    thinkingLevel,
    tools,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
  });

  return session;
}
