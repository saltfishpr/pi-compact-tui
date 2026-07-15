---
description: Create a git commit
---

## Context

- Current git status: run `git status`
- Current git diff (staged and unstaged changes): run `git diff HEAD`
- Current branch: run `git branch --show-current`
- Recent commits: run `git log --oneline -10`

## Your task

Based on the above changes, create a single git commit following the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification.

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. Do not use any other tools or do anything else. Do not send any other text or messages besides these tool calls.

### Commit message format

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

- **type**: one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **scope** (optional): a noun describing the section of the codebase affected.
- **description**: short, imperative, lowercase, no trailing period.
- **body** (optional): explain the *why* and *what*, wrapped at ~72 chars.
- **BREAKING CHANGE**: mark breaking changes with `!` after type/scope (e.g. `feat!:`) and/or a `BREAKING CHANGE:` footer.

Pick the type and scope that best match the diff. If multiple concerns are mixed, choose the dominant one.
