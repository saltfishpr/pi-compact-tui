import type { Api, Model, ModelThinkingLevel, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { resolveRecapModelSettings } from "./model";
import { clearRecapWidget, setRecapLoadingWidget, setRecapTextWidget } from "./widget";
import type { RecapConfig } from "./config";

const SYSTEM_PROMPT = [
  "You write concise idle session recaps for a terminal coding agent.",
  "Use only transcript-supported facts; do not invent progress, intent, files, or next steps.",
  "Prefer the latest active task if the session changed direction.",
  "Summarize the user's goal, what was done, current state, and any clearly supported next step.",
  "Respond in the conversation's primary language. Address the user in the second person.",
  "Output 1-2 plain-text sentences under 40 words. No heading, markdown, bullets, or quotes.",
].join("\n");

// 单次 recap 输出的 token 上限，配合提示词约束最终长度。
const MAX_TOKENS = 80;
// 注入到提示词中的会话文本字符上限，超出时仅保留末尾片段以聚焦最近的任务。
const MAX_CONVERSATION_CHARS = 8_000;

/**
 * RecapManager 负责调度并管理空闲会话的总结生成：
 * - 协调模型调用、widget 展示与会话条目写入；
 * - 通过 AbortController 保证同一时刻只有一个生成在途，避免重复或竞态结果。
 */
export class RecapManager {
  private pi: ExtensionAPI;
  private config: RecapConfig;
  // 当前在途的生成任务控制器，用于在新请求到来或主动 clear 时取消旧任务。
  private inflight: AbortController | undefined;
  // 标记当前是否已有有效 recap 展示，避免在未强制刷新时重复生成。
  private active = false;

  constructor(pi: ExtensionAPI, config: RecapConfig) {
    this.pi = pi;
    this.config = config;
  }

  /**
   * 触发一次 recap 生成。
   * - 已有有效 recap 且未传 `force` 时直接跳过，避免重复消耗模型调用；
   * - 每次调用会先取消上一轮在途任务，保证串行执行。
   */
  async run(ctx: ExtensionContext, options: { force?: boolean } = {}): Promise<void> {
    if (this.active && !options.force) return;

    this.cancelInflight();
    const controller = new AbortController();
    this.inflight = controller;

    try {
      const recapModelSettings = await resolveRecapModelSettings(this.pi, ctx, this.config);
      // 期间可能已被取消或被新一轮 run 覆盖，此时应放弃当前结果。
      if (controller.signal.aborted || this.inflight !== controller || !recapModelSettings) return;

      const { model, thinkingLevel, warning } = recapModelSettings;

      setRecapLoadingWidget(ctx, warning);
      // 进入生成阶段，旧 recap 视为失效。
      this.active = false;

      const result = await this.generate(ctx, model, thinkingLevel, controller.signal);
      if (controller.signal.aborted || this.inflight !== controller) return;
      if (!result.content) {
        clearRecapWidget(ctx);
        return;
      }

      setRecapTextWidget(ctx, result.content, warning);
      this.active = true;

      // 将本次 recap 持久化到会话条目，便于后续审阅与统计。
      this.pi.appendEntry("recap", {
        provider: model.provider,
        model: model.id,
        usage: result.usage,
        content: result.content,
      });
    } catch (error) {
      // 已被取消或已被新一轮覆盖的失败不再透出，避免误导用户。
      if (controller.signal.aborted || this.inflight !== controller) return;

      const message = error instanceof Error ? error.message : String(error);
      setRecapTextWidget(ctx, "Unable to generate recap.", message);
      this.active = false;
    } finally {
      // 仅清理属于自己的 controller，防止误清掉新一轮任务的引用。
      if (this.inflight === controller) this.inflight = undefined;
    }
  }

  /** 取消在途生成并清空 widget，恢复到无 recap 状态。 */
  clear(ctx: ExtensionContext): void {
    this.cancelInflight();
    clearRecapWidget(ctx);
    this.active = false;
  }

  // 实际执行一次模型调用，返回清洗后的文本及用量统计。
  private async generate(
    ctx: ExtensionContext,
    model: Model<Api>,
    thinkingLevel: ModelThinkingLevel,
    signal: AbortSignal,
  ): Promise<{ content: string; usage: Usage }> {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);

    const options: SimpleStreamOptions = { maxTokens: MAX_TOKENS, signal };
    if (auth.apiKey) options.apiKey = auth.apiKey;
    if (auth.headers) options.headers = auth.headers;
    // "off" 表示关闭思考模式，仅在显式开启时透传 reasoning 配置。
    if (thinkingLevel !== "off") options.reasoning = thinkingLevel;

    const response = await completeSimple(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: this.buildPrompt(ctx) }],
            timestamp: Date.now(),
          },
        ],
      },
      options,
    );

    // 仅保留文本块，忽略思考过程等非展示内容。
    const content = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    return { content: sanitizeText(content), usage: response.usage };
  }

  // 从当前会话分支构造提示词：过滤出消息条目并按时间序列化，必要时尾部截断。
  private buildPrompt(ctx: ExtensionContext): string {
    const messages = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
    const text = serializeConversation(convertToLlm(messages));
    // 超长时保留末尾片段，确保最近的任务上下文不被丢弃。
    const conversation = text.length > MAX_CONVERSATION_CHARS ? text.slice(-MAX_CONVERSATION_CHARS) : text;

    return [
      "Create a short recap from this transcript, ordered oldest to newest.",
      "It may be truncated from the beginning; focus on the latest coherent task.",
      "",
      "<conversation>",
      conversation,
      "</conversation>",
    ].join("\n");
  }

  // 终止当前在途任务并清空引用，供 run/clear 复用。
  private cancelInflight(): void {
    this.inflight?.abort();
    this.inflight = undefined;
  }
}

/** 将换行、Tab、回车统一替换为空格，并合并连续空格，保证 recap 单行展示。 */
function sanitizeText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}
