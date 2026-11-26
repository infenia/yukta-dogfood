// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// The resource guard: what it owns, the order of the install, the directives it sends and the reviews it answers (against a fake server).
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { ADVICE, GUARD, agent, answerReviews, directives, guardDef, runTargets, saveGuard } from '../src/guard.ts'

const root = join(import.meta.dir, '..')
const wfs = (f: string): string[] => Object.keys(require(join(root, f)).workflows)

test('the guard owns the run level of every workflow of both session files', () => {
  const run = runTargets('dogfood')
  for (const w of [...wfs('session.json'), ...wfs('ticket-session.json')]) expect(run, w).toContain(`run:dogfood/${w}`)
})

test('resource-guard.json: an http supervisor that may pause/resume and lets people start, stop and restart', () => {
  const d = require(join(root, 'supervisor', 'resource-guard.json'))
  expect(d.id).toBe(GUARD)
  expect(d.type).toBe('http')
  expect(d.settings.allowedCommands).toEqual(['PauseWorkflowCommand', 'ResumeWorkflowCommand'])
  expect(d.settings.initiative).toEqual(d.settings.allowedCommands)
  for (const c of ['StartWorkflowCommand', 'StopWorkflowCommand', 'RestartCommand', 'RecoverCommand'])
    expect(d.settings.operatorAccess).toContain(c)
})

type Seen = { method: string; path: string; body: string; auth: string | null }
function fake(handler: (s: Seen) => Response | undefined = () => undefined) {
  const seen: Seen[] = []
  const srv = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const s = {
        method: req.method,
        path: new URL(req.url).pathname + new URL(req.url).search,
        body: await req.text(),
        auth: req.headers.get('authorization'),
      }
      seen.push(s)
      return handler(s) ?? Response.json({ data: { token: 'yag_x' } }, { status: 200 })
    },
  })
  return { seen, srv, url: `http://127.0.0.1:${srv.port}` }
}

const def = require(join(root, 'supervisor', 'resource-guard.json'))
const line = (s: Seen): string => `${s.method} ${s.path}`

test('saveGuard: an old ticket-advice is deleted first; a stored guard that differs is replaced; the credential comes back', async () => {
  const f = fake((s) => (line(s) === `GET /api/supervisors/${GUARD}` ? Response.json({ data: { settings: { old: true } } }) : undefined))
  try {
    expect(await saveGuard(f.url, join(root, 'supervisor'), false)).toBe('yag_x')
    expect(f.seen.map(line)).toEqual([
      `GET /api/supervisors/${ADVICE}`,
      `DELETE /api/supervisors/${ADVICE}`,
      `GET /api/supervisors/${GUARD}`,
      `PUT /api/supervisors/${GUARD}`,
      `POST /api/supervisors/${GUARD}/credential?ttlHours=24`,
    ])
  } finally {
    f.srv.stop(true)
  }
})

test('guardDef: onReviewTimeout ALLOW only for a server that knows the setting', () => {
  const dir = join(root, 'supervisor')
  expect(guardDef(dir, false).settings.onReviewTimeout).toBeUndefined()
  expect(guardDef(dir, true).settings).toEqual({ ...def.settings, onReviewTimeout: 'ALLOW' })
})

test('saveGuard: a lenient guard is saved with onReviewTimeout ALLOW', async () => {
  const f = fake((s) =>
    s.path.endsWith(ADVICE) || line(s) === `GET /api/supervisors/${GUARD}` ? new Response('{}', { status: 404 }) : undefined,
  )
  try {
    await saveGuard(f.url, join(root, 'supervisor'), true)
    const post = f.seen.find((s) => line(s) === 'POST /api/supervisors')
    expect(JSON.parse(post!.body).settings.onReviewTimeout).toBe('ALLOW')
  } finally {
    f.srv.stop(true)
  }
})

test('saveGuard: the same stored guard (the server orders the keys its own way) is not written again (a save restarts its engine)', async () => {
  const f = fake((s) =>
    s.path.endsWith(ADVICE)
      ? new Response('{}', { status: 404 })
      : line(s) === `GET /api/supervisors/${GUARD}`
        ? Response.json({ data: { settings: Object.fromEntries(Object.entries(def.settings).reverse()) } })
        : undefined,
  )
  try {
    await saveGuard(f.url, join(root, 'supervisor'), false)
    expect(f.seen.map(line)).toEqual([
      `GET /api/supervisors/${ADVICE}`,
      `GET /api/supervisors/${GUARD}`,
      `POST /api/supervisors/${GUARD}/credential?ttlHours=24`,
    ])
  } finally {
    f.srv.stop(true)
  }
})

test('saveGuard: a new guard is created, and a refusal throws', async () => {
  const f = fake((s) =>
    s.method === 'GET'
      ? new Response('{}', { status: 404 })
      : s.path === '/api/supervisors'
        ? new Response('no', { status: 400 })
        : undefined,
  )
  try {
    await expect(saveGuard(f.url, join(root, 'supervisor'), false)).rejects.toThrow('supervisor: HTTP 400')
    expect(f.seen.map(line)).toEqual([`GET /api/supervisors/${ADVICE}`, `GET /api/supervisors/${GUARD}`, 'POST /api/supervisors'])
  } finally {
    f.srv.stop(true)
  }
})

test('directives: one pause/resume per execution of the tree, a fresh key and a reason with the load; a refusal is reported', async () => {
  let n = 0
  const f = fake((s) =>
    s.body.includes('"c2"') ? new Response('no', { status: 409 }) : Response.json({ status: 202, message: 'Directive accepted' }),
  )
  try {
    const a = agent(f.url, 'yag_t')
    expect(await directives(a, 'pause', ['r1', 'c1'], 'cpu 2.00/core', () => ++n)).toBe(true)
    const b = f.seen.map((s) => JSON.parse(s.body))
    expect(b[0]).toMatchObject({ key: 'pause-r1-1', cause: 'initiative', command: { type: 'PauseWorkflow', executionId: 'r1' } })
    expect(b[0].reason).toContain('cpu 2.00/core')
    expect(b[1].key).toBe('pause-c1-2')
    expect(f.seen[0]!.auth).toBe('Bearer yag_t')
    expect(await directives(a, 'resume', ['c2'], 'calm')).toBe(false)
    expect(JSON.parse(f.seen.at(-1)!.body).command.type).toBe('ResumeWorkflow')
  } finally {
    f.srv.stop(true)
  }
})

test('answerReviews: ALLOW for a review, nothing for the other signals; a 401 takes a new credential once', async () => {
  let polls = 0
  let stop = false
  const f = fake((s) => {
    if (s.path.startsWith('/api/agent/v1/signals')) {
      if (s.auth === 'Bearer old') return new Response('{}', { status: 401 })
      polls++
      stop = true
      return Response.json({
        data: {
          cursor: 9,
          signals: [
            { cursor: 8, kind: 'EVENT', signal: { id: 'e1' } },
            { cursor: 9, kind: 'REVIEW', signal: { id: 'r-77' } },
          ],
        },
      })
    }
    return undefined
  })
  try {
    await answerReviews(agent(f.url, 'old'), () => stop, 3)
    expect(polls).toBe(1)
    const posts = f.seen.filter((s) => s.method === 'POST')
    expect(posts.map((s) => s.path)).toEqual([
      `/api/supervisors/${GUARD}/credential`.replace('/credential', '/credential?ttlHours=24'),
      '/api/agent/v1/reviews/r-77',
    ])
    expect(JSON.parse(posts[1]!.body).verdict).toBe('ALLOW')
    expect(posts[1]!.auth).toBe('Bearer yag_x')
  } finally {
    f.srv.stop(true)
  }
})
