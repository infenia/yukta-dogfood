# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tooling (TypeScript on Bun) that develops the sibling [yukta](https://github.com/infenia/yukta) repo *with* Yukta: `yk` runs builds, tests and checks as workflows on a local dev server (`127.0.0.1:9858`, built from yukta `origin/main`) and prints one `RESULT` line. A failing check goes to a self-healing ladder of Claude fixers. See `README.md` (how to run) and `ARCHITECTURE.md` (how it works inside); read those before changing workflows, heal, pickup or ticket code.

## Commands

```bash
bun install --frozen-lockfile && (cd channel && bun install --frozen-lockfile)
bun fmt --check          # formatter (bun fmt to fix); printWidth 140, no semis, single quotes
bun check && bun check -p channel   # typecheck (root and channel/)
bun test                 # root tests (bunfig sets root = "test")
bun test test/plan.test.ts            # one file
bun test -t "name pattern"            # one test by name
(cd channel && bun test)              # channel tests
bun src/heal/gen-session.ts --check   # fail if session.json is stale
bun src/ticket/gen-ticket.ts --check  # fail if ticket-session.json is stale
```

CI (`.github/workflows/ci.yml`) runs exactly these. `yk` itself must be run from inside a yukta checkout (it takes the project from the cwd's git toplevel or `YUKTA_REPO_ROOT`); set `YUKTA_DOGFOOD_HOME` to this clone to use it.

## Gotchas

- `session.json` and `ticket-session.json` are **generated** — never hand-edit. After changing `heal.json` or `src/heal/gen-session.ts`, run `bun src/heal/gen-session.ts`; after changing the ticket flow, `bun src/ticket/gen-ticket.ts`; commit the result. Claude's `Read` of `session.json` is denied in `.claude/settings.json` (huge).
- Workflows come from this checkout (changes apply at once); *plugins* come from the server build, so a plugin change needs a merged yukta commit and `yk up`.
- Process execution goes through `run()` in `src/base.ts`, which has a **binary allowlist** (exit 126 for unlisted binaries); new external tools must be added there (`test/allowlist.test.ts`).
- The mod and `hooks/yk-hook.ts` deny direct `./gradlew`, `go`, `pnpm|npm|npx` and point to `yk`; `YUKTA_DOGFOOD=off` bypasses the hooks.
- Fixer prompts are constant files (`fixer-rules.md` + `fixer-rules/<kind>.md`, chosen in the `case` of `src/heal/claude.ts`) so the prompt cache holds; heal guard rejects fixer edits to `config/`, `build-logic/`, `gradle/`, `.github/`, `.claude/` and this folder.
- JSON contracts for the ticket pipeline live in `schemas/*.schema.json` with valid/invalid samples in `fixtures/<name>/` (validated with `ajv`); add both when changing a schema.

## Layout

- `src/yk.ts` — CLI dispatcher; `src/{base,client,server,check,plan,runs}.ts` — paths/allowlist, server API, dev-server lifecycle, check payload and scoping, run watching and `RESULT` printing.
- `src/heal/` — self-heal (free fix → baseline → triage → fixer ladder → guard → verify) and the generator for `session.json`; config in `heal.json`.
- `src/ticket/` — spec-to-PR ticket pipeline (architect/implementer/test-writer/reviewer roles) and generator for `ticket-session.json`.
- `src/pickup.ts`, `src/input-bridge.ts`, `channel/` — hands GitHub issues to open Claude sessions via an MCP channel server with an HTTP API.
- `mod/` — Claude Code plugin (hooks: gate, plan, rewrite, panes, slash commands); `hooks/` — standalone yk-hook.
- `test/` mirrors `src/`; fakes in `test/ticket/fake/`, `src/fake-ollama.ts` stubs the triage model.
