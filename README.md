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
| `pwd`               | Compact working directory (`~/repos/github.com/user/project` becomes `~/r/g/u/project`).                                 |
| `branch`            | Git branch, wrapped in parentheses.                                                                                     |
| `sessionName`       | Current session name, prefixed with `•`.                                                                                |
| `inputTokens`       | Cumulative input tokens (`↑`).                                                                                          |
| `outputTokens`      | Cumulative output tokens (`↓`).                                                                                         |
| `cacheReadTokens`   | Cumulative cache-read tokens (`R`).                                                                                     |
| `cacheWriteTokens`  | Cumulative cache-write tokens (`W`).                                                                                    |
| `cacheHitRate`      | Cache hit rate of the latest assistant turn (`CH<pct>%`).                                                               |
| `cost`              | Cumulative session cost in USD; appends `(sub)` when using an OAuth subscription.                                       |
| `context`           | Context window usage `pct%/window` plus `(auto)` when auto-compaction is on. Colors as warning / error above 70% / 90%. |
| `provider`          | Active provider in parentheses, shown only when more than one is available.                                             |
| `model`             | Active model id, or `no-model` when no model is selected.                                                               |
| `thinkingLevel`     | Reasoning level for supported models (`• thinking off` / `• <level>`).                                                  |
| `extensionStatuses` | Aggregated status text emitted by other extensions, excluding explicitly positioned keys.                               |
| `status:<key>`       | Status text for one extension key, placed at this exact position; for example `status:codex-stats`.                      |

#### Configuration

Config is loaded from `<agent-dir>/extensions/footer.json` (normally `~/.pi/agent/extensions/footer.json`). When the file does not exist, the extension creates it automatically with the default layout. The file is read when a TUI session starts, so restart the session after changing it.

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

The config file is used as a complete layout: `separator` and `lines` are required, with no merge against the defaults. Each line may define `left`, `right`, or both. Unknown element names render nothing, and lines with no visible content are skipped, so optional status elements are safe to include.

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

- **Rate-limit windows** — displays each window as remaining percentage, for example `5h 77% left 7d 59% left`.
- **Usage colors** — changes from success to warning below 30% left, then error below 10% left.
- **Refresh lifecycle** — refreshes on `session_start`, `model_select`, and `agent_settled`, so retries, compaction, and queued follow-ups finish before usage is fetched again.
- **Authentication** — requires an existing Pi login for the `openai-codex` provider and forwards its `ChatGPT-Account-ID` when available.
- **Cleanup** — clears the status when switching away from Codex or shutting down the session.

### DeepSeek Stats

While the `deepseek` provider is active, calls the DeepSeek Balance API and shows account usage in the footer: `Today ¥0.12 • Session ¥0.03 • Balance ¥9.85`.

- **Today's usage** — difference between the last balance observed yesterday and the current balance.
- **Session usage** — difference between the first balance fetched in the current Pi session and the current balance.
- **Balance history** — persists state in `~/.pi/agent/extensions/deepseek-stats-state.json`; the first run uses the current balance as its baseline.
- **Refresh lifecycle** — refreshes on `session_start`, `model_select`, and `agent_settled`.
- **Authentication** — uses Pi's API key for the `deepseek` provider (usually `DEEPSEEK_API_KEY`).

Display currency is configured in `~/.pi/agent/extensions/deepseek-stats.json`, which is created automatically when missing:

```json
{
  "currency": "CNY"
}
```

`currency` accepts `CNY` or `USD` and selects that currency from the API response; no exchange-rate conversion is performed. Negative differences caused by top-ups are displayed as zero usage.

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
