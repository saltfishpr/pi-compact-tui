import { basename, dirname, posix, relative } from "node:path";

import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type Extension,
} from "@earendil-works/pi-coding-agent";

import type { AgentProfile } from "./agents";

/** pi 默认 builtin 工具白名单（profile.tools 缺省时启用）。 */
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

export interface CreateChildSessionOptions {
  cwd: string;
  profile: AgentProfile;
  model: Model<any>;
  thinkingLevel: ModelThinkingLevel;
}

/**
 * 按 profile 白名单过滤扩展，返回是否命中。
 * 命中规则采用 pi 官方插件标签格式（镜像 getCompactExtensionLabel），
 * 另接受精确 resolvedPath / sourceInfo.path / source 原始串 / basename。
 */
function matchesExtension(extension: Extension, whitelist: ReadonlySet<string>): boolean {
  const candidates = [
    extension.resolvedPath,
    extension.sourceInfo.path,
    extension.sourceInfo.source,
    extensionLabel(extension),
    basename(extension.resolvedPath).replace(/\.(ts|js)$/, ""),
    basename(dirname(extension.resolvedPath)),
  ];
  return candidates.some((candidate) => whitelist.has(candidate));
}

function extensionLabel(extension: Extension): string {
  const { source, origin, baseDir } = extension.sourceInfo;
  const resolved = extension.resolvedPath;

  if (origin !== "package") {
    const name = basename(resolved).replace(/\.(ts|js)$/, "");
    if (name === "index") {
      return basename(dirname(resolved)) || name;
    }
    return name;
  }

  const sourceLabel = packageSourceLabel(source);
  const rel = baseDir ? relative(baseDir, resolved).replace(/\\/g, "/") : resolved;
  const packagePath = rel.startsWith("extensions/") ? rel.slice("extensions/".length) : rel;
  const parsed = posix.parse(packagePath);
  if (parsed.name === "index") {
    return parsed.dir && parsed.dir !== "." ? `${sourceLabel}:${parsed.dir}` : sourceLabel;
  }
  return `${sourceLabel}:${packagePath}`;
}

function packageSourceLabel(source: string): string {
  if (source.startsWith("npm:")) return source.slice("npm:".length);
  let value = source;
  if (value.startsWith("git:")) value = value.slice("git:".length);
  value = value.replace(/@[^/]*$/, ""); // drop @ref
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // strip protocol://
  value = value.replace(/^[^/@]*@/, ""); // strip user@ / git@
  value = value.replace(":", "/"); // host:path → host/path
  const segments = value.split("/").filter(Boolean);
  if (segments.length >= 3 && segments[0].includes(".")) segments.shift(); // drop host
  return segments.join("/");
}

/**
 * 构造一个同进程内的隔离子会话。
 *
 * 隔离策略：继承父的 AGENTS.md 项目上下文与 pi 默认 system prompt，
 * 按 profile 白名单裁剪 skills / extensions，并把 profile.body 追加到
 * system prompt 之后。扩展白名单里的扩展所注册的工具会自动可用（枚举进
 * `tools` allowlist）。
 */
export async function createChildSession(options: CreateChildSessionOptions): Promise<AgentSession> {
  const { cwd, profile, model, thinkingLevel } = options;
  const skillWhitelist = new Set(profile.skills ?? []);
  const extensionWhitelist = new Set(profile.extensions ?? []);

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    skillsOverride: (base) => ({
      ...base,
      skills: base.skills.filter((skill) => skillWhitelist.has(skill.name)),
    }),
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((extension) => matchesExtension(extension, extensionWhitelist)),
    }),
    appendSystemPromptOverride: (base) => (profile.body.trim() ? [...base, profile.body] : base),
  });
  await loader.reload();

  const extensionToolNames = loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
  const tools = [...new Set([...(profile.tools ?? DEFAULT_TOOLS), ...extensionToolNames])];

  const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel,
    tools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  });

  return session;
}
