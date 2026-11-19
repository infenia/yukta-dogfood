// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// The resource guard: an `http` supervisor of Yukta that owns the run level of every workflow of the dogfood session. This process is its decision maker:
// throttle.ts decides (CPU/RAM), and pause/resume go out as directives that the server checks (ownership, allow-list, reason, rate limit) and audits.
// Because the guard owns the run level, a person's own start/stop/pause on those runs (yk, yukta-cli, the UI) is a review that this process answers within
// the 5 s the server waits (on a timeout everything but a stop is refused), so `yk` starts the loop first and waits for `guard.ready` (server.ts).
import { appendFileSync } from 'node:fs'
import { DEV_URL, STATE_DIR, join, mkdirp, sleep, text, tryJson } from './base.ts'
import { checkSession, http, keyHeader } from './client.ts'

export const GUARD = 'dogfood-resource-guard'
export const ADVICE = 'dogfood-ticket-advice'
const KIT = join(import.meta.dir, '..')
export const readyPath = (): string => join(STATE_DIR, 'guard.ready')
const JSON_H = { 'Content-Type': 'application/json' }

type Wfs = Record<string, { nodes?: { nodeId: string; type: string }[] }>
const workflows = (file: string): Wfs => tryJson(text(join(KIT, file)))?.workflows ?? {}

/** The run level of every workflow of the session (the generated session files), so a new workflow is covered the next time the guard starts. */
export const runTargets = (s = checkSession()): string[] =>
  [...new Set([...Object.keys(workflows('session.json')), ...Object.keys(workflows('ticket-session.json'))])].map((w) => `run:${s}/${w}`)

/** What the ticket-advice supervisor keeps: only the ASK_INPUT nodes (a unit has one owner, and the guard has the run level). */
export function askTargets(s = checkSession()): string[] {
  return Object.entries(workflows('ticket-session.json')).flatMap(([w, d]) => {
    const ids = (d.nodes ?? []).filter((n) => n.type === 'ASK_INPUT').map((n) => n.nodeId)
    return ids.length ? [`workflow:${s}/${w}//${ids.join(',')}`] : []
  })
}

const admin = (base: string, method: string, path: string, body?: unknown) =>
  http(method, base + path, {
    headers: { ...keyHeader(), ...JSON_H },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 20000,
  })
const ok = (what: string, r: { code: number; body: string }): void => {
  if (r.code < 200 || r.code >= 300) throw new Error(`${what}: HTTP ${r.code} ${r.body.slice(0, 200)}`)
}

/** ticket-advice keeps only its question nodes. Must run before the guard is attached (409 OWNERSHIP_CONFLICT otherwise). Nothing to do when it is not installed. */
export async function narrowAdvice(base = DEV_URL): Promise<void> {
  if ((await admin(base, 'GET', `/api/supervisors/${ADVICE}`)).code !== 200) return
  ok(
    'ticket-advice assignments',
    await admin(
      base,
      'PUT',
      `/api/supervisors/${ADVICE}/assignments`,
      askTargets().map((target) => ({ target })),
    ),
  )
}

/** Saves the supervisor and issues its credential. Nothing is written when the stored supervisor is the same: a save restarts its engine, whose review ids begin at r1 again
 * while the server still remembers the ones it answered, so the first reviews after a restart would be refused (409) and the people's commands wait out the 5 s. */
/** JSON with the keys of every object sorted: the server returns settings in its own key order. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x,
  )
export async function saveGuard(base = DEV_URL, dir = join(KIT, 'supervisor')): Promise<string> {
  await narrowAdvice(base)
  const def = tryJson(text(join(dir, 'resource-guard.json')))
  const have = await admin(base, 'GET', `/api/supervisors/${GUARD}`)
  const same = have.code === 200 && canon(tryJson(have.body)?.data?.settings) === canon(def.settings)
  if (!same) {
    let r =
      have.code === 200 ? await admin(base, 'PUT', `/api/supervisors/${GUARD}`, def) : await admin(base, 'POST', '/api/supervisors', def)
    if (r.code === 409) r = await admin(base, 'PUT', `/api/supervisors/${GUARD}`, def)
    ok('supervisor', r)
  }
  return issueCredential(base)
}
export async function issueCredential(base = DEV_URL): Promise<string> {
  const c = await admin(base, 'POST', `/api/supervisors/${GUARD}/credential?ttlHours=24`)
  ok('credential', c)
  const token = tryJson(c.body)?.data?.token
  if (typeof token !== 'string' || !token) throw new Error('credential: no token in the answer')
  return token
}
/** Assigns the runs; a list that is already there is left alone (an assignment is an engine too, see saveGuard). */
export async function attachGuard(base = DEV_URL): Promise<void> {
  const want = runTargets().sort()
  const have = await admin(base, 'GET', `/api/supervisors/${GUARD}/assignments`)
  const now: string[] = (tryJson(have.body)?.data ?? [])
    .filter((a: { source?: string }) => a.source === 'MANUAL')
    .map((a: { scope: string }) => a.scope)
    .sort()
  if (have.code === 200 && JSON.stringify(now) === JSON.stringify(want)) return
  ok(
    'guard assignments',
    await admin(
      base,
      'PUT',
      `/api/supervisors/${GUARD}/assignments`,
      want.map((target) => ({ target })),
    ),
  )
}
/** Takes the guard off the runs (YK_THROTTLE=off): nobody would answer its reviews. Best effort, nothing happens when it is not installed. */
export const detachGuard = async (base = DEV_URL): Promise<void> => {
  await admin(base, 'PUT', `/api/supervisors/${GUARD}/assignments`, [])
}

export type Agent = { call: (method: string, path: string, body?: unknown) => Promise<{ code: number; body: string }>; token: () => string }
/** The agent API with the credential; a 401 (expired, or rotated) issues a new one once and retries. */
export function agent(base: string, first: string): Agent {
  let token = first
  const once = (method: string, path: string, body?: unknown) =>
    http(method, `${base}/api/agent/v1${path}`, {
      headers: { Authorization: `Bearer ${token}`, ...JSON_H },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 35000,
    })
  return {
    token: () => token,
    call: async (method, path, body) => {
      const r = await once(method, path, body)
      if (r.code !== 401) return r
      token = await issueCredential(base)
      return once(method, path, body)
    },
  }
}

/** pause/resume of a run and the runs it started (a directive has no `tree`, so one per execution). `why` is the reason the audit shows. */
export async function directives(
  a: Agent,
  verb: 'pause' | 'resume',
  tree: string[],
  why: string,
  now = () => Date.now(),
): Promise<boolean> {
  let all = true
  for (const executionId of tree) {
    const r = await a.call('POST', '/directives', {
      key: `${verb}-${executionId}-${now()}`,
      cause: 'initiative',
      reason: `${verb} by the resource guard: ${why}`,
      command: { type: verb === 'pause' ? 'PauseWorkflow' : 'ResumeWorkflow', executionId },
    })
    if (r.code < 200 || r.code >= 300) {
      // accepted: the HTTP status is 200 (202 is in the body); applied or refused later, see the decisions
      console.error(`guard: ${verb} ${executionId.slice(0, 8)}: HTTP ${r.code} ${r.body.slice(0, 120)}`)
      all = false
    }
  }
  return all
}

/** Answers the reviews of the people's commands with ALLOW (the guard stops nobody), until `stop()` says so. Throws when the server cannot be reached. */
export async function answerReviews(a: Agent, stop: () => boolean, after: number): Promise<void> {
  while (!stop()) {
    const r = await a.call('GET', `/signals?after=${after}&wait=25`)
    if (r.code === 0) throw new Error('the server is not reachable')
    const b = r.code === 200 ? tryJson(r.body)?.data : null
    if (!b) {
      await sleep(2000) // not a batch (a 5xx): do not spin
      continue
    }
    after = b.cursor ?? after
    for (const e of b.signals ?? [])
      if (e.kind === 'REVIEW')
        await a.call('POST', `/reviews/${e.signal.id}`, {
          verdict: 'ALLOW',
          reason: 'a person’s own command; the guard only pauses for load',
        })
  }
}

export const logPath = (): string => join(STATE_DIR, 'guard.log')
/** The loop is detached with no terminal: what it says goes to a file too. */
export function logLine(msg: string): void {
  console.log(`throttle: ${msg}`)
  try {
    mkdirp(STATE_DIR)
    appendFileSync(logPath(), `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* the log is a convenience */
  }
}
