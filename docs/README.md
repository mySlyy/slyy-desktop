# Slyy Docs

`docs/` is a VitePress project. The published site starts at [`index.md`](index.md);
the repository's technical source of truth is organized under `spec/`
and `adr/`.

## Local commands

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
pnpm docs:check
```

## Layout

| Path | Contents |
|---|---|
| `spec/` | English specifications; E2E scenarios live in `spec/06-delivery/e2e/` |
| `adr/` | Architecture decision records |
| `guide/` | User guides |
| `plugin-development.md` | Plugin authoring guide |
| `project/`, `implementation/` | Historical records and evidence still cited by specs, scripts, or tests |
| `public/` | Site assets; `public/readme/` also serves the repository READMEs |
| `scripts/` | `check-docs.mjs`, run by `pnpm docs:check` |

All documentation is English only. Retired records remain available in git
history.

## Entry points

- [English documentation site](index.md)
- [Quick guide](guide/index.md)
- [Specification index](spec/README.md)
- [ADR index](adr/README.md)
- [Plugin development](plugin-development.md)
