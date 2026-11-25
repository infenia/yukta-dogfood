// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// yk ticket: the commands of the ticket pipeline (Epic #1872). Called by dogfood/src/yk.ts; yk is the same entry for people who stand in
// this folder.
//
//   yk ticket run <issue> [--local] [--detach [--notify]]   run the `ticket` workflow on an issue: a tested change on branch issue/<n> in ../yukta-issue-<n>;
//                                                 --local runs this checkout's ticketkit (session ticket-local) instead of the dev server's main checkout
//   yk ticket new "<text>" [--dry-run] [--local] [--detach]  file one ticket from plain text (workflow ticket-new): analyst, its open questions to you, architect
//                                                 (the whole spec in the issue body), issue in Backlog; --dry-run writes the body to the filing dir instead
//   yk ticket from-plan <design/plans/x.md> [--dry-run] [--local] [--detach]   the tickets of a plan (workflow ticket-from-plan), filed in order with dependencies
//   yk ticket worktree <issue> [--branch B] [--base REF] [--in DIR]   a worktree or branch for the issue, reusing what exists (branch.ts)
//   yk ticket pr <issue> [--worktree W] [--title T] [--result R]      push the branch and open a DRAFT PR with `Fixes #n` (branch.ts)
//   yk ticket status <issue|execution>            the run's tree (which node runs or failed) and its last events
//   yk ticket report [--json]                      first-try pass rate, cost share and cache hit ratio by role, prefix mismatches, BLOCKED rate (ticket-events.jsonl)
//   yk ticket resume|stop <issue|execution>       continue a paused run / end it (a drain, like yk stop --tree)
// Approvals use `yk approve|reject <execution>` as the other gates do. The run dir is .yukta-dev/ticket/<run_id>/ (see README.md, "Ticket pipeline").
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import {
  DEV_HOME,
  STATE_DIR,
  cliJson,
  die,
  ensureServer,
  findCli,
  git,
  isDir,
  isFile,
  join,
  mkdirp,
  readJson,
  renderSession,
  rmSync,
  run,
  text,
  writeFileSync,
} from '../lib.ts'
import { cmdRunControl, cmdTree, startNotifier, watchOwned } from '../runs.ts'
import { main as report } from './report.ts'
import { KIT } from './lib.ts'
import { pr as prCmd, releaseCmd, worktree as worktreeCmd } from './branch.ts'

/** The `dogfood` session with the workflows `ticket` and `step`...: renderSession (dogfood) already holds them, so every yk command applies the same set. */
export function renderTicketSession(out: string): void {
  renderSession(out)
}

/** The session of `yk ticket run --local`: only the ticket workflows, from this checkout's ticketkit (not the dev server's main checkout), so a pipeline
 * change runs before it is merged; a session of its own, so no other yk command's apply of `dogfood` swaps the workflows during the run. */
export const LOCAL_SESSION = 'ticket-local'
export function renderLocalTicketSession(out: string): void {
  const sub = (v: unknown): unknown =>
    typeof v === 'string'
      ? v.split('__TICKET__').join(KIT)
      : Array.isArray(v)
        ? v.map(sub)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]))
          : v
  renderSession(out)
  const s = readJson(out)
  s.sessionId = s.name = LOCAL_SESSION
  s.workflows = sub(readJson(join(KIT, 'ticket-session.json')).workflows)
  writeFileSync(out, JSON.stringify(s, null, 2) + '\n')
}

/** "<run_id> <execution>" of the latest run of an issue. */
function ticketLast(issue: string): [string, string] {
  const f = join(STATE_DIR, `ticket-last-${issue}`)
  if (!isFile(f)) die(`no ticket run of issue ${issue} started from this checkout`)
  const [runId, execId] = text(f).trim().split(/\s+/)
  return [runId!, execId!]
}

async function ticketRun(argv: string[], ykPath: string): Promise<number> {
  let mode: 'watch' | 'detach' = 'watch'
  let notify = false
  let local = false
  let issue = ''
  for (const a of argv) {
    if (a === '--detach') mode = 'detach'
    else if (a === '--local') local = true
    else if (a === '--notify') notify = true
    else if (a.startsWith('-')) die(`unknown option '${a}' (yk ticket run <issue> [--local] [--detach [--notify]])`)
    else {
      if (issue) die('one issue at a time')
      issue = a
    }
  }
  if (!/^[0-9]+$/.test(issue)) die('usage: yk ticket run <issue number> [--detach [--notify]]')
  if (notify && mode !== 'detach') die('--notify needs --detach: a run you wait for reports to you anyway')
  const root = git(['rev-parse', '--show-toplevel']).stdout.trim()
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  const runId = `${issue}-${stamp}`
  const wtPattern: string = readJson(join(KIT, 'project.json')).git.worktree.replaceAll('{n}', issue)
  const wt = join(run(['sh', '-c', 'cd "$1" && cd "$2" && pwd', '_', root, dirname(wtPattern)]).stdout.trim(), `yukta-issue-${issue}`)
  await ensureServer()
  const cli = findCli()
  mkdirp(STATE_DIR)
  const tmp = mkdtempSync(join(tmpdir(), 'yk-ticket-run-'))
  try {
    const session = local ? LOCAL_SESSION : 'dogfood'
    if (local) renderLocalTicketSession(join(tmp, 'session.json'))
    else renderTicketSession(join(tmp, 'session.json'))
    const a = run([cli, 'session', 'apply', join(tmp, 'session.json')])
    if (a.code) {
      console.error(a.stdout + a.stderr)
      die('session apply failed')
    }
    const e = process.env
    const payload = {
      project: root,
      issue,
      runId,
      stateDir: STATE_DIR,
      run: `${STATE_DIR}/ticket/${runId}`,
      worktree: wt,
      claudeBin: e.YUKTA_CLAUDE_BIN || '-',
      gateStep: e.TICKET_GATE_STEP || '-',
      gateFinal: e.TICKET_GATE_FINAL || '-',
      healCmd: e.TICKET_HEAL_CMD || '-',
      baselineCmd: e.TICKET_BASELINE_CMD || '-',
      events: e.YUKTA_TICKET_EVENTS || join(DEV_HOME, 'ticket-events.jsonl'),
    }
    const execId = cliJson(['workflow', 'start', session, 'ticket-run', '--payload', JSON.stringify(payload)]).data?.executionId
    if (!execId) die('could not start the ticket workflow')
    writeFileSync(join(STATE_DIR, `ticket-last-${issue}`), `${runId} ${execId}\n`)
    console.log(`STARTED execution=${execId} session=${session} run=${STATE_DIR}/ticket/${runId} worktree=${wt}`)
    process.env.YUKTA_PROJECT = root
    process.env.YUKTA_SCOPE = `ticket:${issue}`
    if (notify) startNotifier(session, execId, ykPath)
    if (mode === 'detach') return 0
    return await watchOwned(session, execId)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** yk ticket new "<text>" / from-plan <plan>: a filing dir with the request, then the ticket-new or ticket-from-plan workflow on the dev server. */
async function ticketFile(wf: 'ticket-new' | 'ticket-from-plan', argv: string[], ykPath: string): Promise<number> {
  let dryRun = false
  let detach = false
  let local = false
  const words: string[] = []
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true
    else if (a === '--detach') detach = true
    else if (a === '--local') local = true
    else if (a.startsWith('-')) die(`unknown option '${a}'`)
    else words.push(a)
  }
  const root = git(['rev-parse', '--show-toplevel']).stdout.trim()
  const arg = words.join(' ').trim()
  if (!arg)
    die(
      wf === 'ticket-new'
        ? 'usage: yk ticket new "<what you want, in plain text>" [--dry-run]'
        : 'usage: yk ticket from-plan design/plans/<plan>.md [--dry-run]',
    )
  if (wf === 'ticket-from-plan' && !(/^design\/plans\/[^/]+\.md$/.test(arg) && isFile(join(root, arg))))
    die(`${arg}: not a plan of this checkout (design/plans/<name>.md)`)
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  const base = `${wf === 'ticket-new' ? 'new' : 'plan'}-${stamp}`
  let runId = base
  for (let k = 2; isDir(join(STATE_DIR, 'filing', runId)); k++) runId = `${base}-${k}` // two filings in the same second
  const dir = join(STATE_DIR, 'filing', runId)
  mkdirp(dir)
  writeFileSync(
    join(dir, 'request.json'),
    JSON.stringify({ project: root, dryRun, ...(wf === 'ticket-new' ? { text: arg } : { plan: arg }) }, null, 2) + '\n',
  )
  await ensureServer()
  const cli = findCli()
  const tmp = mkdtempSync(join(tmpdir(), 'yk-ticket-file-'))
  try {
    const session = local ? LOCAL_SESSION : 'dogfood'
    if (local) renderLocalTicketSession(join(tmp, 'session.json'))
    else renderTicketSession(join(tmp, 'session.json'))
    const a = run([cli, 'session', 'apply', join(tmp, 'session.json')])
    if (a.code) {
      console.error(a.stdout + a.stderr)
      die('session apply failed')
    }
    const payload = { project: root, dir, runId, claudeBin: process.env.YUKTA_CLAUDE_BIN || '-' }
    const execId = cliJson(['workflow', 'start', session, wf, '--payload', JSON.stringify(payload)]).data?.executionId
    if (!execId) die(`could not start the ${wf} workflow`)
    console.log(`STARTED execution=${execId} session=${session} dir=${dir}`)
    console.log(
      'Questions of the analyst or the architect wait for you in the UI (Agents and Inputs tabs), `yukta-cli inputs`, or MCP answer_input.',
    )
    if (detach) return 0
    const rc = await watchOwned(session, execId)
    for (const f of ['filed.json']) if (isFile(join(dir, f))) console.log(`filed: ${text(join(dir, f)).trim()}`)
    if (dryRun) console.log(`dry run: the bodies are ${dir}/ticket-<i>.md`)
    return rc
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  void ykPath
}

export async function cmdTicket(argv: string[], o: { ykPath: string }): Promise<number> {
  const sub = argv[0] ?? ''
  const rest = argv.slice(1)
  switch (sub) {
    case 'new':
      return ticketFile('ticket-new', rest, o.ykPath)
    case 'from-plan':
      return ticketFile('ticket-from-plan', rest, o.ykPath)
    case 'run':
      return ticketRun(rest, o.ykPath)
    case 'worktree':
      return worktreeCmd(rest)
    case 'release':
      return releaseCmd(rest)
    case 'pr':
      return prCmd(rest)
    case 'report':
      process.env.YUKTA_TICKET_EVENTS ||= join(DEV_HOME, 'ticket-events.jsonl')
      return report(rest)
    case 'status':
    case 'resume':
    case 'stop': {
      const target = rest[0] ?? die(`usage: yk ticket ${sub} <issue|execution>`)
      let execId = target
      let runId = ''
      if (/^[0-9]{1,8}$/.test(target)) [runId, execId] = ticketLast(target)
      if (sub === 'status') {
        await cmdTree(execId)
        if (runId) {
          const ev = join(STATE_DIR, 'ticket', runId, 'events.jsonl')
          for (const l of text(ev).split('\n').filter(Boolean).slice(-5)) {
            try {
              const e = JSON.parse(l)
              console.log(
                JSON.stringify({
                  role: e.role,
                  model: e.model,
                  step_id: e.step_id,
                  attempt: e.attempt,
                  cost_usd: e.cost_usd,
                  cache_read_tokens: e.cache_read_tokens,
                }),
              )
            } catch {
              /* skip */
            }
          }
        }
        return 0
      }
      return cmdRunControl(sub, [execId, '--tree'])
    }
    default:
      return die(
        'usage: yk ticket new "<text>" [--dry-run] | from-plan <plan> [--dry-run] | run <issue> [--detach [--notify]] | worktree <issue> [--branch B] [--in DIR] | pr <issue> [--title T] | release <issue> | report [--json] | status|resume|stop <issue|execution>',
      )
  }
}
