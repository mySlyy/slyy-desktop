# Documentation site

## Status

Accepted. See [ADR 0079](../../adr/0079-vitepress-documentation-site.md) and
[ADR chinese-docs-entry-points-only](../../adr/chinese-docs-entry-points-only.md),
which Slyy supersedes: the documentation is English only.

## Decision

The `docs/` directory is a standalone VitePress project inside the pnpm
workspace. Markdown remains the source of truth; VitePress supplies the local
development server, static build, local search index, code highlighting, and
versioned navigation shell.

The site has a single English locale at `/`. Slyy removed the upstream
Simplified Chinese locale (`/zh-CN/`) and its locale checker.

Existing `spec/`, `adr/`, `project/`, and guide Markdown files remain in place
so repository links and review history stay stable.

## Local commands

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
pnpm docs:check
```

The production build is static and does not require a runtime service. The
site may load Google Fonts during development or deployment, but the content
and search index are generated locally by VitePress.

`pnpm docs:check` runs `scripts/check-docs.mjs`, a gate over every Markdown
page under `docs/`. It runs in `.github/workflows/docs-check.yml`, which covers
the documentation paths intentionally ignored by the application CI workflow:

1. exactly one H1, except that a `layout: home` page renders its hero instead,
2. balanced code fences, and tables whose rows agree on their column count,
3. the ADR catalog: an `NNNN-slug.md` (or plain slug) file name, one owner per
   decision id, an H1 that declares that id, and the Status, Context, and
   Decision sections,
4. `adr/README.md`, which must list every record exactly once, and may only
   link a row to the record that owns its id,
5. every `ADR NNNN` citation under `docs/`, which must resolve to a record, or
   to a retired id that `08-meta/decisions-log.md` names,
6. `spec/NAV.md`, which must list every specification page, and the `spec/`
   section directories, which stay numbered like `01-product`.

The same workflow then runs the VitePress production build, which validates the
rendered routes and every internal link.

## Content rules

1. All documentation is written in English: specs, ADRs, guides, code
   identifiers, and protocol terms.
2. The sidebar is derived from the Markdown tree so a new specification cannot
   be omitted from deep navigation by accident.
3. User-visible or protocol-visible documentation behavior belongs in the E2E
   test plan.
4. Navigation should expose the shortest useful path; deep files remain
   searchable and directly linkable.
