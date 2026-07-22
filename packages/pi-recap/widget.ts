import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Loader, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "pi-recap";

/**
 * 设置 recap 的加载中 widget。
 *
 * 在 UI 上挂载一个带动画的 Loader，提示 "Generating recap..."。
 *
 * @param ctx 扩展上下文，用于挂载 widget。
 */
export function setRecapLoadingWidget(ctx: ExtensionContext): void {
  ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
    const loader = new Loader(
      tui,
      (text) => theme.fg("accent", text),
      (text) => theme.fg("muted", text),
      "Generating recap...",
    );

    return {
      render: (width: number) => {
        const lines = loader.render(width);
        if (lines[0] === "") lines.shift();
        return [truncateToWidth(lines[0] ?? "", width), ""];
      },
      invalidate: () => loader.invalidate(),
      dispose: () => loader.stop(),
    };
  });
}

/**
 * 设置 recap 的文本展示 widget。
 *
 * 以 "Recap: {content}" 的格式渲染 recap 结果；若提供 `warning`，
 * 则追加显示告警信息。
 *
 * @param ctx     扩展上下文，用于挂载 widget。
 * @param content recap 的正文内容。
 * @param warning 可选的告警信息。
 */
export function setRecapTextWidget(ctx: ExtensionContext, content: string, warning?: string): void {
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
    const text = `${theme.bold(theme.fg("muted", "Recap:"))}${theme.fg("muted", ` ${content}`)}${warning ? ` ${theme.fg("warning", `(Warning: ${warning})`)}` : ""}`;

    const container = new Container();
    container.addChild(new Text(text, 1, 0));
    container.addChild(new Spacer(1));

    return container;
  });
}

/**
 * 清除当前的 recap widget。
 *
 * 将该扩展挂载的 widget 重置为 `undefined`，从 UI 上移除显示。
 *
 * @param ctx 扩展上下文。
 */
export function clearRecapWidget(ctx: ExtensionContext): void {
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}
