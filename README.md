# pi-compact-tui

[Pi](https://pi.dev/) extension bundle that replaces the default editor and footer with compact, distraction-free alternatives.

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

Replaces the default footer with a single-line status bar that surfaces the information you care about.

- **Left side** — current working directory (with `~` for home), git branch, and session name.
- **Right side** — session cost in dollars, context window usage (percentage and token count), and auto-compaction indicator `(auto)`.
- **Alignment** — left and right content are spaced apart and truncated intelligently to fit any terminal width.

### Clear Command

Registers the `/clear` slash command as a shortcut for starting a fresh session.

- `/clear` — alias for `/new`: starts a new session immediately, equivalent to `ctx.newSession()`.

### Commit Prompt

A built-in prompt template (`/commit`) that automates git commits. It gathers the current git status, diff, branch, and recent commit history, then instructs the agent to stage and commit in a single step.

## License

MIT
