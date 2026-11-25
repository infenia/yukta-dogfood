# Dogfood: develop Yukta with Yukta

> How it works inside (workflows, TypeScript, heal, ticket pipeline): [ARCHITECTURE.md](ARCHITECTURE.md).

**Use case:** every build, test and check of this repo runs as a Yukta workflow on a local dev server, so Claude Code (or you)
reads one deterministic result line instead of choosing which checks to run. When a check fails, a repair workflow asks Claude
models, cheapest first, to fix it before a developer has to step in.

This file is the one guide: how to set it up, which commands exist, how heal works, how to operate and improve it. (The former `DESIGN.html` and
`RUNBOOK.md` were folded into it; the old design page is in git history.)

## Setup: two sibling checkouts

This repository holds the tooling only. It works **on** a [yukta](https://github.com/infenia/yukta) checkout:

- `yk` takes the project from the **current directory's** git toplevel (or `YUKTA_REPO_ROOT`), so run it from inside a yukta checkout.
- It reads its own files (`session.json`, `rules.json`, `heal.json`, ...) from the checkout it lives in: `$DEV_HOME/dogfood`
  (`YUKTA_DOGFOOD_HOME` overrides; `DEV_HOME` is `~/.local/state/yukta-dev`). The dev server is built from `$DEV_HOME/main`, a worktree of yukta `origin/main`.
- yukta pins the version it works with in its `.dogfood-ref` (a commit or tag of this repository). In a yukta checkout,
  `scripts/dogfood-setup.sh` clones or updates `$DEV_HOME/dogfood` to that ref, and `scripts/dogfood-hook.sh` runs the Claude Code hooks from it.

```bash
cd yukta && scripts/dogfood-setup.sh      # once, and after a change of .dogfood-ref
export PATH="$HOME/.local/state/yukta-dev/dogfood:$PATH"
yk up                                      # from inside the yukta checkout
```

To develop this repository, clone it anywhere, set `YUKTA_DOGFOOD_HOME` to that clone and run `yk` from a yukta checkout; `bun test` and
`bun check` run here directly, and CI runs them.

| I want to...                                        | Read                                                 |
| --------------------------------------------------- | ---------------------------------------------------- |
| get going                                           | [Setup](#setup), then [Commands](#commands)          |
| understand what a failing `yk check` does           | [Self-healing check](#self-healing-check)            |
| be told when a background run ends                  | [Telling the session](#telling-the-session---notify) |
| turn an idea or a plan into tickets, run one        | [Ticket pipeline](#ticket-pipeline)                  |
| use the Claude Code hooks, panes and slash commands | [Claude Code mod](#claude-code-mod-mod)              |
| fix something that is off, tune costs               | [Operating](#operating)                              |
| change dogfood itself                               | [Developing dogfood](#developing-dogfood)            |

## How it works

```
origin/main ──build──▶ dev server :9858 (one per machine)        ~/.local/state/yukta-dev
                          ▲
any checkout/branch ──yk──┘  session apply → workflow start → problems-only watch → RESULT
```

- **One dev server per machine**, built from `origin/main` (`yk up`), listening on `127.0.0.1:9858`. It is a normal Yukta server that runs the `tool`,
  `check`, `heal`, `attempt`, `agent` and the ticket workflows from `session.json`.
- **`yk` is the client** (`yk`, TypeScript on Bun). It applies the workflow library to a session for your checkout, starts a workflow
  with your working directory in the payload, watches it (problems only) and prints a single `RESULT` line.
- **Workflows come from your checkout, plugins from the server.** Editing `heal.json` or the generators changes what runs at once; a plugin
  change needs a merged commit and a server swap (`yk up`).
- **Blocked on purpose:** the `yukta-dogfood` mod (and `.claude/hooks/yk-hook.ts`) denies direct `./gradlew`, `go` and `pnpm|npm|npx` and names the `yk`
  command to use. `YUKTA_DOGFOOD=off` skips the hooks for one session.

## Setup

**Requires:** `git`, `bun` (everything here is TypeScript on Bun), `curl`, Java 25, Go (the CLI is built with the server).
**Optional:** `opengrep`, `trivy` (stages skipped when absent), `gh` + `cosign` for `yk up --release`, `mint` (docs links), `reuse`, `actionlint`.

```bash
yk up            # build origin/main (minutes the first time per commit) and start it
yk plan          # what a check of your changes would run
yk check         # run it; a failing stage is healed or ends the run
yk status        # what runs, stale or not (exit 3 when down)
```

`yk check`, `yk gradle` and `yk tool` start the server on demand. In Claude Code the SessionStart hook puts `yk` on PATH.

> **PATH matters.** The server inherits its PATH from whoever started it, and the ticket gate runs a bare `yk tool …`. Start it (or
> a session that runs `yk ticket`) only from a shell where `yk` is on PATH (Claude Code, or add this checkout to PATH); otherwise a ticket run stops at the
> gate with `yk: command not found`.

### Keeping the server current

| Command                 | Does                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yk up`                 | fetches `origin/main` into a managed worktree (`~/.local/state/yukta-dev/main`), builds `:boot:bootJar` and the CLI into `builds/<commit>/` (three are kept) and runs the jar |
| `yk up --release [tag]` | runs a published release instead of building                                                                                                                                  |
| `yk status`             | what runs, stale or not (exit 3 when down)                                                                                                                                    |
| `yk down`               | stops the server yk started                                                                                                                                                   |

When main moved, the server is swapped **only while no execution is running**; `yk check` and `yk gradle` complete a pending swap when idle.
The server runs any process, so it needs an API key: `yk` creates one per machine in `~/.local/state/yukta-dev/api-key` and sends it with every call.

**Persistence (PostgreSQL, the default).** Sessions, workflow definitions, run history, node checkpoints and agent conversations are kept in
PostgreSQL, so they survive a restart or a swap. `yk up` builds with `-Pyukta.persistence=postgres` (into `builds/<commit>-pg/`), starts the
Docker container `yukta-dev-pg` (`postgres:18-alpine`, `127.0.0.1:55432` only, `YUKTA_DEV_PG_PORT` to change; data in the volume `yukta-dev-pg`;
password in `~/.local/state/yukta-dev/pg-password`) and runs the server with the `postgres` profile (`src/pg.ts`). `yk status` shows the store.
`YK_PERSISTENCE=memory` keeps everything in memory as before; a release (`--release`) always does. `yk down` leaves the database running;
`docker rm -f yukta-dev-pg && docker volume rm yukta-dev-pg` wipes it. Needs Docker.

## Commands

Every run ends with one line, exit 0 only on success:

```
RESULT status=<S> failed_node=<stage|-> healed=<stage:model/effort,..|-> execution=<id> session=<id> wall=<s> cost=$<heal spend> bytes=<shown to you>
```

Read it and the `ERROR` lines before it, not logs. Run the smallest scope that covers your change.

### Run

| Command                             | Does                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yk gradle [--detach] <args>`       | one Gradle run, e.g. `:core:test --tests X`. Any Gradle flag goes through verbatim (`--info`, `-x test`, `-Dk=v`, `--stacktrace`)                                         |
| `yk tool [--detach] [-C dir] <cmd>` | any other command once: `-C cli go test ./...`, `-C ui npx --no-install prettier --check .`. An environment variable goes through it too: `yk tool env K=V ./gradlew ...` |

`--detach` returns after `STARTED execution=.. session=..`; the run outlives the client. Without it, a foreground `yk` ends its run when interrupted
or stopped (Ctrl-C, or Claude Code stopping a background task). Add `--notify` to hear about the end ([Telling the session](#telling-the-session---notify)).

### Check

| Command                                                                                                        | Does                                                                            |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `yk plan [--full] [--base REF]`                                                                                | dry run: the stages a scoped check of your changes would run (nothing executes) |
| `yk check [--full] [--base REF] [--stage a,b] [--skip a,b] [--no-heal] [--no-fast] [--models m,..] [--detach]` | the scoped, self-healing gate ([how it heals](#self-healing-check))             |

| `yk check` flag              | Meaning                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `--full`                     | everything, unscoped: the gate before a PR                                                            |
| `--base REF`                 | compare against `REF` instead of the merge base with `origin/main`                                    |
| `--stage a,b` / `--skip a,b` | run only / leave out these stages                                                                     |
| `--no-heal`                  | stop at the first failing stage and show it as it is; edits nothing                                   |
| `--no-fast`                  | skip the single combined Gradle invocation that runs first when two or more Gradle stages are planned |
| `--models m,..`              | allow only these models (`haiku,sonnet`); others' rungs stop at once                                  |
| `--detach`                   | return after `STARTED`; follow with `yk watch`                                                        |

**Scope.** The plan is your changes (uncommitted and untracked included) against the merge base with `origin/main`. It narrows the tests to the
changed classes (Tier 1) when only Java files changed, the diff touches no public/protected member or type declaration and every changed class has
its `<Class>Test`: no dependants, no coverage stage, the scope printed on the `# gradle:` line. Anything else runs whole modules plus dependants.

The Stop hook of the `yukta-dogfood` mod asks Claude Code once, before it finishes with uncommitted code changes, to run `yk check`; it stays quiet
when a `yk check` already passed on those changes or the changes were there at session start. With agent teams on, its `TaskCompleted` hook also
stops a teammate from completing a task while `yk check --no-heal` fails ([Agent teams](#agent-teams-experimental)).

### Observe

| Command                                                                  | Does                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `yk watch <session> <execution> [--all\|--stages]`                       | follow a run (problems only; `--stages` adds a `STAGE <name> finished` line per stage, for a Monitor) |
| `yk detail <session> <execution> [--grep P] [--tail N] [--head N]`       | the full output of the stage that failed (the `MORE` line says so)                                    |
| `yk tree [<execution>]`                                                  | which child run failed or is still going                                                              |
| `yk stats`                                                               | runs, failed, median wall and heal dollars per kind of run; fix rate and dollars per stage and rung   |
| `yk heal report\|show [--since 7d] [--run ID] [--project NAME] [--json]` | what heal did: where time and money went, what looks wrong, the raw events                            |
| `yk report [file [--yes]]`, `yk report scan\|on\|off\|status`            | failures captured (a non-success RESULT, a yk crash) and filed as GitHub issues once you approve it   |
| `yk bench [--runs N] [--max-ratio R] [--check] [gradle args]`            | the same Gradle work direct and through yk: `BENCH direct=.. yk=.. ratio=.. overhead=..`              |

`yk bench` takes the median of N runs after a warm-up and exits 1 above R (default 1.5) and +3 s. Measured: `:plugin-api:compileJava` 1.68 s direct,
2.05 s through `yk gradle` (ratio 1.22). `--check` compares `yk check --no-heal` with one direct run of the plan's tasks: 7.9 s against 25.3 s
(3.2x) for the staged chain, which the fast path (#1223) is for. `durations.tsv` keeps milliseconds.

### Steer

`yk tree|pause|resume|stop|skip|retry|break|step|signals|approve|reject`. `stop` is a drain of up to 30 s; add `--tree` to reach the runs below.
`pause` lets the running node finish and holds the next one. `approve|reject` answer a pending approval.

### Resource guard (`yk throttle`)

A Yukta supervisor, `dogfood-resource-guard` (type `http`, `supervisor/resource-guard.json`), owns the run level of every workflow of the `dogfood` session, and
`yk throttle` is its decision maker: while the machine is short of CPU or RAM it sends `PauseWorkflow` directives for the live runs (and the runs they started; the running node
finishes, the next one waits), the oldest run keeps going so it finishes first, and the ones it paused are resumed, oldest first, when the load is gone. A run you paused yourself is never resumed by it.
The server checks every directive (ownership, allow-list, a reason with the load, a rate limit) and audits it: `yk cli supervisors decisions --supervisor dogfood-resource-guard`.
Your own start/stop/pause of those runs go through it as reviews, which the loop answers with ALLOW at once.
**On by default**: the loop starts in the background with the first run (any `yk` command that starts one; that command waits up to 10 s until the guard is attached) and ends when the server stops;
`yk throttle` runs it in the foreground, `YK_THROTTLE=off` opts out and takes the guard off the runs. The guard stays attached when the loop ends (the next `yk` command starts it again); without a loop,
the commands of people on those runs are refused after 5 s. Known problem: see ARCHITECTURE.md, open points.
Pause at 1.5 load per core or under 10% available RAM, resume under 0.9 and over 20%, each after 3 samples in a row (10 s apart); tune with
`YK_THROTTLE_PAUSE_CPU|RESUME_CPU|PAUSE_RAM|RESUME_RAM|HOLD|INTERVAL`. State: `.yukta-dev/throttle.json` (the runs it paused), `throttle.lock`, `guard.ready`, `guard.log`.

### Other

`yk ticket …` ([Ticket pipeline](#ticket-pipeline)). The older commands (`yk run issue|epic`, the
slash commands) are switched off while the loop is rebuilt; their pieces (and the previous guide) are in git history under `examples/11-dogfood/backup/`.

## Telling the session (`--notify`)

**What.** A detached run outlives the command that started it, so nothing told Claude when it ended. With `--detach --notify` (and in the mod's
`/yk-check`), `yk` posts the result into the Claude Code session it was started from. The message arrives as "Another Claude session sent a message":
`[yk] run finished: RESULT status=... ` plus up to 12 problem lines (each `APPROVAL` is posted at once).

**How.** Through [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md): Claude Code exports
`CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` to the hooks and Bash commands of a session. After `STARTED`, a detached
`yk _notify` follows the run, and `notify_session` (`src/lib.ts`, the only place that knows the wire format: an auth line, then a
`{"type":"user",...}` line) writes to that socket. `.yukta-dev/notify-<execution>.log` is the notifier's output.

**Off switches and limits.**

- Not started from such a session (no socket), or `YUKTA_NOTIFY=off`: the run goes on without it.
- Needs a Claude Code with messaging on (v2.1.224 or later). Per the Claude Code docs, a session that bypasses permission prompts holds a message it
  cannot verify came from its own child process until you approve it (the token in the auth line is how it verifies one after the sender exited; only
  a session that prompts was tried here).
- The heal fixers have the socket variables removed (`src/heal/claude.ts`) and never post.
- A received message is a teammate's request, not your approval: it cannot answer a prompt.

## Self-healing check

`yk check` runs the stages of `yk plan` one after the other (cheap first). A failing stage goes to `heal`:

```
stage fails ─▶ 1 free fix ─▶ 2 baseline? ─▶ 3 ladder (fixer sessions) ─▶ 4 guard ─▶ stage re-run ─▶ 5 verify all Gradle stages
               (no model)    known failure   haiku low/medium/high,        reject      pass: healed
                             on main: stop   then sonnet; never commits     bad edits   fail: next rung / FAILED
```

Steps 3 and 4 repeat per rung; the steps below are the order of events, not a list of options.

1. **Free fix**: `spotlessApply`, `make fmt`, `prettier --write`, `eslint --fix`, `make mod-tidy`. No model; the stage runs again.
2. **Baseline**: the failing stage runs once on a clean checkout of `origin/main` (kept in `.yukta-dev/baseline/<sha>`). When it fails
   there with the same problem lines, the stage is a known baseline failure: the heal ends with no fixer. No `origin/main`, a
   timeout or any other error means "not known" and the heal goes on.
3. **Ladder** (`heal.json` `ladder`): `haiku/low → haiku/medium → haiku/high → sonnet/low → sonnet/medium → sonnet/high`. One fresh
   Claude session per rung. An attempt that changed no file ends the ladder, and so does the first failed attempt on `reuse`, `docs` or `actionlint` (`heal.json` `singleAttempt`); the end of the ladder fails the stage. An attempt after which the stage fails exactly as it did after the attempt before (same problem lines, numbers aside) ends the ladder too: a stronger model would start from the same problems.
4. **Guard**: what changed on disk decides, not what Claude says. Rejected: edits to `config/`, `build-logic/`, `gradle/`,
   `.github/`, `.claude/` or this folder, added suppressions, removed assertions, test expectations changed with no code
   change, a claimed fix with no change. Fixers never commit.
   **MCP for fixers**: a fixer reads more of the failed run on demand instead of being handed all of it. claude.ts gives it the server's `/mcp` with the read tools only (`get_failure_digest` and `search_logs` first, which answer in a few KB, then `get_node_output`, `get_execution_tree`, `get_execution_logs`, `get_execution_result`, `get_workflow_status`, `get_workflow_history`, `get_workflow_details`); the mutating tools are denied in `claude.ts` and the key is a named `VIEWER` key (`fixer-key` in the dev state dir, added to `server.properties` when `yk up` starts the server, so a server started before this change needs a restart), which the server enforces. `YUKTA_FIXER_MCP=off` turns it off; another server needs `YUKTA_SERVER_URL` and a `VIEWER` key in `YUKTA_FIXER_MCP_KEY`. Without a key a fixer has no MCP, as before. `test/claude-mcp.test.ts` tests the arguments.
5. **Verify**: if anything was healed, the Gradle tasks of all stages run once more; a failure goes back to heal.

`licenses` and `security` are never healed. `--no-heal` ends the run at the first failing stage. With two or more Gradle stages planned, a `fast` step first runs all their tasks as one Gradle invocation (one start-up, one task graph); when it passes the Gradle stages are no-ops, when it fails the stages run one by one as before, so the failing stage, `failed_node` and the healing are unchanged. `--no-fast` skips it. `--models haiku,sonnet`
leaves a model out (its rungs stop at once).

### How a fixer is launched

Fixers run through `src/heal/claude.ts`: `--permission-mode auto --permission-prompts none` with a command
allowlist, the models pinned to `claude-haiku-5-5` and `claude-sonnet-5-5`, no user plugins, skills, MCP servers or CLAUDE.md,
a per-effort budget and time box. `YK_ADVISOR=sonnet` (experimental, off by default) gives a fixer an advisor model. `YUKTA_BUDGET_CHECK` (USD, default `checkBudget` in `heal.json`, $5) caps what all attempts of one check may cost together: once spent, no further rung starts and the stage ends as the ladder does. The prompt of an attempt carries 12-line excerpts around the `file:line` spots in the problem lines (up to 6). The free fix of `reuse` is `scripts/fix-reuse.ts` (the project header on every file `reuse lint` reports, a `.license` sidecar for types it cannot comment), so `healed=reuse:auto` costs no model call.

### Configuration

- `heal.json`: the ladder (model/effort per rung), the efforts (budget, time box), the healable stages with their free fixes,
  the extra tools (ui, docs, reuse, actionlint).
- `fixer-rules.md`: the common system prompt of every fixer. `fixer-rules/<kind>.md` is appended for the failed stage (`style` → `pmd`, `spotbugs`, `tests` → `junit`, `coverage`, `compile`, `ui_vitest` → `vitest`, other `ui_*` → `ui`, `cli_*` → `go`); any other stage gets the common prompt alone. One constant file per kind, so the prompt cache holds. To add a role, add the file and a line in the `case` of `src/heal/claude.ts`.
- `session.json` is **generated**: after editing `heal.json`, run `bun src/heal/gen-session.ts` (through `bun src/heal/gen-session.ts`), then commit it.
- Events of every heal step: `~/.local/state/yukta-dev/heal-events.jsonl`; records of one run: `<checkout>/.yukta-dev/heal/`.

## Ticket pipeline

From an idea to a reviewed, tested **draft PR**. A ticket is a GitHub issue whose body holds the whole spec, written by an architect at filing
time and reviewed by a person before it runs. Then cheaper models do the work inside hard guardrails: **opus designs, sonnet implements, haiku
writes the test code, sonnet reviews**. Code (not a model) enforces order, gates, scope and budgets. Plan: `design/plans/issue-pipeline-simplification.md`
(this version), `design/plans/ticket-pipeline.md` (the original design).

### Flow

```
plan (design/plans/x.md) ─▶ yk ticket from-plan ─┐                                         ┌▶ test writer (haiku) ─▶ gate-tests (red check)
                                                 ├─▶ issue in Backlog ─▶ you review, edit ─▶ Ready ─▶ yk ticket run <n>
plain text ─▶ yk ticket new ─▶ analyst ─▶ architect┘  (the whole spec)     on GitHub                   │  validate-spec on the current base
                               (questions to you)                                                       ▼  (no longer applies: the architect re-plans)
                                                                 steps one at a time: implementer (sonnet) ─▶ validate-step ─▶ commit
                                                                   fail: retry ─▶ one tier up ─▶ architect revises ─▶ a person
                                                                 full checks ─▶ reviewer (sonnet) ─▶ draft PR `Fixes #n` (never merged)
```

| Name               | Is                | Does                                                                                                                      |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ticket-new`       | workflow          | plain text → analyst → its open questions to you → architect → one issue in Backlog                                       |
| `ticket-from-plan` | workflow          | a plan → the architect splits it → one issue per deliverable, in order, `depends on` the earlier ones                     |
| `ticket-agent`     | workflow          | one Claude Code session on `AGENT_SESSION` (approvals ASK): its questions are input requests (Agents tab, REST, CLI, MCP) |
| `ticket-run`       | workflow          | intake → init (the spec from the body) → route → validate-spec → tests → `round` (`round_steps`, `step`, `finalize`) → PR |
| `revise`           | workflow          | the architect revises the spec after a step fails twice or is blocked                                                     |
| `ticketkit`        | deterministic CLI | schemas, routing, gates, scope checks, failure digests, filing, GitHub side (`src/ticket/ticketkit.ts`)                   |

### Quick start

```bash
yk ticket new "The limiter lets the 101st request through; it must reject it" --dry-run   # look at the body first
yk ticket new "The limiter lets the 101st request through; it must reject it"             # file it (Backlog)
yk ticket from-plan design/plans/rate-limits.md                                           # the tickets of a plan
# review and edit the issue on GitHub, move it to Ready, then:
yk ticket run 123 --detach --notify     # a tested change on branch issue/123 in ../yukta-issue-123
yk ticket status 123                    # which node runs or failed, last events
```

Questions of the analyst and the architect (and any question of a run) wait for you as input requests: answer them in the UI (Agents and
Inputs tabs), with `yukta-cli inputs answer`, or over MCP (`answer_input`). A run ends with a draft PR (`Fixes #123`); it never merges and never
pushes `main`. The run directory is `.yukta-dev/ticket/<run_id>/`, a filing directory `.yukta-dev/filing/<id>/`.

### Commands (`yk ticket ...`)

| Command                                                 | Does                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `new "<text>" [--dry-run] [--detach]`                   | files one ticket from plain text (`ticket-new`); `--dry-run` writes the body to the filing dir instead of filing                 |
| `from-plan design/plans/x.md [--dry-run] [--detach]`    | files the tickets of a plan (`ticket-from-plan`), in order, with their dependencies                                              |
| `run <issue> [--local] [--detach [--notify]]`           | runs `ticket-run`. `--local` uses this checkout's `ticketkit` (session `ticket-local`) instead of the dev server's main checkout |
| `status <issue\|execution>`                             | the run's tree and its last events                                                                                               |
| `resume` / `stop <issue\|execution>`                    | continue a paused run / end it (a drain, like `yk stop --tree`)                                                                  |
| `worktree <issue> [--branch B] [--base REF] [--in DIR]` | a worktree or branch for the issue, reusing what exists (for review fixes)                                                       |
| `pr <issue> [--title T] [--result R] [--worktree W]`    | push the branch and open the draft PR with `Fixes #n`                                                                            |
| `release <issue>`                                       | mark the issue's worktree free (detached at `origin/main`) for the next ticket                                                   |
| `report [--json]`                                       | first-try pass rate, cost share and cache hit ratio by role, prefix mismatches, BLOCKED rate (from `ticket-events.jsonl`)        |

### The ticket body

`src/ticket/body.ts` writes (`renderTicket`) and reads (`parseTicket`) it; `schemas/ticket-body.schema.json` is the contract. Prose sections are
plain text; the parts the run reads field by field are one fenced YAML block each, so an edit on GitHub stays easy and a broken one is caught by
the schema.

| Section                   | Content                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Summary                   | what and why (the spec's objective)                                                                                  |
| Type and size             | `type` (bug, enhancement, feature, refactor, docs, chore), complexity S/M/L, risk with its reason                    |
| Acceptance criteria       | `- [ ] AC1: text (verify: \`command\`)`or`(verify: review)`; the only requirements                                   |
| Architecture              | files and modules touched, new types, what must not change                                                           |
| Steps                     | `### S1: title` + YAML: write_files, read_files, instructions, contracts, done_when, limits                          |
| Tests                     | YAML: mode, locked_files, cases (given / when / expect)                                                              |
| Scope                     | YAML: allowed and forbidden globs, imports, new dependencies                                                         |
| Security                  | what the change exposes, input handling, which checks matter                                                         |
| Decisions                 | every choice the implementer could otherwise ask about, already made                                                 |
| Out of scope, Assumptions | lists                                                                                                                |
| Pipeline roles            | `- implementer: opus/high` binds a model; nothing listed: the router decides                                         |
| Source                    | `- plan:` the plan file, `- base:` the commit the spec was written against, `- depends on: #12, #15`                 |
| Stubs                     | per file `### `path`` and its whole content, bodies that only throw: the scaffold the up-front tests compile against |

`init` turns a valid body into `spec/spec.json` and the run skips the architect; `validate-spec` checks it against the current `origin/main`, and
a spec that no longer applies goes to the architect with the errors. Only an issue **assigned to the person running the pipeline** is trusted this
way (the spec's `done_when` commands run as shell); any other body is data, and only its acceptance criteria count. An issue without a spec body
still runs: the architect writes the spec at run time.

### Models (`modelTable` in `src/ticket/lib.ts`)

| Role        | Model / effort                           | Writes                            |
| ----------- | ---------------------------------------- | --------------------------------- |
| analyst     | sonnet / low                             | the type, a title, open questions |
| architect   | opus / high (medium for S and low risk)  | the spec, once                    |
| test_writer | haiku / medium                           | the test code of the cases        |
| implementer | sonnet / medium; tiers up to opus/high   | the code, step by step            |
| reviewer    | sonnet / medium (high at L or high risk) | a short verdict                   |

### Guardrails, retries and recovery

- **Step ladder.** Attempt 1 with the implementer model; attempt 2 the same model plus the failure digest; attempt 3 one tier up (sonnet/high,
  then opus/high); after that the architect revises the spec; then a person. Mechanical failures (`scope_violation`, `locked_file_modified`,
  `patch_apply_fail`, `format_fail`) retry once, `infra_error`/`timeout` rerun once, a `blocked` step goes straight to a revision.
- **Budgets** (`project.json`): attempts per step, revisions per run, a cost cap by size and a wall-clock cap; over one the run pauses and asks a
  person whether to go on with doubled budgets.
- **Locked tests.** After `gate-tests` the tests are locked in `spec/locked.json`; a step that edits them fails. The architect writes concrete
  cases, the gate checks each fails before the change, and the reviewer checks they cover every criterion, so a cheap test writer stays honest.
- **No approvals inside the run.** You review the ticket before Ready and the draft PR after it.
- **Reading a failure.** The failed node's `ERROR` line names the cause: `blocked`, `schema_invalid`, `api_error`, `cli_crash`, `limit`.

### Source map

| Path                                                 | What                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `schemas/`, `fixtures/<schema>/`                     | the JSON contracts (ticket body, drafts, analysis, spec, step packet and result, digest, revision, review) and their samples |
| `src/ticket/body.ts`                                 | the ticket body ⇄ TicketBody → `spec.json`                                                                                   |
| `src/ticket/file.ts`                                 | filing: prompts per role, the answer checks, the architect's self-check, `gh issue create`, Backlog                          |
| `src/ticket/init.ts`, `route.ts`, `validate-spec.ts` | run dir, worktree, the spec from the body; models and tests mode; the spec checks                                            |
| `src/ticket/call.ts`, `flow.ts`, `ladder.ts`         | one Claude call of a run role; the workflow glue (`has-spec`, `next-step`, ...); the retry ladder                            |
| `src/ticket/gate-tests.ts`, `stepkit.ts`             | the test gate; per-step tools (packet, scope check, regen, free fix, digest, event)                                          |
| `src/ticket/github.ts`, `branch.ts`                  | intake, claim, plan comment, dead end, finish (draft PR); worktrees and branches                                             |
| `src/ticket/gen-ticket.ts` → `ticket-session.json`   | generates every workflow above; `--check` fails when the committed file is stale                                             |
| `src/ticket/walk-workflow.ts`                        | runs a generated workflow offline (the tests), `AGENT_SESSION` through the fake claude                                       |
| `fixer-rules/ticket-*.md`                            | the constant role files of the run roles                                                                                     |

### Tests (`test/ticket/`)

All offline, no API cost (fake `claude`, fake `gh`, throwaway git repos): `body.test.ts` (the body round trip), `file.test.ts` (filing: new,
questions, from-plan), `ticket.test.ts` (the run, including a spec from the body), `ladder.test.ts`, `spec.test.ts`, `gate.test.ts`,
`step.test.ts`, `schemas.test.ts`, `report.test.ts`.

## Claude Code mod (`mod/`)

Name: `yukta-dogfood` (`mod/.claude-plugin/plugin.json`, depends on the generic `yukta` mod). It keeps Claude Code on the `yk` rails: builds, tests and
checks go through Yukta, and a finished set of changes gets a `yk check`. It replaces the former `.claude/hooks/yk-hook.ts` settings hooks; the old
`statusLine` command is dropped.

### What it does

| Where                       | Does                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| session start               | records the uncommitted changes the session began with, starts the dev server (`yk up --background`), puts `yk` on PATH, tells Claude how to build             |
| before a Bash command       | denies `./gradlew`, `gradle`, `go test\|vet\|build\|fmt`, `pnpm\|npm\|npx` and names the `yk` command to use (`bootRun`/`nativeRun` pass) (`hooks/rewrite.ts`) |
| on a prompt                 | a prompt about building or testing gets a one-line pointer to the yukta skill                                                                                  |
| Stop                        | once per set of changes, asks Claude to run `yk check`; quiet when a `yk check` already passed on those changes or they were there at session start            |
| TaskCompleted (agent teams) | a **teammate** cannot complete a task while the shared checkout fails `yk check --no-heal` ([below](#agent-teams-experimental); `hooks/gate.ts`)               |
| `/yk-check`                 | runs `yk check --detach` and follows its stages in a pane with a Stop button                                                                                   |
| `/yk-plan`                  | prints `yk plan` in a pane                                                                                                                                     |

The enforcement (deny, Stop nudge) is also in `.claude/hooks/yk-hook.ts`, registered in `.claude/settings.json`, so it works without installing this
mod; the mod adds the panes and commands.

**Off:** `YUKTA_DOGFOOD=off` turns every hook off for a session (raw Gradle, your call). Headless fixers (`YUKTA_HEAL_FIXER=1`) are skipped.

### Install

```
/plugin install yukta-dogfood --marketplace infenia/yukta
```

In `/config` set the `yukta` mod's
`headers_command` `bash -c 'exec \"${YUKTA_DOGFOOD_HOME:-$HOME/.local/state/yukta-dev/dogfood}\"/yk mcp-headers'` (it gives the Yukta MCP server its key).

### Files (`mod/hooks/`)

| File                   | What                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `register.tsx`         | registers the hooks, the commands and the panes (`hooks.json` lists it)          |
| `rewrite.ts`           | which build, test or lint command must run through `yk`, and how                 |
| `gate.ts`              | the message a teammate gets back when `yk check --no-heal` fails                 |
| `plan.ts`, `panes.tsx` | parsing of `yk plan` / `yk watch --stages` output, and the look of the two panes |
| `*.test.ts(x)`         | tests: `claude plugin test mod`                                                  |

### Agent teams (experimental)

[Agent teams](https://code.claude.com/docs/en/agent-teams.md) need `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and an interactive lead. When a teammate
marks a task completed (or ends its turn with a task in progress), the mod's `classic.TaskCompleted` hook runs `yk check --no-heal` and, if it fails,
refuses the completion with the RESULT line and up to 12 problem lines; the teammate fixes and tries again. It is the team version of the Stop nudge.

- **Who and when.** Only a teammate's completion is gated (the lead's and a plain session's pass), and only with code changes (`git status` on the
  code globs). A tree a `yk check` already passed on (the `last-result` file) passes without another run.
- **`--no-heal` on purpose.** Teammates share one checkout, a healing check takes the checkout lock, and a fixer must not edit files under a team. It
  takes no lock and queues on the server, so teammates finishing together run their checks one after another. Healing stays with the lead: run
  `yk check` once all tasks are done.
- **Whole diff.** A failure can be another teammate's file: give each teammate its own files (the agent-teams advice anyway).
- **Fails open.** No RESULT line, a run over nine minutes or a `yk` that does not start never blocks a task. `YUKTA_DOGFOOD=off` turns it off.
- **Tested** offline (`gate.test.ts`, `register.test.tsx`), not with a live team: spawning teammates needs an interactive session.

## Design notes and measurements (ticket pipeline)

Reference material behind the decisions above; not needed to use the pipeline.

#### Answers to the VERIFY items

Resolves #1874 for `design/plans/ticket-pipeline.md` (Section 15 wins). Facts are from `main` at the time of writing; each answer names the file or command.

| #   | Question                             | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Consequence                                                                                                                                                                                                                                                        |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | How does `medium` effort map?        | `src/heal/claude.ts` passes `YK_EFFORT` (`low`, `medium`, `high`) straight to `claude --effort`, so the model side already supports `medium`. What is missing is the budget and time box: `heal.json` `efforts` has only `low` (600 s, $0.5) and `high` (1800 s, $2); `src/heal/gen-session.ts` builds its table from that key.                                                                                                                                                               | Add `"medium": {"timeoutSeconds": 1200, "budget": 1}` to `heal.json` (or a `ticket.json` of the new pipeline) in #1875. No code change.                                                                                                                            |
| 2   | Stage names                          | `yk plan --full` prints: `spotless compile tests coverage style spotbugs licenses security` (Gradle), `cli.fmt-check cli.mod-verify cli.vet cli.lint cli.sec cli.cover-check cli.vuln` (Go), `ui.tsc ui.eslint ui.vitest ui.headers ui.build` (UI, with `ui.prettier` when files changed), `reuse actionlint docs`. `--stage`/`--skip` treat `-` and `_` as the same (`filter_plan` in `src/lib.ts`), but not `.`: pass the name as `yk plan` prints it (`ui.tsc`, `cli.vet`).                | The doc's list in 15.5 is right for Gradle. The doc's `ui_*`/`cli_*` spellings must be written `ui.*`/`cli.*` in `--stage`; heal events and `RESULT healed=` print the underscore form (`ui_prettier`); the stage `style` is Checkstyle plus PMD on main and test. |
| 3   | Parallel wave                        | `SUB_WORKFLOW` has `concurrency` (default 1, up to 16, results keep message order) and a `SPLITTER` before it produces one message per step. A child uses its parent's execution slot.                                                                                                                                                                                                                                                                                                        | A wave is `SPLITTER` -> `SUB_WORKFLOW{concurrency: max_parallel}` -> `AGGREGATE`. No fixed branches needed. Gradle load is bounded by the `tool` concurrency group (2), not by this setting.                                                                       |
| 4   | Executor allowlist                   | The property is `yukta.process.allowed-commands` (exact executable names; empty means nothing runs), with `yukta.process.allowed-env` and `yukta.process.working-dir-root` (`docs/reference/configuration.mdx`). The dev server is started with `YUKTA_PROCESS_ALLOW_ANY=true` (`src/lib.ts`), so no list is needed for `yk`.                                                                                                                                                                 | A hardened server must list the `ticketkit` entry script and claude.ts by the name used in the command. Noted here (#1879).                                                                                                                                        |
| 5   | `docs/api/openapi.json` regeneration | No task, script or workflow regenerates it. It is a hand-kept second snapshot: it differs from the tested `ui/openapi.json` only by deprecated flags on 15 legacy routes and its own `info`/`servers`/`security` (`design/plans/docs-sync/plan.md` line 38). `ui/openapi.json` is regenerated by `yk gradle :boot:test --tests "*OpenApiSnapshotTest" -Pyukta.openapi.update=true` and the types by `pnpm run api:types -- openapi.json` (`design/decisions/0001-input-requests.md` line 85). | `project.json` correctly lists only `ui/openapi.json` and the types as generated; add `docs/api/openapi.json` to `denied_read` (already) and to the scope-check deny list so a step cannot edit it. A docs step that needs it is high risk.                        |
| 6   | Cache tokens in `claude` output      | Yes. `src/heal/heal.ts` line 285 already reads `usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` and `output_tokens` from the headless result.                                                                                                                                                                                                                                                                                                                   | Copy that jq into the `ticket-events.jsonl` writer (#1878, #1884).                                                                                                                                                                                                 |
| 7   | Per-test report for Vitest           | `ui/vitest.config.ts` already emits coverage `json`; for tests use `vitest run --reporter=json --outputFile=<file>` (a standard Vitest option; not used in the repo yet). JUnit XML for Gradle is in `<module>/build/test-results/test/`; Go: `go test -json`.                                                                                                                                                                                                                                | Gate-tests (#1877) reads these three; confirm the Vitest flags in its first test run.                                                                                                                                                                              |
| 8   | Merge policy                         | PRs are squash-merged and the PR title becomes the commit (`.github/WORKFLOWS.md` line 241, `CONTRIBUTING.md` line 59).                                                                                                                                                                                                                                                                                                                                                                       | Step commits on the run branch are free-form Conventional Commits; only the PR title matters.                                                                                                                                                                      |
| 9   | `plus/*` and Playwright              | `plan.ts` line 195: Playwright specs in `ui/e2e` run only in the full gate, not per step. `plus/` is `high_risk` in the profile.                                                                                                                                                                                                                                                                                                                                                              | Per-step gates skip e2e; a step touching `plus/**` or `ui/e2e/**` is high risk, which the person reviewing the ticket sees before Ready.                                                                                                                           |

##### Design changes

- 15.5 and 15.4: `docs/api/openapi.json` is not generated (item 5).
- 15.2 item 4: the wave is `SPLITTER` + `SUB_WORKFLOW` with `concurrency`, not two fixed branches (item 3).
- No server or CLI change is needed, so no extra issue is filed.

#### Measurements

##### Parallel steps against sequential steps (#1884)

Kept as history: waves were removed on 2026-11-25 (no real run used them; steps now run one at a time). Measured once on 2026-11-03 with `test/ticket/waves.test.ts` (the generated `ticket` workflow walked offline, a fake Claude, a 3 s step gate): two steps on disjoint files.

| Run                                                               | Wall clock |
| ----------------------------------------------------------------- | ---------- |
| two steps in a wave (parallel worktrees, merged, post-wave check) | 12 s       |
| the same two steps in sequence (the second depends on the first)  | 18 s       |

What this shows: the wave overlaps the first step's validation with the second step's implementation and validation, and the saving is the overlap. It does not include real model latency or a real Gradle gate; with a real gate of minutes the saving is larger, and the second step still waits for the first step's first implementer call (cache warm-up, design 11.1). Measure it again on a real ticket once real runs are allowed.

##### Sample report (10 offline runs, fake Claude)

`ticketkit report --events <ticket-events.jsonl>` on ten runs (five single-step, two parallel, one with a blocked step, one chain, one more single): first try 93% for haiku/medium/standard, cache hit ratio 89% per role (the fake reports 900 cache-read tokens in 1010), no `prefix_hash` mismatch, BLOCKED rate 7%. The numbers are those of the fake, not of a real model.

## Operating

Day-to-day running, tuning and repair of the dogfood loop.

### Where things are

| What                                                   | Where                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| the events log (all runs, all checkouts)               | `$DEV_HOME/heal-events.jsonl` (`~/.local/state/yukta-dev/`), `YUKTA_HEAL_EVENTS` |
| the records of one run (attempts, outputs, exit codes) | `<checkout>/.yukta-dev/heal/<session>/` (wiped by the next `yk check`)           |
| the heal policy (the ladder, efforts, `giveUp`)        | `heal.json`                                                                      |

### What costs money, what touches the outside

| Command                 | Spends                                                                                              | Touches                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `yk check`, `yk gradle` | Claude only when a stage fails and heal runs a fixer ($ per attempt: `heal.json` `efforts` budgets) | your working tree (fixers edit it, never commit)                                                               |
| `yk run issue\|epic`    | an implementer ($5 cap) and fixers                                                                  | the issue and the project board, a worktree, a pushed branch, a draft PR                                       |
| `yk heal report\|show`  | nothing                                                                                             | nothing (reads `heal-events.jsonl`; events written without a run id take the run of the session's next result) |

### The improvement loop

1. **Run it.** `yk check` (or let the Stop hook do it). Nothing to configure: events are on by default.
2. **Look.** `yk heal report --since 7d`. Read it top to bottom: _where the time goes_, the stage table (a slow stage is a slow
   check, not a heal problem), the heals (solved at which rung), the cost per rung, the failures that came back.
3. **File what failed.** The Stop hook runs `yk report scan` (turn it off with `yk report off`, back on with `yk report on`, or `YUKTA_REPORT=off`). `yk report` lists the failures yk captured (a RESULT that was not SUCCESS, a yk crash); `yk report file` drafts one GitHub issue per new fingerprint, `--yes` files it (a repeat comments on the open issue, a closed one is filed again as a regression).
4. **Fix it, and measure.**
   - a fixer wastes money or wanders: read its `fix` events (`summary`, `files`, `guard`), fix `fixer-rules.md` or the guard;
   - the same failure keeps coming: fix the cause, or its check.

### Knobs

`heal.json` `giveUp` {`minAttempts`, `maxFixRate`, `days`}: a stage whose model attempts in the last `days` days were fixed at most `maxFixRate` of the time, after at least `minAttempts` of them, is not tried again (the check reports the failure; attempts that never started do not count; the free `auto` fix still runs); read from `YUKTA_HEAL_EVENTS`.
`YUKTA_HEAL_EVENTS` (file, or `off`), `YUKTA_HEAL_BUDGET` (USD per attempt, set per effort by `heal.json`), `YUKTA_BUDGET_ISSUE` (USD per issue run),
`yk check --models sonnet,opus`, `yk check --pause before-opus`.
For issue runs: `YUKTA_IMPL_MODEL` (opus), `YUKTA_IMPL_BUDGET` (5), `YUKTA_BUDGET_EPIC`, `YUKTA_WARM_DELAY`, `YUKTA_NAV_BACKENDS`,
`YUKTA_NAV_IDE`, `YUKTA_NAV_IDE_URL`, `YUKTA_NAV_CBM_BIN`, `YUKTA_NAV_CBM_CACHE`, `YUKTA_NAV_INDEX_TIMEOUT`.

### Troubleshooting

| Symptom                                            | Cause and fix                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yk check` says another healing check is running   | the watcher of the last run holds the lock for a few seconds; wait or `yk stop`                                                                                                 |
| no events                                          | `YUKTA_HEAL_EVENTS=off` is set, or the dev server was started before this change: `yk up`                                                                                       |
| `yk heal report` says no events for this selection | `--since`, `--run` or `--project` filter everything out                                                                                                                         |
| a fixer hit a guard (`guard-hits`)                 | it touched `config/`, `build-logic/`, `gradle/`, `.github/`, `.claude/`, the dogfood tooling, added a suppression or removed assertions; its edits stay in the tree: `git diff` |
| the dev server runs old code                       | `yk up` rebuilds from `origin/main`; the workflows come from your checkout, the plugins from the server                                                                         |

### Gradle start-up (measured 2026-10-28, #1224)

- **One daemon.** Every `yk gradle` stage runs as a child of the dev server with the server's environment; after hours of runs next to an interactive session there was a single `GradleDaemon` process (4 h uptime, about 3.8 GB), so the stages reuse the daemon instead of starting one each. If `JAVA_HOME` or the JVM args of the server ever differ from your shell's, Gradle starts a second one: `yk gradle --status` lists them.
- **Unscoped no-op `spotlessCheck`: about 10 s** on a warm daemon (not the 4.6 s of the estimate: spotless itself walks every source set). A scoped stage (`:core:...`) stays near the 1.8 s of direct Gradle. The 2.5 s target does not hold for an unscoped run; scope it (`yk check` already does).
- **Configuration cache stays off.** `--configuration-cache` on the same task took about 40 s, four times slower, and logged `Stopping file watching and invalidating VFS after an error`: tasks of the build (the Go tasks of `cli`, per the comment in `gradle.properties`) are not compatible, so each run stores a new entry and then discards it. Fixing or excluding those tasks is a build change of its own, not part of the dev loop. The build cache (`org.gradle.caching=true`) is already on.

### Notes

- Sessions: one per checkout and command (`check-<branch>-<hash of the path>`, suffix `-plan` for `yk check`, `-gradle` for `yk gradle`/`yk tool`); the library is applied to it on every run, and the working directory travels in the start payload.
- One healing `yk check` per checkout at a time (`.yukta-dev/check.lock`; the refusal names the execution that holds it). `yk gradle`, `yk tool` and `yk check --no-heal` do not edit the checkout, take no lock and queue on the server (`yk tree` shows QUEUED).
- The previous README (issue and epic runs, heal analysis, the analyzers heal) is in git history before this change.

## Developing dogfood

Changing `yk`, heal or the ticket pipeline itself.

### Layout

`src/` holds the `yk` core (`yk.ts`, `runs.ts`, `plan.ts`, `lib.ts` and its parts `base`, `client`, `server`, `check`), `src/heal/` the self-healing check (`heal`, `claude`, `heal-report`, `fix-reuse`, `gen-session`) and `src/ticket/` the ticket pipeline (`ticketkit`, `body`, `file`, `ladder`, `flow`, `gen-ticket`, `yk-ticket`, ...). `test/` mirrors it: `test/heal/`, `test/ticket/` (with `helpers.ts` and `fake/`), the rest next to `helpers.ts`.

| Path                                  | What                                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yk`                                  | the one entry point                                                                                                                                                                           |
| `session.json`                        | the workflows `tool`, `agent`, `attempt`, `heal`, `check` (generated)                                                                                                                         |
| `src/plan.ts`                         | the changes → stages, commands and free fixes                                                                                                                                                 |
| `src/heal/gen-session.ts`             | generate the workflows into `session.json`                                                                                                                                                    |
| `src/heal/heal.ts`                    | the script steps of heal and attempt, and the guard                                                                                                                                           |
| `src/heal/claude.ts`                  | the slim headless Claude launcher                                                                                                                                                             |
| `test/heal/claude.test.ts`            | offline test of the MCP access of the fixers and that a stage gets its fixer role                                                                                                             |
| `src/lib.ts`                          | server, session and watch helpers                                                                                                                                                             |
| `test/heal/heal.online.test.ts`       | the end-to-end test of check and heal against a fake claude (`YK_ONLINE=1`, `yk up` first; no API cost) and `test/heal/heal.test.ts` the offline tests of the guard and the no-progress check |
| `../../.claude/hooks/yk-hook.test.ts` | the Claude Code hooks                                                                                                                                                                         |
| `test/notify.test.ts`                 | offline test of `notify_session` (auth and user line to a stub socket, off switches, never fails), the message text and the `--notify` flag check                                             |
| `src/heal/gen-session.ts`             | the generator of the workflows in `session.json`                                                                                                                                              |
| `test/yk.online.test.ts`              | interrupt, detach and `--stages` of `yk` against the dev server (`YK_ONLINE=1`, no cost)                                                                                                      |
| `package.json`, `tsconfig.json`       | the Bun package of `src/` and `test/` (`bun test`)                                                                                                                                            |

### Tests

```bash
bun test            # offline: plan, heal steps, events, stats, notify, claude launcher, heal report
bun test             # offline: the ticket pipeline (body, filing, schemas, spec, steps, gate, ladder, the walked workflows)
yk tool -C .claude/hooks bun test                  # offline: the Claude Code hook (what is denied, what passes)
../../.github/scripts/plan-vs-ci.test.sh           # offline, also in CI: plan.ts and ci-tasks.sh pick the same modules
YK_ONLINE=1 bun test heal.online yk.online   # on the dev server (yk up): a stopped foreground yk stops its run, --detach outlives, --stages;
                                                   # check and heal against a fake claude (about a minute, no API cost)
```

`test/heal/heal.online.test.ts` runs the scenarios through the real `check` workflow: two failing stages healed one after the other, a no-change attempt that
ends the ladder, an escalation, and a failed verify that goes back to heal. The tests of the switched-off
pieces (issue, epic, nav, steer) are in git history.

### Format and type check

`bun fmt` formats (settings in `bunfig.toml` `[fmt]`, skips in `.prettierignore`: generated `session.json` and the prompt files); `bun check` type checks like TypeScript 7 whatever `typescript` is installed (`bun -p process.versions.typescript`). `yk check` runs both as the stages `dogfood.fmt` (free fix: `bun fmt`) and `dogfood.check` whenever anything under the repository root changes. Scripts: `bun run format`, `format:check`, `typecheck` (not named `fmt`: a project `fmt` script would replace `bun fmt`). Bun 1.4.4 has no `bun lint` yet (the docs at bun.com/docs/lint describe it), so there is no lint stage.
