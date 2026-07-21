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

| Feature | Purpose |
| --- | --- |
| Compact editor | Displays the current activity, model, and reasoning level in the input box border, reducing extra UI clutter. |
| Multi-line footer | Shows the project path, Git branch, session, tokens, cost, context, and other extension statuses in one place. |
| Usage status | Shows rate limits or account balance in the footer when using OpenAI Codex or DeepSeek. |
| Input history | Use `shift+↑` / `shift+↓` to retrieve previously submitted inputs. History persists across sessions. |
| Quick new session | Use `/clear` to start a new session immediately, just like `/new`. |
| Automatic Git trust | Automatically trusts projects that match rules based on the domain or username in the `origin` remote URL. |
| Ark Coding Plan | Registers the `ark-coding-plan` provider, allowing you to select Volcano Ark Coding Plan models directly in Pi. |
| Subagents | Registers an `agent` tool that delegates focused tasks to specialized subagents running in isolated contexts, with live progress in the TUI. |

## Optional Configuration

Configuration files are located in `~/.pi/agent/extensions/`.

### Footer Layout

On first run, the extension generates `footer.json`. You can customize the displayed rows, left and right positions, and separator. Restart the Pi session after making changes.

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

### DeepSeek Usage

Before using DeepSeek, configure the corresponding API key in Pi. You can select the balance currency in `deepseek-stats.json`:

```json
{
  "currency": "CNY"
}
```

Supported currencies are `CNY` and `USD`.

### Ark Coding Plan

After setting the API key, use `/model` to select a model from the `ark-coding-plan` provider:

```bash
export ARK_API_KEY="your-api-key"
```

### Automatic Git Trust

Create `trust.json` and configure the allowed Git domains or usernames:

```json
{
  "domains": ["private-gitlab.com"],
  "usernames": ["saltfishpr", "my-team"]
}
```

Matching is case-insensitive, and a match in either list is sufficient. Only the `origin` remote URL is checked. If no rule matches, Pi continues with its default project trust flow.

### Subagents

Subagents are defined as markdown files. They are discovered from three locations, in increasing precedence (a later definition shadows an earlier one with the same name):

- Built-in: shipped with this package
- Global: `~/.pi/agent/agents/`
- Project: `.pi/agents/` (repo-controlled; requires confirmation before each run)

Each file uses YAML frontmatter followed by a markdown body that becomes the subagent's system prompt:

```markdown
---
description: Creates concrete implementation plans from context and requirements. Read-only; never edits code.
tools:
  - read
  - grep
  - find
  - ls
model: anthropic/claude-opus-4-5
effort: high
skills:
  - some-skill
maxTurns: 100
---

You are a planning specialist...
```

| Field | Required | Description |
| --- | --- | --- |
| `description` | Yes | Explains when to use the subagent; shown to the calling agent. |
| `tools` | No | Allowlist of tool names. Defaults to `read`, `bash`, `edit`, `write`. |
| `model` | No | Model override in `provider/id` form. Defaults to the caller's model. |
| `effort` | No | Reasoning level: `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Defaults to Pi's default. |
| `skills` | No | Skill names preloaded into the subagent's system prompt. Requires the `read` tool to load them. |
| `maxTurns` | No | Caps the number of assistant turns; the subagent stops once the limit is reached. |

The subagent runs in a fresh context and cannot see the main conversation, so include everything it needs in the task prompt.

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
