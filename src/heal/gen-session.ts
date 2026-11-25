// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// Writes the generated workflows of session.json: tool, agent, attempt, heal and check (the hand-written rest stays as it is).
//
//   tool       run one shell command in one project (src/tool.ts)
//   check      one SUB_WORKFLOW call of `tool` per stage, in STAGES order (cheap first). `yk check` puts each stage's command in the start payload
//              (cmd.<stage>, from src/plan.ts); a stage without a command passes at once. Before the first Gradle stage a `fast` node runs all the
//              Gradle tasks of the plan as one invocation (start.fast, empty = off, yk check --no-fast); when it passes, the Gradle stages run a
//              no-op (start.chain.<stage>), when it fails they run as usual. A failed stage goes to the `heal` workflow; a healed stage goes on
//              with the next one; a failed heal ends the run with outcome FAILED, reason = the stage (failed_node). licenses and security are never
//              healed. After the last stage, when anything was healed, `verify` runs the Gradle tasks of the stages again.
//   agent      L0  one headless Claude Code session on Yukta's AGENT_SESSION plugin (harness claude-code, the flags of src/heal/claude.ts): cost, turns and the structured answer come back in the payload
//   attempt    L1  one repair attempt: prepare -> agent -> claimed -> format -> judge (the guard) -> recheck -> report
//   heal       L1  free automatic fix, then the ladder of heal.json: model/effort rungs (haiku low, medium, high, then sonnet), one attempt each; a failed
//                  rung hands over to the next, the end of the ladder gives up. The efforts (budget, time box) come from heal.json too.
//
//   bun src/heal/gen-session.ts           write session.json       bun src/heal/gen-session.ts --check   exit 1 when the committed session.json is stale
// HEAL_SESSION and HEAL_POLICY point the generator at another session file and policy (the tests do). Edit this file or heal.json, run it, commit session.json.
import { ecosystem } from './heal.ts'
import { FIXER_ALLOW, MCP_DENY, MCP_READ, CLAUDE_SESSION_ENV } from './claude.ts'
import { HERE, type Json, existsSync, join, readFileSync, writeFileSync } from '../lib.ts'

const PATH = process.env.HEAL_SESSION || join(HERE, 'session.json')
const BUN = 'bun'
const HEAL = ['__DOGFOOD__/src/heal/heal.ts']
const S = (k: string): string => `\${start.${k}}`
type Edge = { source: string; target: string; sourcePort?: string }
const edges = (src: string, dst: string, ...ports: string[]): Edge[] =>
  ports.length ? ports.map((p) => ({ source: src, target: dst, sourcePort: p })) : [{ source: src, target: dst }]
const cmd = (file: string, ...args: string[]): string[] => [BUN, file, ...args]

// display only (palette of Yukta's canvas: teal, sky, violet, magenta, stone): input stone, the process sky, success teal, failure magenta, stopped early violet
const COLORS: Record<string, string> = { trigger: 'stone', run: 'sky', agent: 'sky', ok: 'teal', failed: 'magenta', early: 'violet' }

/** Colors every node of a workflow by what it is: inputs stone, process and agent steps sky, calls of another workflow violet, a failure magenta, a pass teal. */
export function paint(wf: Json): Json {
  const kind = (n: Json): string => {
    if (/TRIGGER|SOURCE/.test(n.type)) return 'stone'
    if (n.type === 'SUB_WORKFLOW') return 'violet'
    if (n.type === 'PROCESS_EXECUTOR' || n.type === 'AGENT_SESSION' || n.type === 'CLASSIFY') return 'sky'
    if (n.type === 'CONSOLE_TERMINAL') return 'teal'
    if (n.type === 'OUTCOME_TERMINAL') return n.config?.outcome === 'FAILED' ? 'magenta' : n.config?.outcome === 'RETRY' ? 'violet' : 'teal'
    return 'stone' // BRANCH and the rest
  }
  for (const n of wf.nodes) n.color = COLORS[n.nodeId] ?? kind(n)
  return wf
}

/** Sets the description of nodes (display only: the info button of the canvas). `text` maps a nodeId to it; a node it does not name keeps none. */
export function describe(wf: Json, text: (nodeId: string) => string | undefined): Json {
  for (const n of wf.nodes) {
    const d = text(n.nodeId)
    if (d) n.description = d
  }
  return wf
}
const byId = (m: Record<string, string>) => (id: string) => m[id]

/** Groups the nodes of a workflow for the canvas (display only): `of` names the group of a node, `colors` its palette color. */
export function group(wf: Json, of: (nodeId: string) => string, colors: (group: string) => string): Json {
  for (const n of wf.nodes) n.group = of(n.nodeId)
  wf.groupColors = Object.fromEntries([...new Set<string>(wf.nodes.map((n: Json) => n.group))].map((g) => [g, colors(g)]))
  return wf
}

/** check: one group per stage (a stage's nodes are `<stage>` and `<stage>.x`), colored by ecosystem; the fast path and the verify run have their own. */
const ECOSYSTEM_COLOR: Record<string, string> = {
  'go (cli)': 'teal',
  'typescript (ui)': 'violet',
  'repo files': 'stone',
  'java (gradle)': 'sky',
}
export const checkGroups = (wf: Json): Json =>
  group(
    wf,
    (id) => (['trigger', 'healed?', 'done'].includes(id) ? 'check' : id.split('.')[0]!),
    (g) => (g === 'check' ? 'stone' : ECOSYSTEM_COLOR[ecosystem(g)]!),
  )

/** heal: the free fix, the brief, the ladder of rungs, and the way in and out. */
const HEAL_GROUPS: Record<string, string> = { 'free-fix': 'teal', brief: 'violet', ladder: 'sky', start: 'stone', outcome: 'stone' }
export const healGroups = (wf: Json): Json =>
  group(
    wf,
    (id) => {
      if (['trigger', 'heal?', 'disabled'].includes(id)) return 'start'
      if (id.startsWith('auto')) return 'free-fix'
      if (id.startsWith('fix-') || id.startsWith('carry.')) return 'ladder'
      if (['done', 'giveup'].includes(id)) return 'outcome'
      return 'brief' // brief, first, known?, baseline-known
    },
    (g) => HEAL_GROUPS[g]!,
  )

// ---------------------------------------------------------------- tool
export function toolWorkflow(wf: Json): Json {
  const run = wf.nodes.find((n: Json) => n.nodeId === 'run')
  run.config.command = cmd('__DOGFOOD__/src/tool.ts')
  return describe(paint(wf), byId({ run: 'Runs the command in the project (src/tool.ts) and passes its output and exit code on.' }))
}

// ---------------------------------------------------------------- check
const STAGES = [
  'reuse',
  'actionlint',
  'docs',
  'spotless',
  'cli_fmt_check',
  'cli_mod_verify',
  'ui_prettier',
  'dogfood_fmt',
  'dogfood_check',
  'compile',
  'cli_vet',
  'ui_tsc',
  'ui_eslint',
  'ui_headers',
  'style',
  'spotbugs',
  'cli_lint',
  'cli_sec',
  'tests',
  'ui_vitest',
  'coverage',
  'cli_cover_check',
  'cli_vuln',
  'licenses',
  'security',
  'ui_build',
]
const STAGE_DESC: Record<string, string> = {
  reuse: 'REUSE lint: every file has its license header.',
  actionlint: 'Lints the GitHub Actions workflows.',
  docs: 'Checks the Markdown docs (links and structure).',
  spotless: 'Gradle formatting check of the Java code (spotlessCheck).',
  cli_fmt_check: 'gofmt check of the Go CLI.',
  cli_mod_verify: 'Verifies the Go module dependencies (go mod verify).',
  ui_prettier: 'Prettier format check of the UI.',
  dogfood_fmt: 'Format check of the yukta-dogfood tooling.',
  dogfood_check: 'Typecheck of the yukta-dogfood tooling.',
  compile: 'Compiles the Java modules.',
  cli_vet: 'go vet of the Go CLI.',
  ui_tsc: 'TypeScript typecheck of the UI.',
  ui_eslint: 'ESLint of the UI.',
  ui_headers: 'Checks the license headers of the UI files.',
  style: 'Checkstyle of the Java code.',
  spotbugs: 'SpotBugs static analysis of the Java code.',
  cli_lint: 'golangci-lint of the Go CLI.',
  cli_sec: 'gosec security scan of the Go CLI.',
  tests: 'Runs the Java tests.',
  ui_vitest: 'Runs the UI unit tests (Vitest).',
  coverage: 'Java test coverage against its threshold.',
  cli_cover_check: 'Go CLI test coverage against its threshold.',
  cli_vuln: 'govulncheck: known vulnerabilities in the Go dependencies.',
  licenses: 'Checks the licenses of the dependencies. Never healed.',
  security: 'Dependency security scan. Never healed.',
  ui_build: 'Production build of the UI.',
}
/** The stage nodes: `<stage>` runs it, `.fail` extracts its output, `.heal` repairs it, `.failed` ends the run. */
const stageText = (id: string): string | undefined => {
  const [s, part] = id.split('.') as [string, string | undefined]
  const d = STAGE_DESC[s]
  if (!d) return undefined
  if (!part) return d
  if (part === 'fail') return `Takes the output of the failed ${s} stage to hand to heal.`
  if (part === 'heal') return `Repairs the failed ${s} stage with the heal workflow (free fix, then the Claude ladder).`
  return `Ends the run as FAILED: the ${s} stage failed and could not be healed.`
}
const CHECK_DESC: Record<string, string> = {
  trigger: 'Start: the plan of the run (stages, commands, options) arrives here.',
  fast: 'Runs every Gradle task of the plan as one invocation. A pass lets the Gradle stages skip; a failure only means they run one by one.',
  'healed?': 'Did anything get healed in this run? Only then the Gradle tasks run once more.',
  verify: 'Runs the Gradle tasks of all stages again: a fix may have broken a stage that ran before it.',
  'verify.fail': 'Takes the output of the failed verify run to hand to heal.',
  'verify.heal': 'Repairs the failed verify run with the heal workflow.',
  'verify.failed': 'Ends the run as FAILED: verify failed and could not be healed.',
  done: 'Ends the run: every stage passed.',
}
const FAST_BEFORE = 'spotless' // the fast path runs in front of the first Gradle stage
const NO_HEAL = new Set(['licenses', 'security']) // a model may not fix these
const PASS = ['project', 'healDir', 'modules', 'events', 'models', 'timeout', 'rules', 'heal', 'budgetCheck']

function toolCall(stage: string, nodeId: string, command?: string): Json {
  return {
    nodeId,
    type: 'SUB_WORKFLOW',
    config: {
      workflowId: 'tool',
      timeoutSeconds: 3720,
      routeByOutcome: true,
      // the chain runs start.chain.<stage>: the stage's command, or a no-op once the fast path has passed the Gradle stages
      payload: { project: '${start.project}', command: command ?? `\${start.chain.${stage}}`, timeout: '${start.timeout}', label: stage },
    },
  }
}
const failedNode = (stage: string): Json => ({
  nodeId: stage + '.failed',
  type: 'OUTCOME_TERMINAL',
  config: { outcome: 'FAILED', reason: stage },
})
const PROJECT_STDOUT = {
  mode: 'PROJECTION',
  mapping: { stdout: "payload['results'] == null ? '' : (payload['results'].size() > 0 ? payload['results'][0]['stdout'] : '')" },
}

export function checkWorkflow(): Json {
  const nodes: Json[] = [{ nodeId: 'trigger', type: 'CONSTANT_SOURCE', config: {} }]
  const es: Edge[] = []
  let exits: [string, string | null][] = [['trigger', null]] // what the next stage hangs on: (node, port)
  const edge = (src: string, dst: string, port: string | null = null): void =>
    void es.push({ source: src, target: dst, ...(port ? { sourcePort: port } : {}) })
  for (const s of STAGES) {
    if (s === FAST_BEFORE) {
      // the fast path: every Gradle task of the plan in one invocation. A pass makes the Gradle stages below no-ops; a failure is not an outcome of
      // the run, it only means the staged chain runs, so the failing stage is found, healed and reported as ever.
      nodes.push(toolCall('fast', 'fast', '${start.fast}'))
      for (const [src, port] of exits) edge(src, 'fast', port)
      exits = [
        ['fast', 'success'],
        ['fast', 'failure'],
      ]
    }
    nodes.push(toolCall(s, s))
    for (const [src, port] of exits) edge(src, s, port)
    nodes.push(failedNode(s))
    if (NO_HEAL.has(s)) {
      edge(s, s + '.failed', 'failure')
      exits = [[s, 'success']]
      continue
    }
    // a payload value "${payload}" reaches a sub-workflow as text, not as the map (gap G11): the failed stage's output goes as a string
    nodes.push({ nodeId: s + '.fail', type: 'MAPPER', config: PROJECT_STDOUT })
    nodes.push({
      nodeId: s + '.heal',
      type: 'SUB_WORKFLOW',
      config: {
        workflowId: 'heal',
        timeoutSeconds: 21600,
        routeByOutcome: true,
        payload: {
          ...Object.fromEntries(PASS.map((k) => [k, S(k)])),
          stdout: '${payload.stdout}',
          stage: s,
          command: `\${start.cmd.${s}}`,
          format: `\${start.fmt.${s}}`,
          auto: `\${start.auto.${s}}`,
        },
      },
    })
    edge(s, s + '.fail', 'failure')
    edge(s + '.fail', s + '.heal')
    edge(s + '.heal', s + '.failed', 'failure')
    exits = [
      [s, 'success'],
      [s + '.heal', 'success'],
    ]
  }
  // verify: only when something was healed, the Gradle tasks of every stage once more (a fix may break a stage that ran before it)
  nodes.push({
    nodeId: 'healed?',
    type: 'PROCESS_EXECUTOR',
    config: {
      command: cmd('__DOGFOOD__/src/heal/heal.ts', 'healed'),
      workingDir: '${start.project}',
      env: { YUKTA_HEAL_DIR: '${start.healDir}', YUKTA_STAGE: '-' },
      timeout: 60,
      timeoutSeconds: 60,
      failureMode: 'CONTINUE',
      routeByExitCode: true,
    },
  })
  for (const [src, port] of exits) edge(src, 'healed?', port)
  nodes.push(toolCall('verify', 'verify', '${start.verifyCommand}'))
  nodes.push(failedNode('verify'))
  // a failed verify goes back to heal (stage "verify", the same Gradle tasks as its command), like any stage
  nodes.push({ nodeId: 'verify.fail', type: 'MAPPER', config: PROJECT_STDOUT })
  nodes.push({
    nodeId: 'verify.heal',
    type: 'SUB_WORKFLOW',
    config: {
      workflowId: 'heal',
      timeoutSeconds: 21600,
      routeByOutcome: true,
      payload: {
        ...Object.fromEntries(PASS.map((k) => [k, S(k)])),
        stdout: '${payload.stdout}',
        stage: 'verify',
        command: '${start.verifyCommand}',
        format: '${start.fmt.spotless}',
        auto: '-',
      },
    },
  })
  nodes.push({ nodeId: 'done', type: 'CONSOLE_TERMINAL', config: { displayOutput: true } })
  edge('healed?', 'verify', 'success')
  edge('healed?', 'done', 'failure')
  edge('verify', 'done', 'success')
  edge('verify', 'verify.fail', 'failure')
  edge('verify.fail', 'verify.heal')
  edge('verify.heal', 'done', 'success')
  edge('verify.heal', 'verify.failed', 'failure')
  return describe(
    {
      workflowId: 'check',
      description: 'The scoped, self-healing quality gate: one tool call per planned stage, a failed stage goes to heal (yk check)',
      nodes,
      edges: es,
    },
    (id) => CHECK_DESC[id] ?? stageText(id),
  )
}

// ---------------------------------------------------------------- attempt, heal
const ATTEMPT_DESC: Record<string, string> = {
  trigger: 'Start: the problems of the failed stage and what the previous attempt said.',
  prepare: 'Writes the prompt, the rules and the MCP config of this attempt; refuses when the budget check says no.',
  agent: "Runs the Claude fixer session (the agent workflow) at this attempt's model and effort.",
  claimed: 'Records what the fixer says it did.',
  format: 'Runs the project formatter over what the fixer changed.',
  judge: 'The guard: rejects edits outside what a fixer may touch (config, build-logic, CI, this folder).',
  recheck: 'Re-runs the failed stage: this decides whether the attempt worked.',
  report: 'Writes the attempt record (cost, tokens, changed files) and says whether the stage is fixed.',
  'fixed?': 'Did the stage pass after the attempt?',
  ok: 'The attempt fixed the stage.',
  failed: 'The attempt did not fix the stage; heal goes to the next rung.',
}
const HEAL_DESC: Record<string, string> = {
  trigger: 'Start: the failed stage, its output and the heal options.',
  'heal?': 'Is healing on? (yk check --no-heal turns it off.)',
  disabled: 'Healing is off: the stage stays failed.',
  'auto?': 'Does this stage have a free automatic fix (a formatter, a generator)?',
  'auto-fix': 'Runs the free fix: no model, no cost.',
  'auto-check': 'Re-runs the stage after the free fix; only a stage that still fails goes on to a model.',
  'auto-record': 'Records that the free fix healed the stage.',
  brief: 'Builds the brief for the fixers: the problems, and whether the stage already fails the same way on a clean origin/main.',
  first: 'Takes the problems of the brief as the input of the first rung.',
  'known?': 'Does the stage already fail the same way on origin/main?',
  'baseline-known': 'A known failure of origin/main: no fixer is started, the stage stays failed.',
  done: 'The stage is healed.',
  giveup: 'Gives up: the ladder is spent or a stronger model would gain nothing. The stage stays failed.',
}
const rungText = (id: string): string => {
  const [, m, e] = id.split('-')
  return `Repair attempt with ${m} at ${e} effort (one attempt per rung); the stage is re-run to judge it.`
}
const carryText = (id: string): string =>
  id.endsWith('?')
    ? 'Stops the ladder when the attempt changed nothing, failed as before, or the stage is single-attempt; otherwise goes on to the next rung.'
    : `Carries the problems and the summary of the failed attempt to the next rung (${id.slice(6)}).`
export function healWorkflows(policy: Json): { agent: Json; attempt: Json; heal: Json } {
  const EFFORTS: Record<string, { budget: number; timeout: number }> = Object.fromEntries(
    Object.entries<Json>(policy.efforts).map(([e, c]) => [e, { budget: c.budget, timeout: c.timeoutSeconds }]),
  )
  const LADDER = (policy.ladder as string[]).map((x) => x.split('/') as [string, string]) // the rungs, in order: model/effort, one attempt each
  const SINGLE: string[] = policy.singleAttempt ?? []
  const FIX_SCHEMA =
    '{"type":"object","properties":{"fixed":{"type":"boolean"},"summary":{"type":"string"}},"required":["fixed","summary"]}'
  // what every layer passes on to the next: heal -> attempt
  const KEYS = ['project', 'stage', 'command', 'format', 'modules', 'healDir', 'events', 'models', 'timeout', 'rules', 'budgetCheck']
  const passed = (keys: string[]): Json => Object.fromEntries(keys.map((k) => [k, S(k)]))
  const ROUTE = { engine: { onError: 'ROUTE' } }

  const toolCallCfg = (command: string, label: string, extra: Json = {}): Json => ({
    workflowId: 'tool',
    timeoutSeconds: 3720,
    routeByOutcome: true,
    payload: { project: S('project'), command, timeout: S('timeout'), label },
    ...extra,
  })
  const pe = (
    nodeId: string,
    action: string,
    env: Json = {},
    o: { stdin?: boolean; json?: boolean; timeout?: number; routed?: boolean; envIn?: boolean } = {},
  ): Json => {
    const timeout = o.timeout ?? 120
    const cfg: Json = { command: cmd(HEAL[0]!, action), workingDir: S('project'), env, timeout, timeoutSeconds: timeout }
    if (o.stdin) cfg.inputMode = 'STDIN'
    if (o.envIn) cfg.inputMode = 'ENV' // the dead letter's failure.message arrives as YUKTA_METADATA_FAILURE_MESSAGE, the brief as YUKTA_PAYLOAD
    if (o.json) cfg.outputFormat = 'JSON'
    Object.assign(cfg, o.routed ? { failureMode: 'CONTINUE', routeByExitCode: true } : { failureMode: 'CONTINUE' })
    return { nodeId, type: 'PROCESS_EXECUTOR', config: cfg }
  }
  const healEnv = (extra: Json = {}): Json => ({
    YUKTA_HEAL_DIR: S('healDir'),
    YUKTA_STAGE: S('stage'),
    YUKTA_MODULE: S('modules'),
    YUKTA_HEAL_EVENTS: S('events'),
    ...extra,
  })
  /** An expression that reads the result of a SUB_WORKFLOW safely: results may be missing (the message came through the error port, so it is the
   * node's own input) or empty (the child execution crashed). */
  const fromResult = (path: string, onError: string, onCrash: string): string =>
    `payload['results'] == null ? ${onError} : (payload['results'].size() > 0 ? payload['results'][0]${path} : ${onCrash})`
  const carry = (path: string): Json => ({
    mode: 'PROJECTION',
    mapping: {
      problems: fromResult(path + "['problems']", "payload['problems']", "'The previous attempt did not finish: ' + payload['reason']"),
      previous: fromResult(path + "['summary']", "'The previous attempt ran out of time.'", "''"),
      changed: fromResult(path + "['changed']", 'true', 'true'),
      same: fromResult(path + "['same']", 'false', 'false'),
      stage: fromResult(path + "['stage']", "''", "''"),
    },
  })

  // ---- attempt (L1)
  const agentCall: Json = {
    workflowId: 'agent',
    timeoutSeconds: 7200,
    routeByOutcome: true,
    engine: { onError: 'ROUTE' },
    payload: {
      project: S('project'),
      prompt: '${payload.output.prompt}',
      model: S('model'),
      effort: S('effort'),
      budget: S('budget'),
      schema: FIX_SCHEMA,
      rulesFile: `${S('healDir')}/${S('stage')}-\${payload.output.attempt}.rules`,
      mcpConfig: `${S('healDir')}/${S('stage')}-\${payload.output.attempt}.mcp.json`,
    },
  }
  const aEnv = { YUKTA_MODEL: S('model'), YUKTA_EFFORT: S('effort'), YUKTA_COMMAND: S('command') }
  const ATTEMPT_WF: Json = {
    workflowId: 'attempt',
    description: 'One repair attempt: one Claude session at one model and effort, judged by re-running the failed stage.',
    nodes: [
      { nodeId: 'trigger', type: 'CONSTANT_SOURCE', config: { variables: { problems: S('problems'), previous: S('previous') } } },
      pe(
        'prepare',
        'prepare',
        healEnv({
          ...aEnv,
          YUKTA_MODELS: S('models'),
          YUKTA_BUDGET_CHECK: S('budgetCheck'),
          YUKTA_HEAL_TIMEOUT: S('claudeTimeout'),
          YUKTA_RULES: S('rules'),
        }),
        { stdin: true, json: true, routed: true },
      ),
      { nodeId: 'agent', type: 'SUB_WORKFLOW', config: agentCall },
      pe('claimed', 'claimed', healEnv(aEnv), { stdin: true, timeout: 60 }),
      { nodeId: 'format', type: 'SUB_WORKFLOW', config: { ...toolCallCfg(S('format'), 'format'), ...ROUTE } },
      pe('judge', 'judge', healEnv({ ...aEnv, YUKTA_PROBLEMS: S('problems') }), { routed: true }),
      { nodeId: 'recheck', type: 'SUB_WORKFLOW', config: { ...toolCallCfg(S('command'), S('stage')), ...ROUTE } },
      pe('report', 'report', healEnv({ ...aEnv, YUKTA_PROBLEMS: '${start.problems}' }), { stdin: true, json: true }),
      {
        nodeId: 'fixed?',
        type: 'BRANCH',
        config: { mode: 'SELECT_KEY', selector: "payload['output']['fixed']", cases: { true: 'fixed' }, defaultPort: 'notfixed' },
      },
      { nodeId: 'ok', type: 'CONSOLE_TERMINAL', config: {} },
      { nodeId: 'failed', type: 'OUTCOME_TERMINAL', config: { outcome: 'FAILED', reason: 'the attempt did not fix the stage' } },
    ],
    edges: [
      ...edges('trigger', 'prepare'),
      ...edges('prepare', 'agent', 'success'),
      ...edges('prepare', 'report', 'failure'),
      ...edges('agent', 'claimed', 'success', 'failure', 'error'),
      ...edges('claimed', 'format'),
      ...edges('format', 'judge', 'success', 'failure', 'error'),
      ...edges('judge', 'recheck', 'success'),
      ...edges('judge', 'report', 'failure'),
      ...edges('recheck', 'report', 'success', 'failure', 'error'),
      ...edges('report', 'fixed?'),
      ...edges('fixed?', 'ok', 'fixed'),
      ...edges('fixed?', 'failed', 'notfixed'),
    ],
  }
  const attemptCall = (m: string, e: string): Json => ({
    workflowId: 'attempt',
    timeoutSeconds: 7200,
    routeByOutcome: true,
    engine: { onError: 'ROUTE' },
    payload: {
      ...passed(KEYS),
      model: m,
      effort: e,
      budget: EFFORTS[e]!.budget,
      claudeTimeout: EFFORTS[e]!.timeout,
      problems: '${payload.problems}',
      previous: '${payload.previous}',
    },
  })

  // ---- heal (L1)
  const rid = (m: string, e: string): string => `fix-${m}-${e}`
  // The ladder is one list in heal.json, tried in order, one attempt per rung: a failed rung hands over to the next, the end of the ladder gives up. The attempt
  // workflow takes the model and the effort from its start variables, so this workflow is the only place that decides them.
  const rungs: Json[] = LADDER.map((st) => ({ nodeId: rid(...st), type: 'SUB_WORKFLOW', config: attemptCall(...st) }))
  const nodes: Json[] = [
    { nodeId: 'trigger', type: 'CONSTANT_SOURCE', config: { variables: { stdout: S('stdout'), heal: S('heal'), auto: S('auto') } } },
    {
      nodeId: 'heal?',
      type: 'BRANCH',
      config: { mode: 'SELECT_KEY', selector: "payload['heal']", cases: { off: 'off' }, defaultPort: 'on' },
    },
    { nodeId: 'disabled', type: 'OUTCOME_TERMINAL', config: { outcome: 'FAILED', reason: 'healing is off (yk check --no-heal)' } },
    {
      nodeId: 'auto?',
      type: 'BRANCH',
      config: {
        mode: 'EXPRESSION',
        cases: { "payload['auto'] != null and payload['auto'] != '' and payload['auto'] != '-'": 'auto' },
        defaultPort: 'model',
      },
    },
    { nodeId: 'auto-fix', type: 'SUB_WORKFLOW', config: { ...toolCallCfg(S('auto'), 'auto-fix'), ...ROUTE } },
    { nodeId: 'auto-check', type: 'SUB_WORKFLOW', config: { ...toolCallCfg(S('command'), S('stage')), ...ROUTE } },
    pe('auto-record', 'record-auto', healEnv(), { timeout: 60 }),
    // the brief also runs the stage once on a clean origin/main (cached by sha), so it can take as long as a stage
    pe('brief', 'brief', healEnv({ YUKTA_COMMAND: S('command') }), { stdin: true, json: true, timeout: 3720 }),
    {
      nodeId: 'first',
      type: 'MAPPER',
      config: {
        mode: 'PROJECTION',
        mapping: {
          problems: "payload['output']['problems']",
          previous: "''",
          known: "payload['output']['known']",
        },
      },
    },
    {
      nodeId: 'known?',
      type: 'BRANCH',
      config: { mode: 'SELECT_KEY', selector: "payload['known']", cases: { true: 'known' }, defaultPort: 'unknown' },
    },
    {
      nodeId: 'baseline-known',
      type: 'OUTCOME_TERMINAL',
      config: {
        outcome: 'FAILED',
        reason: 'the stage already fails the same way on origin/main: a known baseline failure, no fixer was started',
      },
    },
  ]
  const e: Edge[] = []
  e.push(...edges('trigger', 'heal?'), ...edges('heal?', 'disabled', 'off'), ...edges('heal?', 'auto?', 'on'))
  e.push(...edges('auto?', 'auto-fix', 'auto'), ...edges('auto?', 'brief', 'model'))
  // all three ports of auto-fix go to auto-check on purpose: the exit code of a free fix is not reliable (a formatter may exit non-zero after it changed files,
  // or time out), the re-run of the stage decides, and only a stage that still fails goes on to the paid ladder
  e.push(...edges('auto-fix', 'auto-check', 'success', 'failure', 'error'), ...edges('auto-check', 'auto-record', 'success'))
  e.push(...edges('auto-check', 'brief', 'failure', 'error'), ...edges('auto-record', 'done'))
  e.push(
    ...edges('brief', 'first'),
    ...edges('first', 'known?'),
    ...edges('known?', 'baseline-known', 'known'),
    ...edges('known?', rid(...LADDER[0]!), 'unknown'),
  )
  LADDER.forEach((st, k) => {
    const after = LADDER[k + 1]
    e.push(...edges(rid(...st), 'done', 'success'))
    if (!after) {
      e.push(...edges(rid(...st), 'giveup', 'failure', 'error'))
      return
    }
    const c = 'carry.' + rid(...after)
    nodes.push({ nodeId: c, type: 'MAPPER', config: carry("['output']") })
    // an attempt that changed nothing gains nothing from a stronger model asking the same question: give up. So does a second attempt on a stage in
    // heal.json singleAttempt, which an edit to the code often cannot fix (a licence header, a docs link) nor does one that failed exactly as the
    // attempt before it did (no progress, `same` of the report step)
    const stop =
      "payload['changed'] == false or payload['same'] == true" +
      (SINGLE.length ? ` or {${SINGLE.map((x) => `'${x}'`).join(',')}}.contains(payload['stage'])` : '')
    nodes.push({ nodeId: c + '?', type: 'BRANCH', config: { mode: 'EXPRESSION', cases: { [stop]: 'stop' }, defaultPort: 'go' } })
    e.push(...edges(c, c + '?'), ...edges(c + '?', rid(...after), 'go'), ...edges(c + '?', 'giveup', 'stop'))
    e.push(...edges(rid(...st), c, 'failure', 'error'))
  })
  nodes.push(...rungs)
  nodes.push(
    { nodeId: 'done', type: 'CONSOLE_TERMINAL', config: {} },
    { nodeId: 'giveup', type: 'OUTCOME_TERMINAL', config: { outcome: 'FAILED', reason: 'every model failed at every effort' } },
  )
  const HEAL_WF: Json = {
    workflowId: 'heal',
    description:
      'Repair a failed stage: the free automatic fix first, then a fixed ladder of model and effort (heal.json ladder), one attempt each, until the stage passes.',
    nodes,
    edges: e,
  }
  describe(ATTEMPT_WF, byId(ATTEMPT_DESC))
  describe(HEAL_WF, (id) => HEAL_DESC[id] ?? (id.startsWith('fix-') ? rungText(id) : id.startsWith('carry.') ? carryText(id) : undefined))
  return { agent: agentWorkflow(), attempt: ATTEMPT_WF, heal: HEAL_WF }
}

/**
 * The `agent` workflow: one fixer-grade Claude Code session on the AGENT_SESSION plugin, the same flags as src/heal/claude.ts. Per call (start variables): prompt, project, model,
 * effort, budget, schema, rulesFile (the system prompt) and mcpConfig (a file: the key stays out of arguments). The three exits all end in a CONSOLE_TERMINAL so the payload
 * ({status, text, structured, costUsd, numTurns, reason, ...}) reaches the caller whatever the outcome; `status` says which.
 */
export function agentWorkflow(): Json {
  const mcp = (t: string): string => `mcp__yukta__${t}`
  const args = [
    ...['--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', S('mcpConfig')],
    ...['--disable-slash-commands', '--exclude-dynamic-system-prompt-sections', '--no-session-persistence'],
    ...['--tools', 'Read,Edit,Write,Grep,Glob,Bash', '--permission-mode', 'auto', '--permission-prompts', 'none'],
    ...['--allowedTools', ...FIXER_ALLOW, ...MCP_READ.map(mcp)],
    ...['--disallowedTools', 'Bash(git commit:*)', 'Bash(git push:*)', ...MCP_DENY.map(mcp)],
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
  ]
  const wf: Json = {
    workflowId: 'agent',
    description: 'One fixer-grade Claude Code session on the AGENT_SESSION plugin; the payload carries the answer, its cost and its turns.',
    nodes: [
      { nodeId: 'trigger', type: 'CONSTANT_SOURCE', config: { variables: { prompt: S('prompt') } } },
      {
        nodeId: 'agent',
        type: 'AGENT_SESSION',
        config: {
          harness: 'claude-code',
          prompt: '${payload.prompt}',
          model: S('model'),
          workingDir: S('project'),
          args,
          // a fixer reads no CLAUDE.md, runs on pinned models and may call ./gradlew (the project hooks check YUKTA_HEAL_FIXER); the unset ones keep it from
          // thinking it is the session that started the server
          env: {
            CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
            YUKTA_HEAL_FIXER: '1',
            ...Object.fromEntries(CLAUDE_SESSION_ENV.map((k) => [k, ''])),
          },
          timeout: 1800, // ponytail: AGENT_SESSION's timeout is a fixed number, not a start variable; the longest effort of heal.json, per-effort when it matters
          engine: { concurrencyGroup: 'agent' },
        },
      },
      { nodeId: 'ok', type: 'CONSOLE_TERMINAL', config: {} },
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
  return describe(
    paint(wf),
    byId({
      trigger: 'Start: the prompt of the session (model, effort, budget, rules and MCP config come as start variables).',
      agent: 'The Claude Code session itself (AGENT_SESSION, harness claude-code); its answer, cost and turns go into the payload.',
      ok: 'The session finished: the payload carries its answer.',
      failed: 'The session failed: the payload says why.',
      early: 'The session stopped early (budget or time box): the payload carries what it had.',
    }),
  )
}

/** The session with every generated workflow rewritten. */
export function generate(session: Json, policy: Json): Json {
  const d = JSON.parse(JSON.stringify(session))
  d.workflows.tool = toolWorkflow(d.workflows.tool)
  delete d.workflows['fix-from']
  delete d.workflows.claude // replaced by `agent`
  const h = healWorkflows(policy)
  for (const wf of [h.agent, h.attempt, h.heal]) d.workflows[wf.workflowId] = paint(wf)
  healGroups(d.workflows.heal)
  delete d.workflows['check-plain']
  d.workflows.check = checkGroups(paint(checkWorkflow()))
  delete d.workflows.pickup // removed: tickets run on demand (yk ticket run)
  return d
}

export function main(argv: string[]): number {
  const policy = JSON.parse(readFileSync(process.env.HEAL_POLICY || join(HERE, 'heal.json'), 'utf8'))
  const out =
    JSON.stringify(generate(JSON.parse(readFileSync(PATH, 'utf8')), policy), null, 2).replace(
      /[\u0080-￿]/g,
      (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
    ) + '\n'
  if (argv.includes('--check')) {
    const cur = existsSync(PATH) ? readFileSync(PATH, 'utf8') : ''
    if (cur !== out) {
      console.error('session.json is stale: run `bun src/heal/gen-session.ts` and commit it')
      return 1
    }
    console.log('session.json is current')
    return 0
  }
  writeFileSync(PATH, out)
  const d = JSON.parse(out)
  console.log(['tool', 'agent', 'attempt', 'heal', 'check'].map((k) => `${k} ${d.workflows[k].nodes.length}`).join(', '), 'nodes')
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
