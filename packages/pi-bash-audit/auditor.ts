import type { Api, Model, ModelThinkingLevel, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type AuditRisk = "low" | "medium" | "high";

export type AuditResult =
  | { kind: "ok"; risk: AuditRisk; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "aborted" };

const AUDIT_TIMEOUT_MS = 10_000;
// 审计只需要一个短 JSON，给一点余量应对 reason 略长的情况。
const MAX_TOKENS = 256;

const SYSTEM_PROMPT = `You are a bash command security auditor. Analyze the given command for risk.

Output ONLY a single JSON object with this exact shape:
{"risk": "low" | "medium" | "high", "reason": "<short explanation>"}

Risk levels:
- low: Safe read-only operations, standard build/test/git commands with no destructive flags.
- medium: Writes to project files, installs packages, modifies git history in safe ways (commit, branch).
- high: Deletes files/directories, force-push, sudo, system-wide changes, network operations to unknown hosts, credential exposure, or anything irreversible on user data.

Do not include markdown, code fences, or any text outside the JSON.`;

export interface AuditCommandOptions {
  ctx: ExtensionContext;
  command: string;
  cwd: string;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  signal?: AbortSignal;
}

/**
 * auditCommand asks the configured LLM whether `command` is safe to run in `cwd`.
 * The model is invoked directly via `completeSimple` (no agent loop, no tools),
 * matching pi's `summarize.ts` example pattern.
 */
export async function auditCommand(options: AuditCommandOptions): Promise<AuditResult> {
  const { ctx, command, cwd, model, thinkingLevel, signal } = options;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return { kind: "failed", reason: auth.error };
  if (!auth.apiKey) return { kind: "failed", reason: `no api key for ${model.provider}/${model.id}` };

  const controller = new AbortController();
  const timedOut = { value: false };
  const timeout = setTimeout(() => {
    timedOut.value = true;
    controller.abort();
  }, AUDIT_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort);

  try {
    const streamOptions: SimpleStreamOptions = {
      apiKey: auth.apiKey,
      maxTokens: MAX_TOKENS,
      signal: controller.signal,
      onPayload(payload, requestModel) {
        switch (requestModel.provider) {
          case "deepseek":
            if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
              return undefined;
            }
            return { ...payload, response_format: { type: "json_object" } };
          default:
            return undefined;
        }
      },
    };
    if (auth.headers) streamOptions.headers = auth.headers;
    if (auth.env) streamOptions.env = auth.env;
    // "off" 表示关闭思考模式，仅在显式开启时透传 reasoning 配置。
    if (thinkingLevel !== "off") streamOptions.reasoning = thinkingLevel;

    const response = await completeSimple(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: `cwd: ${cwd}\ncommand: ${command}` }],
            timestamp: Date.now(),
          },
        ],
      },
      streamOptions,
    );

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) return { kind: "failed", reason: "empty response" };

    let parsed: { risk?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(text) as { risk?: unknown; reason?: unknown };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: "failed", reason: `invalid audit JSON: ${message}\n${text}` };
    }

    if (
      (parsed.risk !== "low" && parsed.risk !== "medium" && parsed.risk !== "high") ||
      typeof parsed.reason !== "string"
    ) {
      return { kind: "failed", reason: "invalid audit JSON shape" };
    }

    return { kind: "ok", risk: parsed.risk, reason: parsed.reason };
  } catch (error) {
    // 超时或外部 abort 都会体现在 controller.signal.aborted 上，区分后再回报。
    if (controller.signal.aborted) {
      return timedOut.value ? { kind: "failed", reason: "audit timed out after 10s" } : { kind: "aborted" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason: message };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}
