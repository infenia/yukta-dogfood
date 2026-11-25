// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// ticketkit init ISSUE | --ticket-file F [--root R] [--state-dir D] [--base REF] [--no-worktree] [--run-id ID]
//
// Creates .yukta-dev/ticket/<run_id>/ (design section 4), branch issue/<n> and worktree ../yukta-issue-<n>.
// Prints RUN_DIR=... and WORKTREE=...; prints SKIPPED <why> and exits 3 when the run must not start (no acceptance criteria, branch or
// worktree exists, unless `yk ticket worktree` marked it to be continued): no tokens are spent. Only the acceptance criteria count as requirements; the rest of the issue is data.
// A body that is a whole ticket spec (body.ts, written at filing time and reviewed by a person) becomes spec/spec.json, so the run skips the architect;
// only for an issue assigned to the person running the pipeline: the spec's done_when commands run as shell.
import { attach, isReleased, takeContinue } from './branch.ts'
import { parseTicket, specOf } from './body.ts'
import { atBase, stubPatch } from './stubs.ts'
import { rolesOf } from './roles.ts'
import { measure, sizingOf, trackedFiles } from './sizing.ts'
import {
  type Json,
  KIT,
  die,
  ticketType,
  existsSync,
  git,
  join,
  load,
  mkdirp,
  parseArgs,
  resolve,
  run,
  save,
  writeFileSync,
} from './lib.ts'

/** The list items under an 'Acceptance criteria' heading, up to the next heading. */
export function criteria(body: string | null | undefined): string[] {
  const out: string[] = []
  let on = false
  for (const line of (body ?? '').split(/\r?\n/)) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      on = /acceptance criteria/i.test(line)
      continue
    }
    const m = /^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)/.exec(line)
    if (on && m) out.push(m[1]!.trim())
  }
  return out
}

const stamp = (): string =>
  new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')

export function main(argv: string[]): number {
  const { pos, opt, flag } = parseArgs(argv, { value: ['ticket-file', 'root', 'state-dir', 'base', 'run-id'], bool: ['no-worktree'] })
  const issue = pos[0]
  if (Boolean(issue) === Boolean(opt['ticket-file'])) die('usage: ticketkit init ISSUE | --ticket-file F')
  const root = resolve(opt.root ?? git(['rev-parse', '--show-toplevel']).stdout.trim())
  let raw: Json
  if (opt['ticket-file']) raw = load(opt['ticket-file'])
  else {
    const r = run(['gh', 'issue', 'view', issue!, '--json', 'number,title,body,labels,assignees'])
    if (r.code) die(`gh issue view ${issue}: ${r.stderr.trim()}`)
    raw = JSON.parse(r.stdout)
    // the body is data: only an issue assigned to the person running the pipeline may choose the models (cost), as intake already requires
    const me = run(['gh', 'api', 'user', '-q', '.login']).stdout.trim()
    if (!(raw.assignees ?? []).some((a: Json) => a.login === me)) {
      if (Object.keys(rolesOf(raw.body)).length || sizingOf(raw.body).sizing)
        console.error(`NOTE issue ${issue} is not assigned to ${me || 'you'}: its Pipeline roles and Sizing are ignored`)
      raw.body_roles_untrusted = true
    }
  }
  const labels: string[] = (raw.labels ?? []).map((l: Json) => (typeof l === 'object' ? l.name : l))
  const project = load(join(KIT, 'project.json'))
  const ac = criteria(raw.body)
  const n = String(raw.number)
  if (!ac.length) {
    console.log('SKIPPED no acceptance criteria')
    return 3
  }
  const branch = project.git.branch.replaceAll('{n}', n)
  const wt = resolve(root, project.git.worktree.replaceAll('{n}', n))
  // a released worktree at the path (a failed run's, see releaseFailed) is taken over by attach; one that `yk ticket worktree` marked is continued
  let resume = false
  if (git(['rev-parse', '--verify', '-q', branch], { cwd: root, check: false }).code === 0 || (existsSync(wt) && !isReleased(wt))) {
    const why = flag.has('no-worktree')
      ? 'no worktree wanted'
      : takeContinue(wt, branch, git(['rev-parse', opt.base ?? 'origin/main'], { cwd: root }).stdout.trim())
    if (why) {
      console.log(`SKIPPED branch ${branch} or worktree ${wt} exists (${why})`)
      return 3
    }
    resume = true
    console.error(`NOTE continuing branch ${branch} in ${wt}`)
  }
  let runId: string = opt['run-id'] ?? `${n}-${stamp()}`
  const state = opt['state-dir'] ?? process.env.YUKTA_DEV_STATE_DIR ?? join(root, '.yukta-dev')
  const baseId = runId
  let k = 1
  if (opt['run-id'] && existsSync(join(state, 'ticket', runId))) die(`run ${runId} exists`)
  while (existsSync(join(state, 'ticket', runId))) runId = `${baseId}-${++k}` // two runs of one issue in the same second
  const dir = join(state, 'ticket', runId)
  for (const d of ['spec', 'steps', 'review']) mkdirp(join(dir, d))
  const parsed = raw.body_roles_untrusted ? null : parseTicket(raw.body ?? '')
  const planned = parsed && !parsed.errors.length ? parsed.ticket : null
  if (parsed && !planned && /^##\s+Steps\b/m.test(raw.body ?? ''))
    console.error(`NOTE the body's spec is not valid (${parsed.errors.slice(0, 3).join('; ')}): the architect writes one`)
  if (planned) {
    const spec = specOf(planned, n)
    save(join(dir, 'spec', 'spec.json'), spec)
    save(join(dir, 'spec', 'spec.v1.json'), spec)
    // the body's stubs (the files the tests compile against) become the scaffold patch, made on a clean tree of the base
    let patch = ''
    try {
      patch = atBase(root, opt.base ?? 'origin/main', (wt) => stubPatch(wt, planned.stubs))
    } catch (e) {
      console.error(`NOTE the stubs could not be turned into a patch (${(e as Error).message}): the run goes on without them`)
    }
    writeFileSync(join(dir, spec.scaffold_patch), patch)
    console.error(
      `NOTE the spec comes from the issue body (${planned.steps.length} steps${planned.base_sha ? `, written against ${planned.base_sha}` : ''})`,
    )
  }
  const modules = [...new Set(labels.filter((l) => l in project.module_labels))].sort()
  const base = opt.base ?? 'origin/main'
  // the sizing facts, checked against the tree the run starts from; a bad item is dropped with a note (the router then has less to go on, never less safety)
  const sz = raw.body_roles_untrusted ? { sizing: null, errors: [] } : sizingOf(raw.body)
  for (const e of sz.errors) console.error(`NOTE ${e}: ignored`)
  const tracked = sz.sizing ? trackedFiles(root, base) : null
  if (sz.sizing && !tracked) console.error(`NOTE cannot list ${base}: sizing files are counted as written`)
  const sizing = sz.sizing ? measure(sz.sizing, tracked) : null
  if (sizing?.unmatched.length) console.error(`NOTE sizing globs match nothing in ${base}: ${sizing.unmatched.join(', ')}`)
  save(join(dir, 'ticket.json'), {
    ticket_id: n,
    title: raw.title,
    type: planned ? planned.type : ticketType(raw.title, labels),
    planned: planned ? { complexity: planned.complexity, risk: planned.risk, tests_mode: planned.tests_mode } : null,
    labels,
    modules,
    acceptance_criteria: ac,
    roles: raw.body_roles_untrusted ? {} : rolesOf(raw.body),
    sizing,
    body: raw.body ?? '',
    allow_guard_paths: labels.includes('build') || labels.includes('dogfood'),
  })
  save(join(dir, 'project.json'), project)
  writeFileSync(join(dir, 'events.jsonl'), '', { flag: 'a' })
  if (!flag.has('no-worktree') && !resume) {
    attach(root, wt, branch, base, false) // takes over a released worktree (branch.ts) before adding one
  }
  console.log(`RUN_DIR=${dir}\nWORKTREE=${wt}\nRUN_ID=${runId}`)
  return 0
}
