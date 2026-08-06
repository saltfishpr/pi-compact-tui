# Domain Docs

## Before exploring, read these

- `CONTEXT-MAP.md` at the repository root; it points to relevant per-context `CONTEXT.md` files.
- `docs/adr/` for system-wide decisions.
- `<context>/docs/adr/` for decisions local to the context.

If these files do not exist, proceed silently. `/domain-modeling` creates them only when terminology or decisions need recording.

## File structure

```text
/
├── CONTEXT-MAP.md
├── docs/adr/
└── packages/
    └── <context>/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

Use terms from the relevant `CONTEXT.md`; flag conflicts with existing ADRs explicitly.
