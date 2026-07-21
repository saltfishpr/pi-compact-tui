/**
 * pi-tips: 会话开始时在 TUI 顶部展示一条随机 tip，风格对标 Claude Code / Codex CLI。
 *
 * - session_start（startup / new / resume / fork）触发一次，reload 时不触发。
 * - 通过 pi.appendEntry 插入一条 tui-only 的 entry，不参与 LLM 上下文。
 * - entry 同时持有 tip key 与英文 fallback，renderer 内部通过 rpiv-i18n 的 t(key, fallback) 查表，
 *   /languages 切换 locale 后历史 tip 会自动更新；SDK 缺失或缺翻译时回退到英文原文。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { I18N_NAMESPACE, t } from "./i18n-bridge";
import enLocale from "./locales/en.json" with { type: "json" };

const ENTRY_TYPE = "pi-tip";
const ICON = "※";

const LABEL_KEY = "tip.label";
const LABEL_FALLBACK = enLocale[LABEL_KEY] ?? "Tip";
const TIP_KEYS: readonly string[] = Object.keys(enLocale).filter((k) => k !== LABEL_KEY);

type I18nLoader = {
  registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => void;
};

try {
  const sdk = (await import("@juicesharp/rpiv-i18n/loader")) as I18nLoader;
  sdk.registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, { label: "pi-tips" });
} catch {
  // SDK absent — extension still loads with English-only UI.
}

interface TipEntryData {
  key: string;
  fallback: string;
}

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer<TipEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data;
    if (!data) return new Container();

    const label = t(LABEL_KEY, LABEL_FALLBACK);
    const body = t(data.key, data.fallback);
    return new Text(theme.fg("dim", `${ICON} ${label}: ${body}`), 0, 0);
  });

  pi.on("session_start", (event, ctx) => {
    if (!ctx.hasUI) return;
    if (event.reason === "reload") return;

    const key = TIP_KEYS[Math.floor(Math.random() * TIP_KEYS.length)];
    if (!key) return;

    pi.appendEntry<TipEntryData>(ENTRY_TYPE, {
      key,
      fallback: enLocale[key as keyof typeof enLocale],
    });
  });
}
