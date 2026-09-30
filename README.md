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

![Command Audit](./assets/audit.png)

**Configuration**: Run `/audit` to select the audit model and reasoning level, or edit `~/.pi/agent/extensions/bash-audit.json` directly:

```json
{
  "enable": true,
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "off",
  "timeoutMs": 10000,
  "rules": [
    { "command": "pnpm", "args": ["install"], "action": "allow" },
    { "command": "rm", "args": ["-rf"], "action": "prompt" }
  ]
}
```

Field descriptions:

- `model`: Audit model in `<provider>/<model-id>` format. Defaults to the current session model when omitted.
- `thinkingLevel`: `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`.
- `timeoutMs`: Model audit timeout in milliseconds. Defaults to `10000`.
- `rules`: Each rule contains:
  - `command`: command name (for example, `pnpm`);
  - `args`: arguments to match (for example, `["install"]`);
  - `except`: exceptional argument combinations for which this rule does not apply;
  - `action`: `allow` (allow directly) / `prompt` (require manual confirmation) / `auto` (audit with the model).

### Clear and Start a New Session (`pi-clear-command`)

Provides the `/clear` command to start a fresh session while keeping the current model and thinking level.

### Compact Layout (`pi-compact-layout`)

Customize the editor borders and footer to put model, usage, and Git information where you want it. Supports a multi-line footer and three editor positions: top-right, bottom-left, and bottom-right. Pi's activity indicator is embedded in the top-left border, while native scrolling hints, shortcuts, and border colors are preserved.

**Configuration**: Edit `~/.pi/agent/extensions/compact-layout.json`, then run `/reload`. The default configuration is:

```json
{
  "separator": " ",
  "footer": [
    {
      "left": [
        "pwd",
        { "kind": "element", "value": "branch", "prefix": "(", "suffix": ")" },
        "sessionName"
      ],
      "right": [
        "status:codex-stats",
        "status:deepseek-stats",
        "status:zai-stats",
        "cacheHitRate",
        "cost",
        "context"
      ]
    },
    { "left": ["extensionStatuses"], "right": [] }
  ],
  "editor": {
    "topRight": [
      { "kind": "element", "value": "provider", "prefix": "(", "suffix": ")" },
      "model",
      { "kind": "element", "value": "thinkingLevel", "prefix": "• ", "suffix": "" }
    ],
    "bottomLeft": [],
    "bottomRight": []
  }
}
```

**Layout fields**:

- `footer`: One object per line, with `left` and `right` arrays aligned to each side. Set to `[]` to hide the footer; lines without content are hidden automatically.
- `editor`: `topRight`, `bottomLeft`, and `bottomRight` place items in the corresponding editor corners. Set to `{}` to clear all three positions without affecting Pi's activity indicator or scrolling hints.
- `separator`: Text between non-empty items in the same array. Defaults to one space.

Items appear in array order, without built-in separators such as bullets or decorative parentheses. Use any item below in any position; move it to change its position, remove it to hide it, or repeat it to display it more than once. Omitting the entire `footer` or `editor` field keeps that section's default layout. Providing a field replaces its entire layout rather than merging with defaults; unspecified line sides or editor positions are empty. Content is truncated or hidden when space is limited, with Pi's activity indicator and scrolling hints taking priority.

**Available items**:

| Item                                  | Displays                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `pwd`, `branch`, `sessionName`        | Current session directory, Git branch, and session name                                                                           |
| `provider`, `model`, `thinkingLevel`  | Current provider, model, and reasoning level (such as `high` or `off`); reasoning level appears only for reasoning-capable models |
| `inputTokens`, `outputTokens`         | Session-wide input and output token totals                                                                                        |
| `cacheReadTokens`, `cacheWriteTokens` | Session-wide cache read and write token totals                                                                                    |
| `cacheHitRate`                        | Input cache hit rate of the latest model response                                                                                 |
| `cost`                                | Session-wide cost, with `(sub)` for subscription models                                                                           |
| `context`                             | Context usage percentage and window size, with `(auto)` when automatic compaction is enabled                                      |
| `extensionStatuses`                   | Other extension statuses without an explicitly assigned position                                                                  |
| `status:<key>`                        | A specific extension status, such as `status:codex-stats`; requires the extension providing that status to be enabled             |

For example, move `status:codex-stats` from the footer to `editor.bottomRight` to show Codex usage in the editor's bottom-right border. Explicitly positioned statuses are excluded from `extensionStatuses`, and extension-provided colors are preserved. Subscription usage and account balances are supplied by this package's `pi-usage-stats` extension and are hidden when no matching status is available.

To decorate an item, use `{ "kind": "element", "value": "branch", "prefix": "(", "suffix": ")" }`. `value` accepts any item above, including `status:<key>`. Optional `prefix` and `suffix` default to empty strings and appear only when the item has content. The default layout uses this to show `(branch)`, `(provider)`, and `model • thinkingLevel`; plain string items remain undecorated.

Arrays can also contain `{ "kind": "literal", "value": "|" }` for custom single-line text. `color` is optional; when provided, it accepts a Pi theme foreground color name, such as `dim`, `accent`, or `warning`. Missing or invalid colors fall back to `dim`.

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


### Subagent (`pi-subagent`)

Provides Pi with an `agent` tool for delegating independent subtasks to subagents running in isolated contexts. Three subagents are included: `explore`, `planner`, and `reviewer`; you can add your own as well.

![Subagent](./assets/subagent.png)

**Add a subagent**: Place a Markdown file in `~/.pi/agents/` (global) or `.pi/agents/` (project). The filename becomes the subagent name:

```markdown
---
description: Review code changes and produce a list of issues
model: anthropic/claude-sonnet-4-5
effort: low
maxTurns: 30
---

!git status --short

Write the subagent system prompt here...
```

- `description` (required): Tells the main model when to use this subagent.
- `model` / `effort` / `maxTurns`: Optional. They inherit the current session model when omitted; `maxTurns` defaults to 50.
- `!command`: Optional shell command at the start of a line (outside code blocks). It runs in the current project directory before the subagent starts; its output is supplied to the subagent.

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

**Command approval**: Before a profile's `!` commands run, choose Deny, Allow once, or Trust this version. In the TUI, `/subagent-trust` lists available profiles: search by name, toggle trust with Enter/Space, select all with Ctrl+A, clear with Ctrl+X, then press Ctrl+S to save all changes at once or Esc to discard them. The command maintains `trustedProfiles` in `subagent.json`; trust is tied to the file path and content hash across all working directories, so edits require fresh approval. Profiles from other projects that are not listed are left unchanged. This approval covers only `!` commands, not the subagent's tools.

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

- **openai-codex**: Remaining subscription quota and relative reset time in the 5-hour / 7-day rate-limit windows.
- **deepseek**: Account balance.
- **zai-coding-cn** (Zhipu): Account balance.

**Configuration**: Edit `~/.pi/agent/extensions/provider-stats.json` to disable individual providers, hide subscription reset times, or set the balance currency:

```json
{
  "providers": {
    "openai-codex": { "showResetTime": false },
    "deepseek": { "enabled": true, "currency": "CNY" }
  }
}
```

Providers and subscription reset times are enabled by default.

### Web Search (`pi-web-search`)

Adds a `web_search` tool for finding current or externally verifiable information. Results include titles, URLs, and snippets for citations. The tool becomes available when a search provider is registered.

**Configuration**: In `~/.pi/agent/extensions/web-search.json`, set `provider` to the default provider ID. `maxResults` sets the default result limit (1–10; defaults to 5). A `web_search` call can override either value. Without a default provider, the call must specify `provider`.

For other search services, see the [custom provider guide](packages/pi-web-search/docs/PROVIDERS.md).

#### BigModel

Built-in provider for BigModel web search. To enable it, add your API key to `~/.pi/agent/extensions/web-search.json`:

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

`searchEngine` can be `search_std` (default), `search_pro`, `search_pro_sogou`, or `search_pro_quark`.

**Migrating from Brave or Tavily:** These built-in providers are no longer available. Existing `provider: "brave"` or `provider: "tavily"` settings will not enable search. Switch to BigModel or register a custom provider using the guide above.

## License

MIT
