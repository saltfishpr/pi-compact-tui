English ｜ [中文](./README.zh.md)

# pi-compact-tui

A collection of [Pi](https://pi.dev/) extensions for everyday use: a compact TUI, additional status information, command auditing, input history, session recaps, subagents, web search, and more.

![Demo](./assets/demo.gif)

## Installation

```bash
pi install npm:pi-compact-tui
# or
pi install git:github.com/saltfishpr/pi-compact-tui
```

Configuration files for all extensions are stored in `~/.pi/agent/extensions/`. A default configuration is generated automatically on first use, so you do not need to create one manually.

## Extensions

### Bash Command Audit (`pi-bash-audit`)

Intercepts bash commands executed by Pi, with two layers of protection:

1. **Rule matching**: includes a built-in allowlist of read-only commands (such as `ls`, `cat`, and `git status`), which are allowed directly. Rules can also explicitly allow a command, require confirmation, or send it to the model for auditing.
2. **Model audit**: commands not allowed by a rule are evaluated for risk by the selected model. High-risk commands display a confirmation dialog for you to decide whether to run them.

**Configuration**: Run `/audit` to select the audit model and reasoning level, or edit `~/.pi/agent/extensions/bash-audit.json` directly:

```json
{
  "enable": true,
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "off",
  "rules": [
    { "command": "pnpm", "args": ["install"], "action": "allow" },
    { "command": "rm", "args": ["-rf"], "action": "prompt" }
  ]
}
```

Field descriptions:

- `model`: Audit model in `<provider>/<model-id>` format. Defaults to the current session model when omitted.
- `thinkingLevel`: `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`.
- `rules`: Each rule contains:
  - `command`: command name (for example, `pnpm`);
  - `args`: arguments to match (for example, `["install"]`);
  - `except`: exceptional argument combinations for which this rule does not apply;
  - `action`: `allow` (allow directly) / `prompt` (require manual confirmation) / `auto` (audit with the model).

### Clear and Start a New Session (`pi-clear-command`)

Provides the `/clear` command, equivalent to `/new`, to start a fresh session.

### Compact Editor (`pi-compact-editor`)

Replaces the default input box and displays status in its border: activity status on the left (Thinking / Streaming / Running xxx), and the current model and reasoning level on the right.

### Configurable Footer (`pi-compact-footer`)

Replaces the default footer with a configurable, multi-line status bar. It supports left and right alignment and lets you arrange the displayed items freely: directory, Git branch, session name, token usage (input/output/cache read/cache write), cache hit rate, cost, context usage, model, reasoning level, and statuses registered by other extensions.

**Configuration**: Edit `~/.pi/agent/extensions/footer.json`:

```json
{
  "separator": " ",
  "lines": [
    {
      "left": ["pwd", "branch", "sessionName"],
      "right": ["cacheHitRate", "cost", "context"]
    },
    { "left": ["extensionStatuses"] }
  ]
}
```

- `lines`: One object per line. `left` and `right` are arrays of item names aligned to their respective sides.
- Available item names: `pwd`, `branch`, `sessionName`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cacheHitRate`, `cost`, `context`, `provider`, `model`, `thinkingLevel`, `extensionStatuses`, and `status:<key>` (references a status registered by another extension, such as `status:codex-stats`).

### Input History (`pi-history`)

Press `Shift+↑` / `Shift+↓` in the input box to browse previous input. The latest 100 entries are persisted across sessions.

### Session Recap (`pi-recap`)

When a session is idle, automatically generates a short recap above the input box (what you are currently doing and the next step). It is cleared automatically when you begin a new input or resume work. You can also run `/recap` at any time to generate one manually.

**Configuration**: Edit `~/.pi/agent/extensions/recap.json`:

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "off",
  "idle": "30s"
}
```

- `model` / `thinkingLevel`: The model and reasoning level used to generate recaps. Defaults to the current session model when omitted.
- `idle`: Time before triggering a recap. Accepts a number (milliseconds) or duration strings such as `"30s"` and `"1m"`; minimum 5 seconds.

> Note: This package already includes recap functionality. If you have separately installed `saltfishpr/pi-recap`, uninstall it to avoid conflicts.

### Subagent (`pi-subagent`)

Provides Pi with an `agent` tool for delegating independent subtasks, such as codebase exploration and planning, to subagents running in isolated contexts. Two subagents are included: `explore` and `planner`; you can add your own as well.

**Add a subagent**: Place a Markdown file in `~/.pi/agents/` (global) or `.pi/agents/` (project). The filename becomes the subagent name:

```markdown
---
description: Review code changes and produce a list of issues
model: anthropic/claude-sonnet-4-5
effort: low
maxTurns: 30
---

Write the subagent system prompt here...
```

- `description` (required): Tells the main model when to use this subagent.
- `model` / `effort` / `maxTurns`: Optional. They inherit the current session model when omitted; `maxTurns` defaults to 50.

**Configuration**: Edit `~/.pi/agent/extensions/subagent.json` to disable the feature, limit concurrency, or override `model` / `effort` / `maxTurns` by subagent name:

```json
{
  "enabled": true,
  "maxConcurrent": 4,
  "agents": {
    "explore": { "effort": "low" }
  }
}
```

### Usage Tips (`pi-tips`)

Displays a random usage tip at the top of every new session, such as keyboard shortcuts and common commands. Supports multiple languages.

### Automatic Git Trust (`pi-trust-git`)

Automatically trusts projects based on their Git `origin` remote, skipping Pi's manual confirmation.

**Configuration**: Edit `~/.pi/agent/extensions/trust.json`. A match against either list automatically trusts the project:

```json
{
  "domains": ["github.com"],
  "usernames": ["saltfishpr"]
}
```

- `domains`: Trusted remote domains (such as `github.com` and `gitlab.com`).
- `usernames`: Trusted first path segments in remotes (for example, `saltfishpr` in `github.com/saltfishpr/xxx`).

### Usage Status (`pi-usage-stats`)

Displays provider usage for the current model in the status bar:

- **openai-codex**: Remaining subscription quota in the 5-hour / 7-day rate-limit windows.
- **deepseek**: Account balance.
- **zai-coding-cn** (Zhipu): Account balance.

**Configuration**: Edit `~/.pi/agent/extensions/provider-stats.json` to disable individual providers as needed or set the balance currency:

```json
{
  "providers": {
    "deepseek": { "enabled": true, "currency": "CNY" }
  }
}
```

Providers not configured are enabled by default.

### Web Search (`pi-web-search`)

Adds a `web_search` tool for finding current or externally verifiable information. Search results include titles, URLs, and snippets, so Pi can cite their sources. The tool is enabled after you configure a provider.

**Configuration**: Edit `~/.pi/agent/extensions/web-search.json` and add the API key for the provider you want to use:

```json
{
  "provider": "bigmodel",
  "maxResults": 5,
  "providers": {
    "bigmodel": {
      "apiKey": "your-api-key",
      "searchEngine": "search_std"
    }
  }
}
```

- `provider`: Active provider: `bigmodel`, `brave`, or `tavily`.
- `maxResults`: Default number of results returned per search, from 1 to 10; defaults to 5.
- `providers.bigmodel`: `apiKey` is required; `searchEngine` can be `search_std` (default), `search_pro`, `search_pro_sogou`, or `search_pro_quark`.
- `providers.brave`: `apiKey` is required.
- `providers.tavily`: `apiKey` is required; `searchDepth` can be `basic` (default) or `advanced`.

## License

MIT
