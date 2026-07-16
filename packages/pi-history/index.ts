import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";

const MAX_HISTORY = 100;

function parseLines(raw: string): string[] {
  const items: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "string") items.push(parsed);
    } catch {
      // skip malformed line
    }
  }
  return items;
}

function tryCompact(file: string, entries: string[]): void {
  try {
    const payload = entries.map((m) => `${JSON.stringify(m)}\n`).join("");
    writeFileAtomic.sync(file, payload);
  } catch {
    // compaction is opportunistic; keep the oversized file if anything fails
  }
}

function appendToFile(file: string, messages: string[]): void {
  if (messages.length === 0) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const payload = messages.map((m) => `${JSON.stringify(m)}\n`).join("");
    appendFileSync(file, payload, "utf8");
  } catch {
    // in-memory history still works for this session even if persistence fails
  }
}

function loadHistory(file: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const items = parseLines(raw);
  const trimmed = items.slice(-MAX_HISTORY);
  // Accepts a brief window where a concurrent append may be lost during compaction.
  if (items.length > MAX_HISTORY * 10) tryCompact(file, trimmed);
  return trimmed;
}

export default function (pi: ExtensionAPI) {
  const historyFile = join(getAgentDir(), "extensions", "history.jsonl");
  let history = loadHistory(historyFile);
  let sessionHistory: string[] = [];
  let cursor: number | null = null;
  let draft = "";

  function flushSessionHistory() {
    if (sessionHistory.length === 0) return;
    appendToFile(historyFile, sessionHistory);
    history = loadHistory(historyFile);
    sessionHistory = [];
  }

  function view(): string[] {
    return sessionHistory.length === 0 ? history : [...history, ...sessionHistory];
  }

  pi.on("input", (event) => {
    if (event.source !== "interactive") return;
    const text = event.text;
    if (!text || text.trim().length === 0) return;
    const combined = view();
    if (combined[combined.length - 1] !== text) {
      sessionHistory.push(text);
    }
    cursor = null;
    draft = "";
  });

  pi.registerShortcut("shift+up", {
    description: "Recall previous user message from history",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      const items = view();
      if (items.length === 0) return;
      if (cursor === null) {
        draft = ctx.ui.getEditorText();
        cursor = items.length - 1;
      } else if (cursor > 0) {
        cursor -= 1;
      }
      ctx.ui.setEditorText(items[cursor] ?? "");
    },
  });

  pi.registerShortcut("shift+down", {
    description: "Recall next user message from history",
    handler: async (ctx) => {
      if (!ctx.hasUI || cursor === null) return;
      const items = view();
      if (cursor < items.length - 1) {
        cursor += 1;
        ctx.ui.setEditorText(items[cursor] ?? "");
      } else {
        cursor = null;
        ctx.ui.setEditorText(draft);
        draft = "";
      }
    },
  });

  pi.on("session_shutdown", () => {
    flushSessionHistory();
    cursor = null;
    draft = "";
  });
}
