import type { Theme } from "@earendil-works/pi-coding-agent";

export interface SubscriptionWindow {
  /** Display label, e.g. "5h", "7d", or "1mo". */
  label: string;
  usedPercent?: number;
  resetAtMs?: number;
}

export interface SubscriptionUsage {
  unlimited?: boolean;
  windows: SubscriptionWindow[];
}

export interface SubscriptionFormatOptions {
  showResetTime?: boolean;
  now: number;
}

export function formatSubscriptionStatus(
  theme: Theme,
  usage: SubscriptionUsage,
  options: SubscriptionFormatOptions,
): string {
  if (usage.unlimited === true || usage.windows.every((window) => window.usedPercent === undefined)) {
    return theme.fg("success", "unlimited");
  }

  return usage.windows
    .map((window) => {
      const remainingPercent = window.usedPercent === undefined ? "?" : (100 - window.usedPercent).toFixed(0);
      const quota = `${window.label} ${remainingPercent}% left`;
      const coloredQuota = colorQuota(theme, quota, window.usedPercent);
      if (
        options.showResetTime === false ||
        window.resetAtMs === undefined ||
        window.usedPercent === undefined ||
        window.usedPercent <= 80
      )
        return coloredQuota;
      return `${coloredQuota} ${theme.fg("dim", `🔄${formatRelativeTime(window.resetAtMs, options.now)}`)}`;
    })
    .join(theme.fg("dim", " • "));
}

function colorQuota(theme: Theme, text: string, usedPercent: number | undefined): string {
  if (usedPercent !== undefined && usedPercent > 90) return theme.fg("error", text);
  if (usedPercent !== undefined && usedPercent > 70) return theme.fg("warning", text);
  return theme.fg("success", text);
}

function formatRelativeTime(resetAt: number, now: number): string {
  const remainingMs = resetAt - now;
  if (remainingMs <= 0) return "now";

  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes === 0) return "<1m";

  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}
