import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  Extension,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import type { AgentProfile } from "./agents";
import { logger } from "./logger";
import { getCompactExtensionLabelAdapter } from "./vendor/extension-label";

/** pi 默认 builtin 工具白名单（profile.tools 缺省时启用）。 */
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

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
  let availableSkills: string[] = [];
  let availableExtensions: Extension[] = [];

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    skillsOverride: (base) => {
      availableSkills = base.skills.map((skill) => skill.name);
      return {
        ...base,
        skills: base.skills.filter((skill) => skillWhitelist.has(skill.name)),
      };
    },
    extensionsOverride: (base) => {
      availableExtensions = base.extensions;
      return {
        ...base,
        extensions: base.extensions.filter((extension) => {
          const candidates = [
            extension.resolvedPath,
            extension.sourceInfo.path,
            extension.sourceInfo.source,
            getCompactExtensionLabelAdapter(base.extensions, extension),
          ];
          return candidates.some((candidate) => extensionWhitelist.has(candidate));
        }),
      };
    },
    appendSystemPromptOverride: (base) => (profile.body.trim() ? [...base, profile.body] : base),
  });
  await loader.reload();

  const extensionToolNames = loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
  const tools = [...new Set([...(profile.tools ?? DEFAULT_TOOLS), ...extensionToolNames])];

  logger.debug("createChildSession", {
    cwd,
    tools,
    availableSkills,
    availableExtensions: availableExtensions.map((extension) => ({
      path: extension.path,
      resolvedPath: extension.resolvedPath,
      sourceInfo: extension.sourceInfo,
      compactLabel: getCompactExtensionLabelAdapter(availableExtensions, extension),
    })),
    skills: loader.getSkills().skills.map((skill) => skill.name),
    extensions: loader.getExtensions().extensions.map((extension) => ({
      path: extension.path,
      resolvedPath: extension.resolvedPath,
      sourceInfo: extension.sourceInfo,
    })),
  });

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
