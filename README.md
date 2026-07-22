# pi-compact-tui

A collection of [Pi](https://pi.dev/) extensions for everyday use. It streamlines the TUI, adds useful status information, and provides input history, a shortcut for starting new sessions, and an additional model provider.

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
| Usage status        | Shows rate limits or account balance in the footer when using OpenAI Codex or DeepSeek.                                                      |
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
- Use `status:<key>` to place one extension status explicitly, such as `status:codex-stats` or `status:deepseek-stats`.

### Codex Usage Status (`pi-codex-stats`)

**Usage:** Select an `openai-codex` model. The extension displays the remaining percentage for each Codex rate-limit window and refreshes it as you work.

**Configuration:** Configure your OpenAI Codex credentials in Pi. No extension-specific file is required. The compact footer must include `extensionStatuses` or `status:codex-stats` to display the value.

### DeepSeek Usage Status (`pi-deepseek-stats`)

**Usage:** Select a `deepseek` model. The footer shows today's usage, session usage, and current account balance.

**Configuration:** Configure your DeepSeek API key in Pi. To select the displayed currency, edit the generated `~/.pi/agent/extensions/deepseek-stats.json`:

```json
{
  "currency": "CNY"
}
```

Supported values are `CNY` and `USD`. The compact footer must include `extensionStatuses` or `status:deepseek-stats` to display the value.

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

**Usage:** Ask Pi to delegate a focused task to `explore` for codebase facts or `planner` for an implementation plan. The task runs in an isolated context with live progress in the TUI.

```text
Use the planner subagent to inspect this project and create an implementation plan for adding user authentication.
```

**Configuration:** The generated `~/.pi/agent/extensions/subagent.json` enables the `agent` tool by default. Set `enabled` to `false` to disable it.

```json
{
  "enabled": true
}
```

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

| Field         | Required | Purpose                                                                                  |
| ------------- | -------- | ---------------------------------------------------------------------------------------- |
| `description` | Yes      | Tells Pi when this subagent is useful.                                                   |
| `tools`       | No       | Limits the tools it can use. Omit to allow all built-in coding tools.                    |
| `model`       | No       | Uses a specific model in `provider/model` format. Omit to use the current model.         |
| `effort`      | No       | Sets reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.     |
| `skills`      | No       | Loads selected Pi skills for this subagent. Include `read` in `tools` when using skills. |
| `maxTurns`    | No       | Limits how many turns the subagent may take.                                             |

Project definitions require a trusted project. Name conflicts are resolved in this order: project, global, bundled.

### Idle Recap (`pi-recap`)

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

**Usage:** Disabled by default. After enabling it, read-only commands run directly; other `bash` tool calls are classified as `low`, `medium`, or `high` risk. Low- and medium-risk commands show notifications, while high-risk commands and audit failures require confirmation.

**Configuration:** Create `~/.pi/agent/extensions/bash-audit.json`:

```json
{
  "model": "openai/gpt-4o-mini",
  "thinkingLevel": "off"
}
```

- `model` — required to enable auditing, in `provider/model` format.
- `thinkingLevel` — optional; `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

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
