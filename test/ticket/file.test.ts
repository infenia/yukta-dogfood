// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// Offline test of filing (yk ticket new / from-plan): the generated ticket-new and ticket-from-plan workflows walked against a throwaway repo, a fake
// claude (analyst, architect) and a fake gh; the filed body is a ticket spec the run takes as it is.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { KIT, World, json, kit, put, read } from './helpers.ts'
import { parseTicket } from '../../src/ticket/body.ts'

setDefaultTimeout(600_000)
let w: World
beforeAll(() => {
  w = new World()
})
afterAll(() => w.cleanup())

async function file(
  wf: string,
  request: Record<string, unknown>,
  mode = 'happy',
  env: Record<string, string> = {},
): Promise<{ rc: number; out: string; dir: string }> {
  const dir = join(w.d, `filing-${wf}-${mode}`)
  put(join(dir, 'request.json'), { project: w.repo, ...request })
  put(join(w.d, 'mode'), mode)
  put(join(w.d, 'body'), '')
  put(join(w.d, 'gh.log'), '')
  const payload = { project: w.repo, dir, runId: 'new-1', claudeBin: join(w.d, 'claude') }
  put(join(dir, 'payload.json'), payload)
  const p = Bun.spawn(
    [process.execPath, join(KIT, 'src/ticket/walk-workflow.ts'), join(KIT, 'ticket-session.json'), wf, join(dir, 'payload.json')],
    {
      env: { ...process.env, ...env } as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [out, err, rc] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { rc, out: out + err, dir }
}

test('yk ticket new: analyst, architect, one issue in Backlog whose body is the whole spec', async () => {
  const r = await file('ticket-new', { text: 'Limit requests per client to 100 a minute' })
  expect(r.rc, r.out).toBe(0)
  expect(r.out).toContain('NODE ask? plan')
  expect(json(join(r.dir, 'filed.json')).numbers).toEqual([20])
  const gh = read(join(w.d, 'gh.log'))
  expect(gh).toContain('issue create -R infenia/yukta --title feat(core): rate limiter')
  expect(gh).toContain('--label type/feature')
  expect(gh).toContain('--assignee @me')
  expect(gh, 'on the board in Backlog').toContain('project item-edit')
  const body = parseTicket(read(join(w.d, 'filed-20.md')))
  expect(body.errors).toEqual([])
  expect(body.ticket.steps[0].write_files).toEqual(['core/src/main/java/A.java'])
  expect(body.ticket.base_sha, 'the base the spec was written against').toMatch(/^[0-9a-f]{12}$/)
})

test('yk ticket new: an open question goes to a person first and the answer reaches the architect', async () => {
  const r = await file('ticket-new', { text: 'Limit requests', dryRun: true }, 'ask', { TEST_ANSWER: 'per client' })
  expect(r.rc, r.out).toBe(0)
  expect(r.out).toContain('NODE ask? ask')
  expect(r.out).toContain('ASK ask_analyst')
  expect(read(join(r.dir, 'answers.txt'))).toBe('per client')
  const body = parseTicket(read(join(r.dir, 'ticket-0.md')))
  expect(body.ticket.decisions).toContain('Answered: per client')
  expect(read(join(w.d, 'gh.log')), 'a dry run files nothing').not.toContain('issue create')
})

test('yk ticket from-plan: one issue per ticket, in order, the later one depends on the earlier', async () => {
  put(join(w.repo, 'design/plans/limits.md'), '# Limits\n\nA limiter, then its docs.\n')
  const r = await file('ticket-from-plan', { plan: 'design/plans/limits.md' })
  expect(r.rc, r.out).toBe(0)
  expect(json(join(r.dir, 'filed.json')).numbers).toEqual([20, 21])
  const second = parseTicket(read(join(w.d, 'filed-21.md')))
  expect(second.errors).toEqual([])
  expect(second.ticket.depends_on).toEqual([20])
  expect(second.ticket.plan_file).toBe('design/plans/limits.md')
  expect(read(join(w.d, 'gh.log'))).toContain('--label type/docs')
})

test('a drafts answer that breaks the check is refused, so nothing is filed', () => {
  const dir = join(w.d, 'filing-bad')
  put(join(dir, 'request.json'), { project: w.repo, text: 'x' })
  const d = json(join(KIT, 'fixtures/ticket-drafts/valid.json'))
  const r = kit(['file', 'check', dir, join(dir, 'drafts.json')])
  expect(r.code, 'no draft file').not.toBe(0)
  put(join(dir, 'drafts.json'), d)
  const c = kit(['file', 'check', dir, join(dir, 'drafts.json')])
  expect(c.code).not.toBe(0)
  expect(c.out).toContain('not a project command template')
  expect(c.out).toMatch(/errors=[1-9]/)
})
