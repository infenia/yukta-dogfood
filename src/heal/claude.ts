// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// The launcher of the ticket pipeline's headless Claude Code sessions (the heal's fixers run on AGENT_SESSION, workflow `agent`, with the same flags: claudeArgs). The message on stdin is {"prompt": "..."}; the answer is claude's JSON
// result on stdout; a non-zero exit is the workflow's failure port. The one launcher of the headless Claude sessions of the ticket roles
// (architect, test writer, implementer, reviewer).
//
// Environment (a value of "-" is unset; the workflow cannot pass an empty one):
//   YK_MODEL haiku|sonnet|opus   YK_EFFORT low|medium|high   YK_BUDGET USD   YK_RULES system prompt file   YK_SCHEMA JSON schema of the answer
//   YK_STAGE the failed stage: picks the role file fixer-rules/<kind>.md appended to YK_RULES (none for a stage without one)
//   YK_ROLE architect|test_writer|implementer|reviewer: a ticket-pipeline role, picks fixer-rules/ticket-<role>.md (wins over YK_STAGE)
//   YK_TOOLS readonly: Read, Grep and Glob only   YK_MAX_TURNS turn cap
//   YK_SESSION session id   YK_ADVISOR advisor model (experimental, off when unset)   YK_CLAUDE_BIN a stand-in for `claude` (tests)
//
// Slim on purpose: a fixed tool list, nothing that varies per run in the system prompt, and of the user's plugins and MCP servers only the ones that
// cut token use (agent-env.ts: codebase-memory, idea, intellij-index, ponytail, token-optimizer, jdtls-lsp); never the yukta MCP or skill, never a hook
// (--settings disableAllHooks). Not --bare: it would also drop the login. YUKTA_HEAL_FIXER=1 stays set for tools that look at it. It never commits or
// pushes: the workflow does.
import { mkdtempSync } from 'node:fs'
import { AGENT_ALLOW, AGENT_DENY, agentMcp, agentSettings } from './agent-env.ts'
import { tmpdir } from 'node:os'
import { HERE, isFile, join, readFileSync, rmSync, run, text, writeFileSync } from '../lib.ts'

// A headless claude must not think it is the session that started the server.
export const CLAUDE_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_PID',
]
export const FIXER_ALLOW = [
  'Read',
  'Edit',
  'Write',
  'Grep',
  'Glob',
  'Bash(./gradlew:*)',
  'Bash(make:*)',
  'Bash(go test:*)',
  'Bash(go vet:*)',
  'Bash(node_modules/.bin/*:*)',
  'Bash(reuse:*)',
  'Bash(actionlint:*)',
  'Bash(mint:*)',
  'Bash(cd:*)',
  ...AGENT_ALLOW,
]

/** The claude command line for one session (the tests read it back). */
export function claudeArgs(o: {
  mode: string
  prompt: string
  rules: string
  budget: string
  sid?: string
  env: NodeJS.ProcessEnv
}): string[] {
  const e = o.env
  let tools = 'Read,Edit,Write,Grep,Glob,Bash,Skill,LSP'
  let allowTools = [...FIXER_ALLOW, ...(e.YK_ALLOW ?? '').split('\n').filter(Boolean)] // the exact extra rules of a role (the ticket test writer's self-check)
  if (e.YK_TOOLS === 'readonly') {
    tools = 'Read,Grep,Glob,Skill,LSP'
    allowTools = ['Read', 'Grep', 'Glob', ...AGENT_ALLOW]
  }
  // read-only plus the exact tool rules in YK_ALLOW (newline-separated, e.g. `Write(/x/draft.json)`, `Bash(cmd:*)`): the ticket architect's self-check
  if (e.YK_TOOLS === 'selfcheck') {
    tools = 'Read,Grep,Glob,Write,Bash,Skill,LSP'
    allowTools = ['Read', 'Grep', 'Glob', ...AGENT_ALLOW, ...(e.YK_ALLOW ?? '').split('\n').filter(Boolean)]
  }
  const model = ['--model', o.mode]
  if (e.YK_MAX_TURNS) model.push('--max-turns', e.YK_MAX_TURNS)
  if (e.YK_EFFORT) model.push('--effort', e.YK_EFFORT)
  if (e.YK_ADVISOR) model.push('--advisor', e.YK_ADVISOR)
  const session = o.sid ? ['--session-id', o.sid] : ['--no-session-persistence']
  return [
    '-p',
    o.prompt,
    ...model,
    ...session,
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(agentMcp()),
    '--settings',
    JSON.stringify(agentSettings()),
    '--exclude-dynamic-system-prompt-sections',
    '--tools',
    tools,
    '--permission-mode',
    'auto',
    '--permission-prompts',
    'none',
    '--allowedTools',
    ...allowTools,
    '--disallowedTools',
    'Bash(git commit:*)',
    'Bash(git push:*)',
    ...AGENT_DENY,
    '--append-system-prompt',
    readFileSync(o.rules, 'utf8'),
    '--max-budget-usd',
    o.budget,
    '--output-format',
    'json',
    '--json-schema',
    e.YK_SCHEMA ??
      (() => {
        throw new Error('YK_SCHEMA is the answer schema')
      })(),
  ]
}

/** Writes the --mcp-config and --settings files of an agent for the `agent` workflow (AGENT_SESSION takes files): see agent-env.ts. */
export function writeAgentFiles(mcpFile: string, settingsFile: string): void {
  writeFileSync(mcpFile, JSON.stringify(agentMcp()))
  writeFileSync(settingsFile, JSON.stringify(agentSettings()))
}

/** The system prompt of a stage: the common rules plus fixer-rules/<kind>.md when the stage has one. Returns the text. */
export function stageRules(base: string, stage: string | undefined): string {
  const kind = roleKind(stage, undefined)
  const roleFile = join(HERE, 'fixer-rules', `${kind}.md`)
  return readFileSync(base, 'utf8') + (kind && isFile(roleFile) ? readFileSync(roleFile, 'utf8') : '')
}

/** The role file kind of a stage / ticket role (fixer-rules/<kind>.md). */
export function roleKind(stage: string | undefined, role: string | undefined): string {
  let kind = ''
  if (stage === 'style') kind = 'pmd'
  else if (stage === 'spotbugs' || stage === 'compile' || stage === 'coverage') kind = stage
  else if (stage === 'tests') kind = 'junit'
  else if (stage === 'ui_vitest') kind = 'vitest'
  else if (stage?.startsWith('ui_')) kind = 'ui'
  else if (stage?.startsWith('cli_')) kind = 'go'
  if (role) {
    if (!['architect', 'test_writer', 'implementer', 'reviewer'].includes(role)) throw new Error(`unknown YK_ROLE '${role}'`)
    kind = `ticket-${role.replaceAll('_', '-')}`
  }
  return kind
}

export function main(argv: string[], stdin?: string): number {
  const args = [...argv]
  if (args[0] === '--role') {
    if (!args[1]) {
      console.error('claude: --role needs a role')
      return 2
    }
    process.env.YK_ROLE = args[1]
    args.splice(0, 2)
  }
  for (const v of [
    'YK_TOOLS',
    'YK_MAX_TURNS',
    'YK_MODEL',
    'YK_EFFORT',
    'YK_BUDGET',
    'YK_RULES',
    'YK_SCHEMA',
    'YK_SESSION',
    'YK_CLAUDE_BIN',
    'YK_ADVISOR',
    'YK_STAGE',
    'YK_ROLE',
  ]) {
    if (process.env[v] === '-') delete process.env[v]
  }
  let prompt = ''
  try {
    prompt = JSON.parse(stdin ?? readFileSync(0, 'utf8')).prompt ?? ''
  } catch {
    /* no JSON */
  }
  if (!prompt) {
    console.error('claude: no prompt on stdin')
    return 2
  }
  const env = process.env
  // A fixer does not read the project's CLAUDE.md (about 5k tokens on every attempt, measured): fixer-rules.md has the few rules it needs.
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'
  // The aliases move when a new model ships; a fixer's cost and behaviour must not.
  Object.assign(env, {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
  })
  if (env.YK_CLAUDE_BIN) env.YUKTA_CLAUDE_BIN = env.YK_CLAUDE_BIN
  let kind: string
  try {
    kind = roleKind(env.YK_STAGE, env.YK_ROLE)
  } catch (e) {
    console.error(`claude: ${(e as Error).message}`)
    return 2
  }
  const base = env.YK_RULES
  if (!base) {
    console.error('claude: YK_RULES')
    return 2
  }
  let rules = base
  let tmp = ''
  const roleFile = join(HERE, 'fixer-rules', `${kind}.md`)
  if (kind && isFile(roleFile)) {
    tmp = mkdtempSync(join(tmpdir(), 'claude-rules-'))
    rules = join(tmp, 'rules.md')
    writeFileSync(rules, readFileSync(base, 'utf8') + readFileSync(roleFile, 'utf8'))
  }
  try {
    if (!env.YK_MODEL) {
      console.error('claude: YK_MODEL')
      return 2
    }
    if (!env.YK_SCHEMA) {
      console.error('claude: YK_SCHEMA is the answer schema')
      return 2
    }
    const childEnv: Record<string, string | undefined> = { ...env, YUKTA_HEAL_FIXER: '1' }
    for (const u of CLAUDE_SESSION_ENV) childEnv[u] = undefined
    const r = run(
      [
        env.YUKTA_CLAUDE_BIN || 'claude',
        ...claudeArgs({ mode: env.YK_MODEL, prompt, rules, budget: env.YK_BUDGET || '1', sid: env.YK_SESSION, env }),
      ],
      { env: childEnv },
    )
    process.stdout.write(r.stdout)
    if (r.code) {
      console.error(r.stderr.trim().split('\n').slice(-5).join('\n'))
      return r.code
    }
    return 0
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
