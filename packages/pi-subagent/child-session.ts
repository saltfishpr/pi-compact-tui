import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
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

export async function createChildSession(options: CreateChildSessionOptions): Promise<AgentSession> {
  const { cwd, profile, model, thinkingLevel } = options;

  const skillWhitelist = new Set(profile.skills ?? []);
  let availableSkills: string[] = [];

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    skillsOverride: (base) => {
      availableSkills = base.skills.map((skill) => skill.name);
      return {
        ...base,
        skills: base.skills.filter((skill) => skillWhitelist.has(skill.name)),
      };
    },
    appendSystemPromptOverride: (base) => (profile.body.trim() ? [...base, "", "", profile.body] : base),
  });
  await loader.reload();

  const tools = [...new Set(profile.tools ?? DEFAULT_TOOLS)];
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
