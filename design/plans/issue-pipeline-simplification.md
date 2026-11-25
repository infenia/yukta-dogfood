# Issue pipeline simplification (ticket + pickup)

Status: **all questions answered 2026-11-25; ready to implement. No code changed.** Related: [workflow-optimization.md](workflow-optimization.md) (heal/check fixes), [ticket-pipeline.md](ticket-pipeline.md) (original design), [ticket-input-routing.md](ticket-input-routing.md).

## 1. What you asked for

1. **Plan first.** A planning session (you with a high-end model) produces a plan. When it is done, the plan is **converted into GitHub issues**. For a bug or small enhancement there is no planning session: you describe it in **plain text** and an agent turns it into one issue.
2. An agent works out the type (bug / enhancement / feature) and asks you only when the text does not settle it.
3. The **architect (opus)** writes, per issue, a plan detailed enough for cheap models: complexity, architecture, steps, tests, acceptance, security/SAST, out of scope. The detail should **leave no questions for execution**.
4. A **person reviews, edits and saves** the issue, then marks it Ready.
5. Issues are **run one at a time, on demand**: **sonnet implements**, **haiku writes the test code**, **sonnet reviews**. Goal: lowest cost without losing quality.
6. Any question during a run is answered in **Yukta's UI** (the Agents tab), or through REST, CLI or MCP. Assume multi-choice questions with tabs work in Yukta (a fix is coming).

## 2. What exists today (verified in code)

| You want                                 | Today                                                                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan → issues                            | Nothing. `yk ticket new` files one issue from flags (`--criterion`, `--file`, `--change`, ...).                                                                                          |
| Plain-text intake                        | No agent reads your text. `kindOf(title, labels)` in `lib.ts` is a title/label heuristic.                                                                                                |
| Complexity                               | `staticRoute`: criteria count (<=2 S, <=5 M, else L), raised by sizing.                                                                                                                  |
| Plan stored in the issue                 | **No.** The architect writes `spec.json` **inside the run** (`.yukta-dogfood/ticket/<run>/spec/`); only a summary is posted as a comment.                                                |
| Person reviews the plan before execution | Only high-risk specs (`spec approval` gate inside the run); the plan is not editable in the issue.                                                                                       |
| Role models                              | `modelTable` in `lib.ts`: implementer **haiku**, test_writer **sonnet**, reviewer opus/sonnet. Your split is the reverse for implementer and test_writer.                                |
| How roles run                            | Headless: `PROCESS_EXECUTOR` → `call.ts` → `src/heal/claude.ts`. Not `AGENT_SESSION`, so a role **does not appear in the Agents tab** today. Heal already moved to the `agent` workflow. |
| Questions                                | A role answers `NEEDS_CLARIFICATION`/BLOCKED → `ASK_INPUT` → advice supervisor → pickup session (channel + bridge) → a human.                                                            |
| Pickup                                   | 30-min scheduler handing Ready issues to an interactive Claude session (channel/MCP/bridge) or starting `yk ticket run`.                                                                 |

### Yukta's answer surfaces (verified in `../yukta` at `5fb0d86f3`)

| Surface                      | What shows there                                                                  | UI         | REST                                                                 | CLI (`yukta`)                                  | MCP                                                               |
| ---------------------------- | --------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| **Agents tab**               | `AGENT_SESSION` nodes: messages, tool calls, requests, a box to talk to the agent | yes (dock) | `/conversations/{id}/messages`, `/interrupt`, `/end`                 | `conversations list/show/send/attach/end`      | requests: yes, as input requests (`answer_input`); messages: none |
| **Inputs tab** (`ASK_INPUT`) | a structured question the workflow asks                                           | yes (dock) | `/executions/{e}/inputs/{r}/answer`, `/escalate`; `/agent/v1/inputs` | `inputs`, `inputs answer <e> <r> --decision D` | `list_pending_inputs`, `answer_input`, `escalate_input`           |

**Consequence for Q1 (verified in `plugins/processors/agent-session`):** yes. A role must run as `AGENT_SESSION` with the **interactive** claude-code preset (`--permission-prompt-tool stdio`) and `approvals: ASK`. Then every `can_use_tool` request from the agent becomes a Yukta **input request** (`AgentRequests`): the conversation shows it as a `REQUEST` event and is `WAITING` in the Agents tab, and it is answered from the UI, REST, the CLI (`inputs answer`) or MCP (`answer_input`). So no separate `ASK_INPUT` is needed for an agent's question. _Assumed, not yet run:_ that a question to the user (`AskUserQuestion`, multi-choice with tabs) takes the same path; you said to assume the coming Yukta fix. Consequences for the design:

- each role's normal tools are pre-allowed (`--allowedTools`) and out-of-policy tools denied, so only real questions reach a person (no approval flood); heal's `--permission-prompts none` must not carry over;
- the session must survive a long wait for an answer (the `timeout`/`approvalTimeout` behaviour while `WAITING` is to be checked before step 2);
- the channel/bridge/session machinery and the advice supervisor are not needed.

## 3. Proposed flow

```
planning session ─► plan file (design/plans/) ─► split ─┐
                                                       ├─► issue (Backlog) ─► you edit ─► Ready ─► run <n> ─► draft PR
plain text (bug / small) ─► analyst ─► architect ──────┘                                          test_writer (haiku)
                                    (opus)                                                         implementer (sonnet)
                                                                                                   gate (yk check)
                                                                                                   reviewer (sonnet)
```

**A1. From a plan (features, larger work).** The plan file in `design/plans/` is the output of the planning session. A split step (architect, opus) turns it into one issue per deliverable, each with the section body from section 4 and a link back to the plan file. Issues that depend on each other say so (`Depends on #n`), so you run them in order.

**A2. From plain text (bugs, small enhancements).** No plan file.

1. **Analyst** (sonnet low, small JSON output): `{type, confidence, title, questions[]}`. Low confidence or any question → asks you (Agents tab).
2. **Architect** (opus) reads the code and writes the issue sections. It runs `validate-spec` until `errors=0`.

In both cases the issue is created with project status **Backlog** (not Ready). Its Source section records the plan file (if any) and the base sha the spec was written against.

**B. Review (you).** Edit the issue in GitHub and move it to **Ready**. Nothing runs before that.

**C. Run (`yk ticket run <n>`, on demand, one at a time; no scheduler).**

1. Parse the issue sections back into `spec.json` (the issue is the source of truth). Re-run `validate-spec` against the current `origin/main`. If the spec no longer applies, stop and ask the architect to revise it; do not guess.
2. **Test writer** (haiku) writes the test code for the cases in the Tests section; the tests are **locked red** before implementation.
3. **Implementer** (sonnet) writes the code step by step until the locked tests pass. `yk check --no-heal` per step, the heal ladder on mechanical failures, tier-up on retry (all existing).
4. **Reviewer** (sonnet, short verdict JSON) checks the diff against the spec, the acceptance criteria and the tests. A blocker sends one step back; otherwise a draft PR `Fixes #n`.

**D. Questions** go to the Agents tab (see section 2); the run waits.

### Quality guard for the cheap test writer

Haiku writes the tests and they are then locked, so a weak test becomes a weak guard. To keep quality:

- The architect writes each test case **concretely**: id, file, input, expected result, and the reason. Haiku transcribes; it does not decide what to test.
- The gate checks each locked test **fails** before the implementation (red) and passes after it (existing locked-tests logic).
- The reviewer checks that the tests cover every acceptance criterion; a gap is a blocker.
- Tier-up for the test writer on failure: haiku → sonnet (same ladder as the implementer).

## 4. The issue body (what the architect fills)

| Section             | Content                                                                                                              | Used by                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Summary / Type      | one paragraph; `bug` / `enhancement` / `feature` / `refactor` / `docs` / `chore`; link to the plan file if any       | router, PR title                 |
| Complexity / Risk   | S/M/L, low/medium/high with the reason                                                                               | model table, budget              |
| Acceptance criteria | the only requirements                                                                                                | reviewer, intake block-list      |
| Architecture        | files/modules touched, new types, dependencies, what must not change                                                 | implementer scope, `scope-check` |
| Steps               | ordered, each with `write_files`, `done_when`, and an instruction detailed enough for sonnet                         | implementer                      |
| Tests               | cases (id, file, input, expected, reason), mode (`repro_only` for bugs, ...)                                         | test writer, gate, reviewer      |
| Security / SAST     | what the change exposes; which of `security`, `licenses`, spotbugs, opengrep/trivy matter; input handling            | reviewer, you                    |
| Decisions           | every choice the implementer might otherwise ask about, already made                                                 | implementer (fewer questions)    |
| Out of scope        | explicit exclusions                                                                                                  | reviewer                         |
| Models              | `architect`, `test_writer`, `implementer`, `reviewer` as `model/effort` (default from section 7, override per issue) | router                           |

The **Decisions** section is new and is the main lever for "no questions during execution": the architect lists open choices and settles them, and `validate-spec` fails on an empty Decisions section when the issue has open decisions in Sizing.

## 5. What to delete (decided: drop unused flows)

| Delete                                                              | Why                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `channel/`, `src/input-bridge.ts`, `yk pickup session`, `VIA` modes | questions go to the Agents tab / `ASK_INPUT`                      |
| `pickup` workflow and the 30-min schedule                           | runs are on demand only (Q2)                                      |
| `advice.ts`, `ticket-advice` supervisor (`supervisor/session.json`) | it recommends answers the Agents tab shows anyway                 |
| `waves.ts`, `warm-wait`, `SPLITTER`/`AGGREGATE` in `gen-ticket.ts`  | parallel steps; never used in a real run; serial steps are enough |
| `mutation` (pitest) step                                            | reviewer finding only, never fails a run, costs a Gradle run      |
| spec approval **inside** the run                                    | replaced by your review of the issue before Ready                 |
| `implementer_tricky` role                                           | replaced by the tier-up ladder (sonnet → opus)                    |

Kept: `validate-spec`, the step gate (`yk check`), `ladder`, heal inside a step, locked tests, `branch.ts`, `github.ts`, schemas and fixtures. Each deletion is confirmed with `grep` for callers before removal; CLAUDE.md, README.md and ARCHITECTURE.md are updated in the same change.

## 6. Naming (Q5: decided)

Rule: **one word per concept, and no word that already means something else in this repo.** Checked against `src/`, `test/`, the mod and the plan's own text.

| Word                | Means only                                                                                                                                           | Not used for                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **plan**            | the planning-session document in `design/plans/`                                                                                                     | the issue's content (that is the spec); `src/plan.ts` (check scoping) keeps its meaning |
| **ticket**          | a GitHub issue written for the pipeline, and the pipeline (`yk ticket`)                                                                              | the run                                                                                 |
| **spec**            | what the architect writes: the ticket body's sections ⇄ `spec.json`                                                                                  | -                                                                                       |
| **run**             | one execution of one ticket                                                                                                                          | -                                                                                       |
| **Backlog / Ready** | the ticket's project Status before / after your review (verified on project 5: Triage, Backlog, Ready, In progress, In review, Ready to merge, Done) | "Draft", which stays the PR's state only                                                |

| Today                                  | New                                            | Meaning                                                     |
| -------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| -                                      | `yk ticket from-plan <plan-file>`              | a plan → tickets in Backlog (A1)                            |
| `yk ticket new <title> --criterion ..` | `yk ticket new "<text>"`                       | plain text → analyst → architect → a ticket in Backlog (A2) |
| `yk ticket run <n>`                    | unchanged                                      | run one Ready ticket (C)                                    |
| `yk ticket status`, `report`           | unchanged                                      |                                                             |
| workflow `ticket`                      | `ticket-new`, `ticket-from-plan`, `ticket-run` | one workflow per command, named after it                    |
| `run-issue` in `yk stats`              | `ticket-run`                                   | same as the workflow                                        |
| `attempt_round` / `steps_round`        | `round` / `round_steps`                        | heal keeps `attempt`; no `round` exists elsewhere           |
| routing `kind`                         | `type`                                         | the board's `Kind` field means something else               |
| `escalate`                             | `revise`                                       | matches `revision-request` / `revision-result`              |
| `claude` group / `call.ts` launcher    | `agent` (the `agent` workflow)                 | one launcher for heal and ticket                            |
| `implementer_tricky`                   | removed (tier-up ladder)                       |                                                             |
| `pickup`, `yk pickup *`, `VIA` modes   | removed                                        |                                                             |
| -                                      | `ticket-body` (schema), `src/ticket/body.ts`   | the ticket body ⇄ TicketBody ⇄ `spec.json`                  |

Roles: `analyst`, `architect`, `test_writer`, `implementer`, `reviewer`.

## 7. Models and token economics

| Role        | Default         | Tier-up on failure | Output size                |
| ----------- | --------------- | ------------------ | -------------------------- |
| analyst     | sonnet / low    | -                  | small JSON                 |
| architect   | opus / high     | -                  | the spec (once per ticket) |
| test_writer | haiku / medium  | sonnet             | test code                  |
| implementer | sonnet / medium | opus               | code (the bulk)            |
| reviewer    | sonnet / medium | -                  | short verdict JSON         |

- Opus writes only the spec. Input (reading code) is mostly cache reads.
- This replaces `modelTable`'s complexity × risk matrix with one default table plus a per-issue override in the Models section. For an S/low bug the architect may drop to sonnet; decide after real runs.
- The trade-off: a thinner spec costs less opus output but raises sonnet's BLOCKED and retry rate. Metric: `yk ticket report` (first-try pass rate, BLOCKED rate; above 15% BLOCKED means the spec is too thin). Plan for 10 to 20 real issues before tuning.
- **Plan drift**: base sha in the issue plus re-validation at run start.
- Fix H7 in workflow-optimization.md (guard-rejected edits staying in the tree) before unattended runs.

## 8. Answers

- **Q1.** Use the Agents tab; answers may also come through REST, CLI or MCP. Assume multi-choice questions with tabs work. Keep execution questions rare by writing the plan in detail (section 4, Decisions). Today's constraint: see section 2.
- **Q2.** No scheduler; `yk ticket run <n>` on demand, one issue at a time.
- **Q3.** Keep a separate test writer: opus designs, sonnet implements, **haiku writes test code**, sonnet reviews.
- **Q4.** Drop the unused flows (section 5).
- **Q5.** `issue`/`dispatch` rejected; keep `ticket` with `split`/`new`/`run` and workflows `ticket-plan`/`ticket-run` (section 6).
- **Q6.** The plan lives in the GitHub issue body. When the issue comes from a planning session, the plan file also stays in `design/plans/`. Bugs and small enhancements have no plan file.

## 9. Work breakdown

Order changed: the deletions ran before the launcher change, so fewer role call sites have to move.

1. **Done** (`e16cd5f`): `schemas/ticket-body.schema.json` + fixtures, `src/ticket/body.ts` (`renderTicket`, `parseTicket`, `specOf`), `test/ticket/body.test.ts`.
2. **Done** (`ac3373b`): removed pickup, `channel/`, `input-bridge.ts`, ticket-advice (`saveGuard` deletes a stale one); CI drops `test (channel)`; `YUKTA_PICKUP_*` → `YUKTA_TICKET_*`.
3. **Done** (`383a36e`): serial steps (`flow next-step`), no waves, no mutation, no spec approval or merge gate in the run.
4. **Next: roles as `AGENT_SESSION`.** Check first: (a) what `timeout`/`approvalTimeout`/`idleTimeout` do while the conversation is `WAITING` on a person (if the session is killed, use stop + `ASK_INPUT` + resume instead); (b) how the offline tests keep a fake claude (`YK_CLAUDE_BIN`) once roles run on the server; (c) whether AGENT_SESSION `args`/`approvals` take `${start.*}` (one parameterized `agent` workflow) or a ticket variant is needed. Shape: a PE that writes prompt/rules/schema/MCP files → `SUB_WORKFLOW agent` → a PE that validates the answer and routes retries (split `call.ts` in two). Pre-allow each role's tools; deny the rest; no `--permission-prompts none`.
5. Filing: `yk ticket new "<text>"` (analyst + architect → ticket in Backlog) and `yk ticket from-plan <plan-file>`; the `analysis` schema; replace `roles.ts` `renderBody` and `ticket-template.md`.
6. Run reads the ticket body (`parseTicket` → `specOf`) instead of running the architect; re-validate on the current base; new default model table (section 7), tier-up replaces `implementer_tricky` (drop it from `ticket-body.schema.json` and fixtures in the same commit).
7. Renames of section 6 (`ticket-new`/`ticket-from-plan`/`ticket-run`, `round`, `revise`, `type`) in one mechanical commit.
8. Docs: `README.md` and `ARCHITECTURE.md` still describe pickup, waves, mutation and the approvals; rewrite §10/§11 and the `yk stats`/`report` names.
