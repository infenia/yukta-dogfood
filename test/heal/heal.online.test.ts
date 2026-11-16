// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// Online test of the check and heal workflows on the dev server (yk up), YK_ONLINE=1, about half a minute, no API cost. The project is a throwaway git repo
// whose stages are `test -f <stage>.ok`. Only what needs no fixer runs here: the fixers run on AGENT_SESSION and need the real `claude`, so the ladder itself is
// covered offline (test/heal/ladder.test.ts) and by the attempt of a real session.
//
//   fast path         a pass makes the Gradle chain no-ops
//   baseline          a stage that fails the same way on origin/main gets no fixer
//   give up           five unfixed attempts in the last week mean no new attempt
//   free fix          the free fix of reuse makes the stage pass, no model is asked
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { devKey } from '../../src/lib.ts'
import { HERE, git, put, read, rm, sh, tmp, ts } from '../helpers.ts'

const ONLINE = Boolean(process.env.YK_ONLINE)
if (ONLINE) {
  process.env.YUKTA_TOKEN ||= devKey()
  process.env.YUKTA_SERVER_URL ||= 'http://127.0.0.1:9858'
}
setDefaultTimeout(600_000)
let d: string, proj: string, healdir: string
let result = ''
/** whether a model ran (<stage>-<n>.json; not the free fix, mode 'auto', and not an attempt that did not start) */
const fixers = (): boolean =>
  ['compile', 'tests', 'reuse'].some((st) => {
    const f = join(healdir, `${st}-1.json`)
    if (!existsSync(f)) return false
    const r = JSON.parse(read(f))
    return r.mode !== 'auto' && !String(r.summary).startsWith('the attempt did not start')
  })
const cli = (): string =>
  sh(['sh', '-c', 'cd "$1" && ls -t "$HOME"/.local/state/yukta-dev/builds/*/yukta-cli | head -1', '_', HERE]).out.trim()

beforeAll(() => {
  if (!ONLINE) return
  d = tmp()
  proj = join(d, 'proj')
  healdir = join(d, 'heal')
  sh(['mkdir', '-p', proj])
  git(proj, 'init', '-q')
  sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: proj })
})
afterAll(() => {
  if (d && !process.env.KEEP) rm(d)
})

type Opts = {
  compile?: string
  reuse?: string
  events?: string
  autoReuse?: string
  fast?: string
}
/** Runs a check of the project and sets `result` to its RESULT line. */
function scenario(name: string, o: Opts = {}): void {
  const session = `test-heal-${process.pid}`
  sh(['git', 'clean', '-fdq'], { cwd: proj })
  rm(healdir)
  sh(['mkdir', '-p', healdir])
  const sess = JSON.parse(read(join(HERE, 'session.json')))
  const names: string[] = sess.workflows.check.nodes
    .filter((n: any) => n.type === 'SUB_WORKFLOW' && n.config.workflowId === 'tool' && n.nodeId !== 'verify')
    .map((n: any) => n.nodeId)
  const cmds: Record<string, string> = Object.fromEntries(names.map((n) => [n, '']))
  Object.assign(cmds, { compile: o.compile ?? '', reuse: o.reuse ?? '' })
  const text = JSON.stringify(sess).split('__PROJECT_PATH__').join(proj).split('__DOGFOOD__').join(HERE)
  const rendered = { ...JSON.parse(text), sessionId: session, name: session }
  put(join(d, 'session.json'), rendered)
  const apply = sh([cli(), 'session', 'apply', join(d, 'session.json')])
  expect(apply.code, `${name}: session apply: ${apply.all}`).toBe(0)
  const dash = Object.fromEntries(names.map((n) => [n, '-']))
  const mark = join(healdir, 'fast.ok')
  const payload = {
    project: proj,
    timeout: 120,
    healDir: healdir,
    events: o.events ?? '-',
    modules: '-',
    models: '-',
    heal: 'on',
    rules: join(HERE, 'fixer-rules.md'),
    budgetCheck: '-',
    verifyCommand: 'true',
    cmd: cmds,
    auto: { ...dash, ...(o.autoReuse ? { reuse: o.autoReuse } : {}) },
    fmt: dash,
    fast: o.fast ? `${o.fast} && touch ${mark}` : '',
    chain: o.fast ? Object.fromEntries(Object.entries(cmds).map(([k, v]) => [k, v === '' ? v : `test -f ${mark} || ${v}`])) : cmds,
  }
  const start = sh([cli(), '-o', 'json', 'workflow', 'start', session, 'check', '--payload', JSON.stringify(payload)])
  const j = JSON.parse(start.out)
  const exec: string = (j.data ?? j).executionId
  expect(exec, `${name}: could not start`).toBeTruthy()
  for (let i = 0; i < 240; i++) {
    const st = JSON.parse(sh([cli(), '-o', 'json', 'workflow', 'status', session, exec]).out)
    if (!/^(RUNNING|QUEUED|PAUSED)$/.test((st.data ?? st).status)) break
    Bun.sleepSync(1000)
  }
  const r = ts('yk', ['result', session, exec], { env: { YUKTA_HEAL_RECORDS: healdir, YUKTA_SERVER_URL: 'http://127.0.0.1:9858' } })
  result = r.out.split('\n').find((l) => l.startsWith('RESULT')) ?? ''
  console.log(`     ${name}: ${result}`)
}
const expectIn = (name: string, s: string): void => void expect(result, `${name} expected '${s}' in: ${result}`).toContain(s)

test.skipIf(!ONLINE)('fast path: a pass makes the chain no-ops, no fixer runs', () => {
  scenario('fast path pass', { fast: 'true', compile: 'false' })
  expectIn('fast pass', 'status=SUCCESS')
  expectIn('fast pass', 'healed=-')
  expect(fixers()).toBe(false)
})
test.skipIf(!ONLINE)('baseline: a stage that fails the same way on origin/main gets no fixer', () => {
  git(proj, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  scenario('known baseline failure', { compile: 'echo "error: boom at A.java:20"; test -f compile.ok' })
  expectIn('baseline', 'status=FAILED')
  expectIn('baseline', 'failed_node=compile')
  expect(fixers()).toBe(false)
  git(proj, 'update-ref', '-d', 'refs/remotes/origin/main')
})
test.skipIf(!ONLINE)('give up: five unfixed attempts in the last week mean no new attempt', () => {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const fix = JSON.stringify({
    v: 1,
    ts: now,
    run: 'x',
    event: 'fix',
    stage: 'compile',
    attempt: 1,
    model: 'haiku',
    fixed: false,
    summary: 'it did not work',
  })
  put(join(d, 'events.jsonl'), Array.from({ length: 5 }, () => fix).join('\n') + '\n')
  scenario('give up', { events: join(d, 'events.jsonl'), compile: 'test -f compile.ok' })
  expectIn('give up', 'status=FAILED')
  expect(fixers()).toBe(false)
})
test.skipIf(!ONLINE)('free fix: reuse passes after its free fix, no model is asked', () => {
  scenario('reuse free fix', { autoReuse: 'touch reuse.ok', reuse: 'test -f reuse.ok' })
  expectIn('reuse free fix', 'status=SUCCESS')
  expectIn('reuse free fix', 'healed=reuse:auto')
  expect(fixers()).toBe(false)
})
