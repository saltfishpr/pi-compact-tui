# pi-compact-tui

[Pi](https://pi.dev/) extension bundle with compact TUI components and focused workflow utilities.

## Install

Install from git:

```bash
pi install git:github.com/saltfishpr/pi-compact-tui
```

## Extensions

### Compact Editor

Replaces the default editor with a streamlined one. The top border shows a working indicator (spinning loader) and the current model, giving you a calm, focused experience without unnecessary chrome.

- **Working indicator** — animates when the agent is thinking, streaming, or running tools. The status text updates in real time: `Thinking` → `Streaming` → `Running <tool>` → `Running N tools`.
- **Model label** — the active model is displayed on the right side of the top border.
- **Border fitting** — left and right labels are automatically truncated to fit within the terminal width, ensuring a clean single-line border at any window size.

### Compact Footer

Replaces the default footer with a configurable multi-line status bar. Each line has independent left/right element groups; the two sides are padded apart and truncated intelligently to fit any terminal width.

#### Elements

| Key                 | Description                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pwd`               | Current working directory (with `~` for home).                                                                          |
| `branch`            | Git branch, wrapped in parentheses.                                                                                     |
| `sessionName`       | Current session name, prefixed with `•`.                                                                                |
| `inputTokens`       | Cumulative input tokens (`↑`).                                                                                          |
| `outputTokens`      | Cumulative output tokens (`↓`).                                                                                         |
| `cacheReadTokens`   | Cumulative cache-read tokens (`R`).                                                                                     |
| `cacheWriteTokens`  | Cumulative cache-write tokens (`W`).                                                                                    |
| `cacheHitRate`      | Cache hit rate of the latest turn (`CH<pct>%`).                                                                         |
| `cost`              | Session cost in USD; appends `(sub)` when using an OAuth subscription.                                                  |
| `context`           | Context window usage `pct%/window` plus `(auto)` when auto-compaction is on. Colors as warning / error above 70% / 90%. |
| `provider`          | Active provider, shown only when more than one is available.                                                            |
| `model`             | Active model id.                                                                                                        |
| `thinkingLevel`     | Reasoning level for models that support it (`• off` / `• <level>`).                                                     |
| `extensionStatuses` | Aggregated status text emitted by other extensions, excluding explicitly positioned keys.                               |
| `status:<key>`       | Status text for one extension key, placed at this exact position; for example `status:codex-stats`.                      |

#### Configuration

Config is loaded from `footer.json`, with project settings overriding global ones:

- Project: `{cwd}/.pi/extensions/footer.json`
- Global: `~/.pi/extensions/footer.json`

Schema:

```jsonc
{
  // separator inserted between elements on the same side
  "separator": " ",
  // ordered list of footer lines; each has independent left/right groups
  "lines": [
    {
      "left": ["pwd", "branch", "sessionName"],
      "right": ["status:codex-stats", "cacheHitRate", "cost", "context"],
    },
    { "left": ["extensionStatuses"] },
  ],
}
```

Use `status:<key>` anywhere in `left` or `right` to position one status value. Once a key is explicitly positioned, it is excluded from `extensionStatuses`, even when the positioned value is currently empty.

Arrays replace defaults entirely (no deep merge). Lines with no visible content are skipped, so you can safely list optional elements.

Default layout:

```jsonc
{
  "separator": " ",
  "lines": [
    { "left": ["pwd", "branch", "sessionName"], "right": ["cacheHitRate", "cost", "context"] },
    { "left": ["extensionStatuses"] },
  ],
}
```

### Codex Stats

Shows OpenAI Codex rate-limit usage in the footer status while an `openai-codex` model is active. It calls the Codex usage API with Pi's existing OAuth credentials.

- **Rate-limit windows** — displays each window as used percentage, for example `Codex 5h 23% 7d 41%`.
- **Usage colors** — changes from success to warning above 70%, then error above 90%.
- **Refresh lifecycle** — refreshes on `session_start`, `model_select`, and `agent_settled`, so retries, compaction, and queued follow-ups finish before usage is fetched again.
- **Authentication** — requires an existing Pi login for the `openai-codex` provider and forwards its `ChatGPT-Account-ID` when available.
- **Cleanup** — clears the status when switching away from Codex or shutting down the session.

### Clear Command

Registers the `/clear` slash command as a shortcut for starting a fresh session.

- `/clear` — alias for `/new`: starts a new session immediately, equivalent to `ctx.newSession()`.

### Git Trust

Automatically trusts a project when its `origin` Git remote matches an allowlisted domain or username. If no rule matches, Pi continues with its normal project trust flow.

Configuration is loaded from `~/.pi/agent/extensions/trust.json` (or the equivalent path under a custom Pi agent directory):

```json
{
  "domains": ["github.com", "git.example.com"],
  "usernames": ["saltfishpr", "my-team"]
}
```

- Domain and username matching is case-insensitive.
- Either allowlist can grant trust.
- HTTPS, SSH URL, and SCP-like remote forms are supported.
- Only the `origin` remote is checked.

### Commit Prompt

A built-in prompt template (`/commit`) that automates git commits. It gathers the current git status, diff, branch, and recent commit history, then instructs the agent to stage and commit in a single step.

## License

MIT
