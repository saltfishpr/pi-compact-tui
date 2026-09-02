# pi-compact-tui

A collection of [Pi](https://pi.dev/) extensions for everyday use. It streamlines the TUI, adds useful status information, and provides input history, a shortcut for starting new sessions, and an additional model provider.

![Demo](./assets/demo.gif)

## Installation

### npm

```bash
pi install npm:pi-compact-tui
```

### Git

```bash
pi install git:github.com/saltfishpr/pi-compact-tui
```

## What You Get

| Feature             | Purpose                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Compact editor      | Displays the current activity, model, and reasoning level in the input box border, reducing extra UI clutter.                                |
| Multi-line footer   | Shows the project path, Git branch, session, tokens, cost, context, and other extension statuses in one place.                               |
| Usage status        | Shows subscription limits or account balance in the footer for OpenAI Codex, DeepSeek, and Z.ai.                                             |
| Input history       | Use `shift+↑` / `shift+↓` to retrieve previously submitted inputs. History persists across sessions.                                         |
| Quick new session   | Use `/clear` to start a new session immediately, just like `/new`.                                                                           |
| Automatic Git trust | Automatically trusts projects that match rules based on the domain or username in the `origin` remote URL.                                   |
| Subagents           | Registers an `agent` tool that delegates focused tasks to specialized subagents running in isolated contexts, with live progress in the TUI. |
| Idle recap          | Generates a short session recap when the session goes idle and renders it in a TUI widget. Trigger it manually with `/recap`.                |
| Bash audit          | Asks a configured model to rate outgoing bash commands and either warns you, blocks execution, or asks for confirmation on risky ones.       |
| Session tips        | Shows a short usage tip at the top of the transcript each time a session starts.                                                             |

## Extensions

Each bundled extension works immediately after installation unless its section says otherwise. Global configuration files are stored in `~/.pi/agent/extensions/`.

### Compact Editor (`pi-compact-editor`)

**Usage:** In TUI mode, the input border shows the active model and reasoning level. While the agent works, it also shows states such as thinking, streaming, and the running tool.

**Configuration:** None.

### Compact Footer (`pi-compact-footer`)

**Usage:** In TUI mode, the footer displays configured session, model, token, cost, context, Git, and extension status information.

**Configuration:** The extension generates `~/.pi/agent/extensions/footer.json`. Edit it and restart the Pi session:

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

- `separator` — text inserted between visible elements.
- `lines` — footer rows, each with optional `left` and `right` element arrays.
- Built-in elements: `pwd`, `branch`, `sessionName`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cacheHitRate`, `cost`, `context`, `provider`, `model`, `thinkingLevel`, and `extensionStatuses`.
- Use `status:<key>` to place one extension status explicitly, such as `status:codex-stats`, `status:deepseek-stats`, or `status:zai-stats`.

### Usage Status (`pi-usage-stats`)

**Usage:** The extension displays a status for the selected provider and refreshes it as you work:

- `openai-codex`: remaining percentage for each subscription rate-limit window.
- `deepseek`: today's usage, session usage, and account balance.
- `zai-coding-cn`: today's usage, session usage, and account balance.

**Configuration:** Configure provider credentials in Pi. The extension generates `~/.pi/agent/extensions/provider-stats.json`; all supported providers are enabled by default:

```json
{
  "providers": {
    "deepseek": { "currency": "USD" },
    "zai-coding-cn": { "enabled": false }
  }
}
```

`enabled` defaults to `true`. DeepSeek supports `CNY` and `USD` through `currency`; Z.ai always reports CNY. The compact footer must include `extensionStatuses` or the provider's stable status key: `status:codex-stats`, `status:deepseek-stats`, or `status:zai-stats`.

### Input History (`pi-history`)

**Usage:** Press `shift+↑` to recall an earlier submitted input and `shift+↓` to move forward or restore the draft. History persists across sessions.

**Configuration:** None. The extension manages `~/.pi/agent/extensions/history.jsonl` automatically.

### Clear Command (`pi-clear-command`)

**Usage:** Run `/clear` to start a fresh session. It behaves like `/new`.

**Configuration:** None.

### Automatic Git Trust (`pi-trust-git`)

**Usage:** When Pi checks project trust, the extension reads the `origin` remote and automatically trusts the project if its domain or first path username matches an allowlist. Otherwise, Pi continues its normal trust flow.

**Configuration:** Edit the generated `~/.pi/agent/extensions/trust.json`:

```json
{
  "domains": ["private-gitlab.com"],
  "usernames": ["saltfishpr", "my-team"]
}
```

Matching is case-insensitive, and a match in either list is sufficient.

### Subagents (`pi-subagent`)

**Usage:** Ask Pi to delegate a focused task to `explore` for codebase facts or `planner` for an implementation plan. Each task runs in an isolated session and returns its final answer to the parent session.

```text
Use the planner subagent to inspect this project and create an implementation plan for adding user authentication.
```

**Configuration:** The generated `~/.pi/agent/extensions/subagent.json` enables the `agent` tool by default. Set `enabled` to `false` to disable it.

```json
{
  "enabled": true,
  "maxConcurrent": 4,
  "agents": {
    "explore": {
      "model": "deepseek/deepseek-chat",
      "effort": "medium",
      "maxTurns": 30
    }
  }
}
```

`maxConcurrent` controls how many subagents may run at once (1–32); additional calls wait in FIFO order. Subagents share the current working directory, so parallel editing tasks can conflict.

Use `agents.<name>` to override an individual subagent's `model`, `effort`, or `maxTurns` without editing its Markdown definition. Any field you omit falls back to the subagent's own frontmatter.

To add a custom subagent, create a Markdown file in `~/.pi/agent/agents/` for all projects or `.pi/agents/` for the current trusted project. The filename becomes the subagent name. Run `/reload` after changes.

```markdown
---
description: Reviews code changes for correctness and maintainability without editing files.
tools:
  - read
  - bash
effort: high
---

Review the requested changes and report concrete problems with file references.
```

| Field         | Required | Purpose                                                                                                                 |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `description` | Yes      | Tells Pi when this subagent is useful.                                                                                  |
| `tools`       | No       | Limits the tools it can use. Omit to allow all built-in coding tools.                                                   |
| `model`       | No       | Uses a specific `provider/model`. Omit to inherit the current model. Out-of-scope models fall back to the parent model. |
| `effort`      | No       | Sets reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.                                    |
| `skills`      | No       | Exact allow list of Pi skills. Omit to load no skills.                                                                  |
| `maxTurns`    | No       | Limits how many turns the subagent may take; defaults to 50.                                                            |

Subagent sessions do not load any extensions.

Project definitions require a trusted project. Name conflicts are resolved in this order: project, global, bundled.

### Idle Recap (`pi-recap`)

![Recap](./assets/recap.png)

**Usage:** After the agent finishes, the extension generates a short recap when the session remains idle for 5 minutes. Run `/recap` to trigger it immediately.

**Configuration:** Create `.pi/extensions/recap.json` for the current project or `~/.pi/agent/extensions/recap.json` globally. Project settings take precedence.

```json
{
  "model": "openai/gpt-4o-mini",
  "thinkingLevel": "off",
  "idle": "3m"
}
```

- `model` — optional dedicated model in `provider/model` format; defaults to the current model.
- `thinkingLevel` — optional; `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- `idle` — optional duration such as `"3m"` or `180000`; minimum 5 seconds.

### Bash Audit (`pi-bash-audit`)

**Usage:** Disabled by default. In TUI mode, run `/audit`, then select a model and reasoning level. The extension lets recognised read-only commands run directly and uses the selected model to assess other commands. High-risk commands, unavailable models, and failed audits require your confirmation before execution.

**Configuration:** `/audit` creates `~/.pi/agent/extensions/bash-audit.json`. To configure it yourself, create or edit the file:

```json
{
  "enable": true,
  "model": "openai/gpt-4o-mini",
  "thinkingLevel": "off",
  "rules": [
    { "command": "git", "args": ["log"], "action": "allow" },
    { "command": "git", "args": ["push"], "action": "prompt" }
  ]
}
```

- `enable` — optional; set to `false` to turn auditing off without deleting the configuration.
- `model` — required when auditing is enabled; use `provider/model` format.
- `thinkingLevel` — optional reasoning level supported by the selected model.
- `rules` — optional ordered overrides; the first matching rule applies.
  - `command` matches the command name and `args` matches its arguments. Literal arguments match a prefix; use `*` within one argument, `**` for any number of arguments, or `/regex/` for a full argument match.
  - `action` can be `allow` (run directly), `prompt` (always ask), or `auto` (ask the audit model).
  - `except` optionally excludes argument patterns from a rule.

### Session Tips (`pi-tips`)

**Usage:** A random tip appears at the top of the transcript when a session starts.

**Configuration:** Tips use English by default. To select Chinese or another locale provided by rpiv extensions, install the shared locale extension and run `/languages`:

```bash
pi install npm:@juicesharp/rpiv-i18n
```

## Updating and Uninstalling

### npm

```bash
pi update npm:pi-compact-tui
pi remove npm:pi-compact-tui
```

### Git

```bash
pi update --extensions
pi remove git:github.com/saltfishpr/pi-compact-tui
```

## License

MIT
