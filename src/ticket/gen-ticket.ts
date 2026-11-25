// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// Writes the workflows of the ticket pipeline into session.json (design 6.1 to 6.3, 9, 15.3, 15.5), the way
// dogfood/src/gen-heal.ts does. `yk ticket` adds them to the `dogfood` session, so they call its `tool` workflow.
//
//   ticket-run    issue -> intake -> init -> claim -> route -> [the spec of the issue body, else the architect] (validate-spec, 2 retries; policy conflicts ask a person) -> test writer -> gate-tests (blocked or red-check failures retry the architect)
//                 -> plan comment -> round, recovered up to 3 times (a revision: `revise`; a pause: a human packet and an ASK_INPUT)
//                 -> finish (draft PR) -> close
//   round         round_steps -> finalize
//   round_steps   the next step whose depends_on are DONE, one `step` run each, in order (8 slots)
//   step          one step, up to 4 attempts: begin -> implementer -> validate-step; a failure goes to `ladder decide`: retry, tier_up (one model tier up),
//                 heal (yk check --stage <stage> heals, then everything outside write_files is reverted), baseline (the stage also fails on origin/main),
//                 or an escalation (revise, human, pause: escalation.json)
//   finalize      full checks -> reviewer -> verdict (a blocker or an unfaithful test overrides APPROVE)
//   revise        RevisionRequest -> architect revision -> spec v+1 -> validate-spec -> test writer (changed cases) -> gate-tests
//
// Every node is a PROCESS_EXECUTOR running `ticketkit` (no Java); a Claude call is `ticketkit call ROLE`, which runs the claude command with --role ROLE. Claude calls
// share the `agent` concurrency group; Gradle runs inside `yk check`, which queues in the `tool` group.
//
//   bun src/ticket/gen-ticket.ts          write ticket-session.json        bun src/ticket/gen-ticket.ts --check   exit 1 when the committed ticket-session.json is stale (CI-style)
// Edit this file, run it, commit ticket-session.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { KIT, type Json, dumps, join } from './lib.ts'

const PATH = process.env.TICKET_SESSION || join(KIT, 'ticket-session.json')
const CMD = ['bun', '__TICKET__/src/ticket/ticketkit.ts']
const S = (k: string): string => `\${start.${k}}`
const RUN = S('run')
const W = ['--worktree', S('worktree')]
const START_KEYS = [
  'project',
  'run',
  'worktree',
  'claudeBin',
  'gateStep',
  'gateFinal',
  'stateDir',
  'healCmd',
  'baselineCmd',
  'runId',
  'events',
]

type Edge = { source: string; target: string; sourcePort?: string }
const edges = (src: string, dst: string, ...ports: string[]): Edge[] =>
  ports.length ? ports.map((p) => ({ source: src, target: dst, sourcePort: p })) : [{ source: src, target: dst }]

function pe(
  nodeId: string,
  args: string[],
  timeout = 300,
  o: { json?: boolean; claude?: boolean; routed?: boolean; stdin?: boolean } = {},
): Json {
  const env = {
    YK_CLAUDE_BIN: S('claudeBin'),
    TICKET_GATE_STEP: S('gateStep'),
    TICKET_GATE_FINAL: S('gateFinal'),
    YUKTA_DEV_STATE_DIR: S('stateDir'),
    TICKET_HEAL_CMD: S('healCmd'),
    TICKET_BASELINE_CMD: S('baselineCmd'),
  }
  const cfg: Json = { command: [...CMD, ...args], workingDir: S('project'), env, timeout, timeoutSeconds: timeout, failureMode: 'CONTINUE' }
  if (o.routed ?? true) cfg.routeByExitCode = true
  if (o.stdin) cfg.inputMode = 'STDIN' // the message as JSON on stdin (a sub-workflow's results)
  if (o.json) cfg.outputFormat = 'JSON'
  if (o.claude) cfg.engine = { concurrencyGroup: 'agent' }
  return { nodeId, type: 'PROCESS_EXECUTOR', config: cfg }
}

const terminal = (nodeId: string, reason: string): Json => ({ nodeId, type: 'OUTCOME_TERMINAL', config: { outcome: 'FAILED', reason } })
const ok = (nodeId = 'ok'): Json => ({ nodeId, type: 'CONSOLE_TERMINAL', config: { displayOutput: true } })
const select = (nodeId: string, key: string, cases: Json, def: string): Json => ({
  nodeId,
  type: 'BRANCH',
  config: { mode: 'SELECT_KEY', selector: `payload['output']['${key}']`, cases, defaultPort: def },
})
// every question of a run goes on the route `ticket` and says which issue and run it is about (design/plans/ticket-input-routing.md 3.5)
const ask = (nodeId: string, prompt: string, ttl = 86400, kind = 'APPROVAL', risk = 'HIGH', issue = S('issue')): Json => ({
  nodeId,
  type: 'ASK_INPUT',
  config: {
    prompt,
    kind,
    risk,
    ttlSeconds: ttl,
    onTimeout: 'FAIL',
    route: 'ticket',
    context: { issue, run_id: S('runId'), gate: nodeId },
  },
})
const rejected = (nodeId: string): Json => ({
  nodeId,
  type: 'BRANCH',
  config: { mode: 'EXPRESSION', cases: { "metadata['input.decision'] == 'reject'": 'reject' }, defaultPort: 'approve' },
})

function sub(nodeId: string, wf: string, extra: Record<string, string> = {}, concurrency?: number): Json {
  const payload: Json = {}
  for (const k of START_KEYS) if (!(k in extra)) payload[k] = S(k)
  Object.assign(payload, extra)
  const cfg: Json = { workflowId: wf, timeoutSeconds: 21600, routeByOutcome: true, payload }
  if (concurrency) cfg.concurrency = concurrency
  return { nodeId, type: 'SUB_WORKFLOW', config: cfg }
}

/** The issue goes back to Ready with a comment (design 15.9 step 7); best effort, the run ends FAILED at <node_id>.failed either way. */
const deadEnd = (nodeId: string, why: string): Json =>
  pe(nodeId + '.dead', ['github', 'dead-end', RUN, '--stage', nodeId, '--reason', why, ...W], 120, { routed: false })

/** Collects nodes and edges; fail(node, why, dead) wires a node's failure port to a terminal (through a dead-end when asked). */
class G {
  nodes: Json[] = []
  edges: Edge[] = []
  add(...nodes: Json[]): void {
    this.nodes.push(...nodes)
  }
  link(src: string, dst: string, ...ports: string[]): void {
    this.edges.push(...edges(src, dst, ...ports))
  }
  fail(nid: string, why: string, dead = false, port = 'failure'): void {
    this.nodes.push(terminal(nid + '.failed', why))
    if (dead) {
      this.nodes.push(deadEnd(nid, why))
      this.link(nid, nid + '.dead', port)
      this.link(nid + '.dead', nid + '.failed')
    } else this.link(nid, nid + '.failed', port)
  }
  /** items: [(node, failure_reason)]; each success goes to the next node, the last to `last`. */
  chain(items: [Json, string][], last: string, dead = false): void {
    items.forEach(([n, why], k) => {
      this.add(n)
      this.link(n.nodeId, k + 1 < items.length ? items[k + 1]![0].nodeId : last, 'success')
      this.fail(n.nodeId, why, dead)
    })
  }
  workflow(id: string, description: string): Json {
    return {
      workflowId: id,
      description,
      nodes: [{ nodeId: 'trigger', type: 'CONSTANT_SOURCE', config: {} }, ...this.nodes],
      edges: this.edges,
    }
  }
}

// ---------------------------------------------------------------- step: up to 4 attempts (3, +1 after a revision)
const ATTEMPTS = 4
const st = new G()
st.add(terminal('escalate', 'escalate: the step needs a revision, a human or a pause (escalation.json says which)'), ok('ok'))
st.add(pe('commit', ['flow', 'commit-step', RUN, S('step'), ...W], 120))
st.link('commit', 'ok', 'success')
st.fail('commit', 'the step could not be committed')
for (let k = 1; k <= ATTEMPTS; k++) {
  const [b, im, rs, va, de, ac] = ['begin', 'implement', 'result', 'validate', 'decide', 'action'].map((n) => `${n}${k}`) as [
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  st.add(pe(b, ['flow', 'step-begin', RUN, S('step'), '--attempt', 'next', ...W], 300))
  st.add(pe(im, ['call', 'implementer', RUN, '--step', S('step'), '--attempt', 'cur', ...W], 2400, { json: true, claude: true }))
  st.add(select(rs, 'status', { DONE: 'done' }, 'blocked'))
  st.add(pe(va, ['flow', 'validate-step', RUN, S('step'), '--attempt', 'cur', ...W], 3700))
  st.add(pe(de, ['ladder', 'decide', RUN, S('step'), ...W], 120, { json: true }))
  st.add(select(ac, 'action', { retry: 'go', tier_up: 'go', heal: 'heal', baseline: 'baseline' }, 'escalate'))
  st.link(b, im, 'success')
  st.fail(b, 'the step base or packet failed')
  st.link(im, rs, 'success')
  st.fail(im, 'the implementer call failed (the ERROR line says which: schema_invalid, api_error, limit)')
  st.link(rs, va, 'done')
  st.link(rs, de, 'blocked')
  st.link(va, 'commit', 'success')
  st.link(va, de, 'failure')
  st.link(de, ac, 'success')
  st.fail(de, 'the ladder could not decide')
  st.link(ac, k < ATTEMPTS ? `begin${k + 1}` : 'escalate', 'go')
  st.link(ac, 'commit', 'baseline')
  st.link(ac, 'escalate', 'escalate')
  // heal: yk check heals the stage, anything outside write_files is reverted, the step is validated again; still failing -> escalation
  const [h, vh, dh] = [`heal${k}`, `validate_heal${k}`, `decide_heal${k}`] as [string, string, string]
  st.add(pe(h, ['ladder', 'heal', RUN, S('step'), ...W], 3700, { json: true }))
  st.add(pe(vh, ['flow', 'validate-step', RUN, S('step'), '--attempt', 'cur', ...W], 3700))
  st.add(pe(dh, ['ladder', 'decide', RUN, S('step'), '--after-heal', ...W], 120, { json: true }))
  st.link(ac, h, 'heal')
  st.link(h, vh, 'success')
  st.fail(h, 'heal could not run')
  st.link(vh, 'commit', 'success')
  st.link(vh, dh, 'failure')
  st.link(dh, 'escalate', 'success')
  st.fail(dh, 'the ladder could not decide')
}
const STEP_WF = st.workflow(
  'step',
  'One step of a ticket: up to four attempts with the retry ladder, heal for mechanical failures, escalation.',
)
STEP_WF.edges.push(...edges('trigger', 'begin1'))

// ---------------------------------------------------------------- round_steps: step after step (8 slots, the sizing lint caps a spec at 8 steps)
const SLOTS = 8
const sr = new G()
sr.add(ok('ok'))
for (let k = 1; k <= SLOTS; k++) {
  const [nx, more, run] = [`next${k}`, `more${k}`, `run${k}`] as [string, string, string]
  sr.add(
    pe(nx, ['flow', 'next-step', RUN], 60, { json: true }),
    select(more, 'more', { true: 'step' }, 'none'),
    sub(run, 'step', { step: '${payload.output.step}' }),
  )
  sr.link(nx, more, 'success')
  sr.fail(nx, 'next-step failed')
  sr.link(more, run, 'step')
  sr.link(more, 'ok', 'none')
  sr.link(run, k < SLOTS ? `next${k + 1}` : 'ok', 'success')
  sr.fail(run, 'a step ended without DONE (escalation.json says what to do)')
}
const STEPS_WF = sr.workflow('round_steps', 'Run the ready steps one at a time, in order.')
STEPS_WF.edges.push(...edges('trigger', 'next1'))

// ---------------------------------------------------------------- finalize: full checks, reviewer, verdict
const fz = new G()
fz.add(
  ok('ok'),
  terminal('changes.failed', 'the reviewer requested changes (escalation.json)'),
  terminal('full_checks.failed', 'the final gate failed'),
)
fz.add(pe('full_checks', ['flow', 'full-checks', RUN, ...W], 3700), pe('final_fail', ['ladder', 'final-fail', RUN], 60, { routed: false }))
fz.link('full_checks', 'review', 'success')
fz.link('full_checks', 'final_fail', 'failure')
fz.link('final_fail', 'full_checks.failed')
fz.add(pe('review', ['call', 'reviewer', RUN, '--step', 'S1', ...W], 2400, { json: true, claude: true }))
fz.fail('review', 'the reviewer failed')
fz.link('review', 'verdict', 'success')
fz.add(
  pe('verdict', ['ladder', 'review-verdict', RUN], 60, { json: true }),
  select('verdict?', 'verdict', { APPROVE: 'approved' }, 'changes'),
)
fz.link('verdict', 'verdict?', 'success')
fz.fail('verdict', 'the verdict could not be computed')
fz.link('verdict?', 'ok', 'approved')
fz.link('verdict?', 'changes.failed', 'changes')
const FINAL_WF = fz.workflow('finalize', 'The final gate, the fresh-context reviewer and a verdict code can override.')
FINAL_WF.edges.push(...edges('trigger', 'full_checks'))

// ---------------------------------------------------------------- round: the steps, then the finish line
const ar = new G()
ar.add(sub('steps', 'round_steps'), sub('finalize', 'finalize'), ok('ok'))
ar.link('steps', 'finalize', 'success')
ar.fail('steps', 'a step did not finish')
ar.link('finalize', 'ok', 'success')
ar.fail('finalize', 'the final gate or the review did not pass')
const ROUND_WF = ar.workflow('round', 'All steps, the final gate and the review.')
ROUND_WF.edges.push(...edges('trigger', 'steps'))

// ---------------------------------------------------------------- revise: the architect revises the spec (design 6.3)
const es = new G()
es.add(ok('ok'))
es.chain(
  [
    [pe('build_revision', ['ladder', 'build-revision', RUN], 60), 'the revision request could not be built'],
    [
      pe('architect_revise', ['call', 'architect_revise', RUN, ...W], 2400, { json: true, claude: true }),
      "the architect's revision call failed (the ERROR line says which: schema_invalid, api_error, limit)",
    ],
    [pe('apply_revision', ['ladder', 'apply-revision', RUN], 60), 'the revision touches completed steps or is not applicable'],
    [pe('validate_spec', ['validate-spec', RUN, ...W], 300), 'the revised spec is not valid'],
    [
      pe('test_writer', ['call', 'test_writer', RUN, ...W], 2400, { json: true, claude: true }),
      'the test writer was blocked or failed on the changed cases (the ERROR line says which: blocked, schema_invalid, api_error, limit)',
    ],
    [pe('gate_tests', ['gate-tests', RUN, ...W], 3700), 'the changed tests did not pass the red check'],
    [pe('commit_tests', ['flow', 'commit-tests', RUN, ...W], 120), 'the tests could not be committed'],
  ],
  'ok',
)
const ESC_WF = es.workflow('revise', 'Architect revision: spec v+1, changed cases through the test writer and the gate.')
ESC_WF.edges.push(...edges('trigger', 'build_revision'))

// ---------------------------------------------------------------- ticket
const t = new G()
t.add(ok('done'))
t.chain(
  [
    [
      pe('intake', ['github', 'intake', S('issue')], 120),
      'the issue is not eligible (not open, assigned to you and Ready, or no acceptance criteria) or asks for something forbidden',
    ],
  ],
  'init',
)
t.chain(
  [
    [
      pe('init', ['init', S('issue'), '--run-id', S('runId'), '--root', S('project')], 300),
      'init failed or the issue is skipped (the branch or worktree exists)',
    ],
    [pe('claim', ['github', 'claim', S('issue')], 120), 'the issue could not be moved to In progress'],
  ],
  'route',
)
t.chain([[pe('route', ['route', RUN], 120), 'route failed']], 'has_spec', true) // complexity and risk come from the ticket's own criteria, labels and paths
// a spec filed in the issue is validated on the current base; one that no longer applies goes to the architect with the errors (the re-plan)
t.add(pe('has_spec', ['flow', 'has-spec', RUN], 60))
t.link('has_spec', 'validate_spec1', 'success')
t.link('has_spec', 'architect1', 'failure')
// the architect, with validate-spec errors and the test stage's feedback fed back, twice at most
const ARCH_FAIL =
  'the architect call failed (the ERROR line says which: schema_invalid, api_error, limit) or did not ask; a spec the validator rejects is retried, not this'
for (const k of [1, 2, 3]) {
  t.add(
    pe(`architect${k}`, ['call', 'architect', RUN, ...W], 2400, { json: true, claude: true }),
    pe(`validate_spec${k}`, ['validate-spec', RUN, ...W], 300),
  )
  t.link(`architect${k}`, `validate_spec${k}`, 'success')
  if (k < 3) {
    // a NEEDS_CLARIFICATION answer (exit 2) asks one multi-question request; the answers go into the next architect attempt
    const [c, cs, ca, cr, cp] = [`clarify${k}`, `clarify_ask${k}?`, `ask_clarify${k}`, `clarify_decision${k}?`, `apply_clarify${k}`]
    t.add(
      pe(c, ['ladder', 'clarification', RUN], 60, { json: true }),
      select(cs, 'ask', { true: 'ask' }, 'fail'),
      ask(ca, '${payload.output.prompt}', 86400, 'TEXT', 'MEDIUM'),
      rejected(cr),
      terminal(`clarify_rejected${k}`, 'a person declined to answer the architect'),
      pe(cp, ['ladder', 'apply-clarification', RUN, '${metadata.input.text}'], 60),
      deadEnd(`architect${k}`, ARCH_FAIL),
      terminal(`architect${k}.failed`, ARCH_FAIL),
    )
    t.link(`architect${k}`, c, 'failure')
    t.link(c, cs, 'success')
    t.fail(c, 'the clarification could not be read', true)
    t.link(cs, ca, 'ask')
    t.link(cs, `architect${k}.dead`, 'fail')
    t.link(`architect${k}.dead`, `architect${k}.failed`)
    t.link(ca, cr)
    t.link(cr, `clarify_rejected${k}`, 'reject')
    t.link(cr, cp, 'approve')
    t.link(cp, `architect${k + 1}`, 'success')
    t.fail(cp, 'the answers could not be recorded', true)
  } else t.fail(`architect${k}`, ARCH_FAIL, true)
  // the test writer and the red check of this spec; blocked tests or a failed gate send the reason back to the next architect attempt
  const [tw, gt] = [`test_writer${k}`, `gate_tests${k}`]
  t.add(pe(tw, ['call', 'test_writer', RUN, ...W], 2400, { json: true, claude: true }), pe(gt, ['gate-tests', RUN, ...W], 3700))
  t.link(`validate_spec${k}`, tw, 'success')
  t.link(tw, gt, 'success')
  t.link(gt, 'commit_tests', 'success')
  if (k < 3) {
    // a policy conflict (validate-spec wrote needs-clarification.json) is a question to a person; any other error is the next attempt's
    const [sc, scs] = [`spec_conflict${k}`, `spec_conflict_ask${k}?`]
    t.add(pe(sc, ['ladder', 'clarification', RUN], 60, { json: true }), select(scs, 'ask', { true: 'ask' }, 'retry'))
    t.link(`validate_spec${k}`, sc, 'failure')
    t.link(sc, scs, 'success')
    t.fail(sc, 'the clarification could not be read', true)
    t.link(scs, `ask_clarify${k}`, 'ask')
    t.link(scs, `architect${k + 1}`, 'retry')
    const rs = `retry_spec${k}`
    t.add(pe(rs, ['flow', 'retry-spec', RUN, ...W], 120))
    t.link(tw, rs, 'failure')
    t.link(gt, rs, 'failure')
    t.link(rs, `architect${k + 1}`, 'success')
    t.fail(
      rs,
      'the test gate could not run for an environment reason (spec/gate.json: missing packages, no such command), or the worktree could not be reset',
      true,
    )
  } else {
    t.fail('validate_spec3', 'the spec is still invalid after two retries (spec/validation.json)', true)
    t.fail(
      tw,
      'the test writer was blocked or failed on the third spec (the ERROR line says which: blocked, schema_invalid, api_error, limit)',
      true,
    )
    t.fail(gt, 'the tests of the third spec did not pass the red check (spec/gate.json)', true)
  }
}
t.chain([[pe('commit_tests', ['flow', 'commit-tests', RUN, ...W], 120), 'the tests could not be committed']], 'plan_comment', true)
t.chain([[pe('plan_comment', ['github', 'plan-comment', RUN], 120), 'the plan could not be posted on the issue']], 'round1', true)
// rounds: a failed round is recovered by a revision or a pause, 3 times
const ROUNDS = 4
for (let k = 1; k <= ROUNDS; k++) {
  const [r, rf] = [`round${k}`, `route_failure${k}`]
  t.add(sub(r, 'round'))
  t.link(r, 'finish', 'success')
  if (k === ROUNDS) {
    t.fail(r, 'the run did not finish after three recoveries', true)
    continue
  }
  t.link(r, rf, 'failure')
  const [a, e, pp, aa, ap, ack] = [
    `action${k}`,
    `revise${k}`,
    `pause_packet${k}`,
    `ask_pause${k}`,
    `pause_decision${k}`,
    `ack_pause${k}`,
  ] as [string, string, string, string, string, string]
  t.add(
    pe(rf, ['ladder', 'route-failure', RUN], 60, { json: true }),
    select(a, 'action', { revise: 'revise', pause: 'pause' }, 'human'),
    sub(e, 'revise'),
    pe(pp, ['ladder', 'pause-packet', RUN], 60),
    ask(aa, 'Run ${start.runId} is paused over a budget; human-packet.md is in ${start.run}. Approve to continue with doubled budgets.'),
    rejected(ap),
    pe(ack, ['ladder', 'ack-pause', RUN, '${metadata.input.text}'], 60),
    terminal(`paused_rejected${k}`, 'a person stopped the paused run'),
  )
  t.link(rf, a, 'success')
  t.fail(rf, 'the failure could not be routed', true)
  t.link(a, e, 'revise')
  t.link(a, pp, 'pause')
  t.link(a, `human${k}`, 'human')
  t.add(
    pe(`human${k}`, ['github', 'dead-end', RUN, '--stage', `round${k}`, '--reason', 'a person is needed (escalation.json)'], 120, {
      routed: false,
    }),
    terminal(`human${k}.failed`, 'a person is needed (licenses, security, a second infra error or the revision budget)'),
  )
  t.link(`human${k}`, `human${k}.failed`)
  t.link(e, `round${k + 1}`, 'success')
  t.fail(e, "the architect's revision did not produce a valid spec", true)
  t.link(pp, aa, 'success')
  t.fail(pp, 'the human packet could not be written')
  t.link(aa, ap)
  t.link(ap, `paused_rejected${k}`, 'reject')
  t.link(ap, ack, 'approve')
  t.link(ack, `round${k + 1}`, 'success')
  t.fail(ack, 'the pause could not be acknowledged')
}
// the draft PR: a person reviews it, nothing is merged
t.chain(
  [
    [pe('finish', ['github', 'finish', RUN, ...W], 600), 'the draft PR could not be opened'],
    [pe('close', ['flow', 'close', RUN, '--events', S('events')], 60), 'close failed'],
  ],
  'done',
)
t.edges.push(...edges('trigger', 'intake'))
const TICKET_WF = t.workflow(
  'ticket-run',
  'Implement one Ready GitHub issue end to end: architect spec, locked failing tests, step-by-step implementation (retry ladder, heal, escalation), fresh reviewer. Ends with a draft PR (Fixes #<issue>), never merges. Start with `yk ticket run <issue>`.',
)

// ---------------------------------------------------------------- filing: yk ticket new "<text>" and yk ticket from-plan <plan>
// ticket-agent: one Claude Code session on AGENT_SESSION. approvals ASK: a tool use outside the pre-allowed ones (and AskUserQuestion) becomes an input
// request that a person answers in the UI (Agents tab), over REST, the CLI or MCP; the session waits for it up to 24 h (timeout: work time + 24 h).
const FILING_WAIT = 86400
const AGENT_WF: Json = {
  workflowId: 'ticket-agent',
  description: 'One filing session (analyst or architect) on AGENT_SESSION; its questions go to a person through the input requests.',
  nodes: [
    { nodeId: 'trigger', type: 'CONSTANT_SOURCE', config: { variables: { prompt: S('prompt') } } },
    {
      nodeId: 'agent',
      type: 'AGENT_SESSION',
      config: {
        harness: 'claude-code',
        mode: 'TASK',
        prompt: '${payload.prompt}',
        model: S('model'),
        workingDir: S('project'),
        approvals: 'ASK',
        approvalRisk: 'MEDIUM',
        approvalTimeout: FILING_WAIT,
        timeout: 3600 + FILING_WAIT,
        args: [
          ...['--setting-sources', 'project', '--disable-slash-commands', '--no-session-persistence'],
          ...['--tools', 'Read,Grep,Glob,Bash,Write,AskUserQuestion'],
          ...['--allowedTools', 'Read', 'Grep', 'Glob', S('allowWrite'), S('allowBash')],
          ...['--disallowedTools', 'Edit', 'Bash(git commit:*)', 'Bash(git push:*)'],
          ...[
            '--append-system-prompt-file',
            S('rulesFile'),
            '--max-budget-usd',
            S('budget'),
            '--effort',
            S('effort'),
            '--json-schema',
            S('schema'),
          ],
        ],
        env: {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
        },
        engine: { concurrencyGroup: 'agent' },
      },
    },
    ok('ok'),
    { nodeId: 'failed', type: 'CONSOLE_TERMINAL', config: {} },
    { nodeId: 'early', type: 'CONSOLE_TERMINAL', config: {} },
  ],
  edges: [
    ...edges('trigger', 'agent'),
    ...edges('agent', 'ok', 'success'),
    ...edges('agent', 'failed', 'failure'),
    ...edges('agent', 'early', 'incomplete'),
  ],
}
const DIR = S('dir')
/** A call of ticket-agent: the session may wait a day for a person, and an error routes to the answer like a failure. */
const agentCall = (nodeId: string, payload: Record<string, string>): Json => {
  const n = sub(nodeId, 'ticket-agent', payload)
  n.config = { ...n.config, timeoutSeconds: 3600 + FILING_WAIT + 600, engine: { onError: 'ROUTE' } }
  return n
}
/** prepare ROLE -> ticket-agent -> answer ROLE (every port of the session goes to the answer, which says what went wrong). */
function session(g: G, role: string, next: string): void {
  const [p, a, r] = [`prepare_${role}`, role, `answer_${role}`]
  g.add(
    pe(p, ['file', 'prepare', role, DIR], 120, { json: true }),
    agentCall(a, {
      prompt: '${payload.output.prompt}',
      project: S('project'),
      model: '${payload.output.model}',
      effort: '${payload.output.effort}',
      budget: '${payload.output.budget}',
      schema: '${payload.output.schema}',
      rulesFile: '${payload.output.rules}',
      allowWrite: '${payload.output.allowWrite}',
      allowBash: '${payload.output.allowBash}',
    }),
    pe(r, ['file', 'answer', role, DIR], 300, { json: true, stdin: true }),
  )
  g.link(p, a, 'success')
  g.fail(p, `the ${role} prompt could not be written`)
  g.link(a, r, 'success', 'failure', 'error')
  g.link(r, next, 'success')
  g.fail(r, `the ${role} did not give a valid answer (the ERROR line says why)`)
}
const fileNode = (g: G): void => {
  g.add(pe('file_issues', ['file', 'issue', DIR], 600), ok('done'))
  g.link('file_issues', 'done', 'success')
  g.fail('file_issues', 'the issues could not be filed')
}
// ticket-new: analyst -> [the open questions to a person] -> architect -> issue in Backlog
const tn = new G()
session(tn, 'analyst', 'ask?')
tn.add(
  select('ask?', 'ask', { true: 'ask' }, 'plan'),
  ask('ask_analyst', '${payload.output.prompt}', FILING_WAIT, 'TEXT', 'MEDIUM', 'new'),
  pe('save_answers', ['file', 'answers', DIR, '${metadata.input.text}'], 60),
)
tn.link('ask?', 'ask_analyst', 'ask')
tn.link('ask?', 'prepare_architect', 'plan')
tn.link('ask_analyst', 'save_answers')
tn.link('save_answers', 'prepare_architect', 'success')
tn.fail('save_answers', 'the answers could not be saved')
session(tn, 'architect', 'file_issues')
fileNode(tn)
const NEW_WF = tn.workflow(
  'ticket-new',
  'File one ticket from a plain-text request: analyst, open questions to a person, architect (the whole spec), issue in Backlog. Start with `yk ticket new "<text>"`.',
)
NEW_WF.edges.push(...edges('trigger', 'prepare_analyst'))
// ticket-from-plan: the architect splits a plan into tickets -> issues in Backlog, in order, with their dependencies
const tp = new G()
session(tp, 'split', 'file_issues')
fileNode(tp)
const PLAN_WF = tp.workflow(
  'ticket-from-plan',
  'File the tickets of a plan (design/plans/*.md): the architect splits it, each ticket is filed in Backlog in order with its dependencies. Start with `yk ticket from-plan <plan>`.',
)
PLAN_WF.edges.push(...edges('trigger', 'prepare_split'))

export const WORKFLOWS: Record<string, Json> = {
  'ticket-run': TICKET_WF,
  'ticket-agent': AGENT_WF,
  'ticket-new': NEW_WF,
  'ticket-from-plan': PLAN_WF,
  round: ROUND_WF,
  round_steps: STEPS_WF,
  step: STEP_WF,
  finalize: FINAL_WF,
  revise: ESC_WF,
}

function check(wfs: Record<string, Json>): void {
  for (const [wid, wf] of Object.entries(wfs)) {
    const ids: string[] = wf.nodes.map((n: Json) => n.nodeId)
    const dup = ids.filter((i, k) => ids.indexOf(i) !== k)
    if (dup.length) throw new Error(`${wid}: duplicate nodes ${dup}`)
    for (const e of wf.edges)
      if (!ids.includes(e.source) || !ids.includes(e.target)) throw new Error(`${wid}: bad edge ${JSON.stringify(e)}`)
    for (const n of wf.nodes)
      if (n.type === 'SUB_WORKFLOW' && !(n.config.workflowId in wfs)) throw new Error(`${wid}: ${n.nodeId} calls an unknown workflow`)
  }
}

export function main(argv: string[]): number {
  check(WORKFLOWS)
  const out = dumps({ workflows: WORKFLOWS }, { indent: 2 }) + '\n'
  if (argv.includes('--check')) {
    const cur = existsSync(PATH) ? readFileSync(PATH, 'utf8') : ''
    if (cur !== out) {
      console.error('session.json is stale: run `bun src/ticket/gen-ticket.ts` and commit it')
      return 1
    }
    console.log('ticket-session.json is current')
  } else {
    writeFileSync(PATH, out)
    console.log(
      Object.entries(WORKFLOWS)
        .map(([k, v]) => `${k} ${v.nodes.length}`)
        .join(', '),
      'nodes',
    )
  }
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
