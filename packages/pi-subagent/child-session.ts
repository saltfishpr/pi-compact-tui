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
import { getCompactExtensionLabel } from "./vendor/extension-label";

/** pi 默认 builtin 工具白名单（profile.tools 缺省时启用）。 */
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/**
 * 按 profile 白名单过滤扩展，返回是否命中。
 */
function matchesExtension(extension: Extension, whitelist: ReadonlySet<string>): boolean {
  const candidates = [
    extension.resolvedPath,
    extension.sourceInfo.path,
    extension.sourceInfo.source,
    getCompactExtensionLabel(extension.resolvedPath, extension.sourceInfo),
  ];
  return candidates.some((candidate) => whitelist.has(candidate));
}

export interface CreateChildSessionOptions {
  cwd: string;
  profile: AgentProfile;
  model: Model<any>;
  thinkingLevel: ModelThinkingLevel;
}

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
