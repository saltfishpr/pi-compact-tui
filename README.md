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
| Ark Coding Plan     | Registers the `ark-coding-plan` provider, allowing you to select Volcano Ark Coding Plan models directly in Pi.                              |
| Subagents           | Registers an `agent` tool that delegates focused tasks to specialized subagents running in isolated contexts, with live progress in the TUI. |

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

The package includes a read-only `planner` subagent. No setup is required—ask Pi to use it when you need a plan grounded in the current codebase:

```text
Use the planner subagent to inspect this project and create an implementation plan for adding user authentication.
```

Pi delegates the task and shows live progress in the TUI while it runs.

#### Add a Custom Subagent

Create a markdown file in one of these locations:

- `~/.pi/agent/agents/` — available in every project
- `.pi/agents/` — available only in the current trusted project

The filename becomes the subagent name. For example, create `~/.pi/agent/agents/reviewer.md`:

```markdown
---
description: Reviews code changes for correctness and maintainability without editing files.
tools:
  - read
  - bash
effort: high
---

Review the requested changes. Identify concrete bugs, risks, and maintainability issues.
Reference the relevant files and explain how each issue should be fixed.
```

Run `/reload` after creating or editing a subagent. You can then ask Pi to “use the reviewer subagent.”

#### Configuration

| Field         | Required | Purpose                                                                                  |
| ------------- | -------- | ---------------------------------------------------------------------------------------- |
| `description` | Yes      | Tells Pi when this subagent is useful.                                                   |
| `tools`       | No       | Limits the tools it can use. Omit to allow all built-in coding tools.                    |
| `model`       | No       | Uses a specific model in `provider/id` format. Omit to use the current model.            |
| `effort`      | No       | Sets reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.     |
| `skills`      | No       | Loads selected Pi skills for this subagent. Include `read` in `tools` when using skills. |
| `maxTurns`    | No       | Limits how many turns the subagent may take.                                             |

The markdown body defines the subagent's role, constraints, and expected output. Project definitions require a trusted project. If names conflict, project definitions override global definitions, which override bundled definitions.

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
