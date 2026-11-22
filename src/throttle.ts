// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// The load supervisor: while the machine is short of CPU or RAM, the live runs of the dogfood session are paused, and the ones it paused are resumed when the load is gone.
// It uses the run controls of the server (pause|resume ?tree=true), so every workflow of the session is covered, now and later, with nothing wired into a workflow.
// A paused run keeps the node it is in (a Gradle task finishes); only the next node waits. A run somebody else paused is never resumed here.
import { freemem, loadavg, availableParallelism, totalmem } from 'node:os'
import { DEV_URL, STATE_DIR, checkSession, http, join, mkdirp, readFileSync, rmSync, sleep, text, tryJson, writeFileSync } from './lib.ts'
import { type Agent, agent, answerReviews, attachGuard, detachGuard, directives, logLine, readyPath, retrying, saveGuard } from './guard.ts'
import { tryLock } from './server.ts'

export type Sample = { cpu: number; ramFree: number } // cpu: 1-minute load per core; ramFree: available memory as a fraction of the total
export type Cfg = { pauseCpu: number; resumeCpu: number; pauseRam: number; resumeRam: number; hold: number; interval: number }
export type State = { paused: boolean; streak: number }

const num = (k: string, d: number): number => (Number.isFinite(Number(process.env[k])) && process.env[k] ? Number(process.env[k]) : d)
export const config = (): Cfg => ({
  pauseCpu: num('YK_THROTTLE_PAUSE_CPU', 1.5),
  resumeCpu: num('YK_THROTTLE_RESUME_CPU', 0.9),
  pauseRam: num('YK_THROTTLE_PAUSE_RAM', 0.1),
  resumeRam: num('YK_THROTTLE_RESUME_RAM', 0.2),
  hold: num('YK_THROTTLE_HOLD', 3), // samples in a row before the supervisor acts, so a spike does not flap the runs
  interval: num('YK_THROTTLE_INTERVAL', 10),
})

export function sample(): Sample {
  let avail = freemem()
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8')) // freemem() counts the page cache as used on Linux
    if (m) avail = Number(m[1]) * 1024
  } catch {
    /* not Linux */
  }
  return { cpu: loadavg()[0]! / availableParallelism(), ramFree: avail / totalmem() }
}

/** The next state and what to do with the runs. Pausing needs `hold` samples in a row over a limit, resuming `hold` in a row under both resume limits. */
export function decide(s: State, x: Sample, c: Cfg): { state: State; act: 'pause' | 'resume' | 'none' } {
  const want = s.paused ? x.cpu < c.resumeCpu && x.ramFree > c.resumeRam : x.cpu > c.pauseCpu || x.ramFree < c.pauseRam
  const streak = want ? s.streak + 1 : 0
  if (streak < c.hold) return { state: { ...s, streak }, act: 'none' }
  return { state: { paused: !s.paused, streak: 0 }, act: s.paused ? 'resume' : 'pause' }
}

export type Io = {
  sample: () => Sample
  live: () => Promise<{ id: string; paused: boolean; start: number }[]> // the root runs of the dogfood session that are running, any order
  control: (verb: 'pause' | 'resume', id: string) => Promise<boolean>
  log: (msg: string) => void
}

/** One tick. `mine` is the set of runs this supervisor paused. Returns the new state. */
export async function tick(s: State, mine: Set<string>, c: Cfg, io: Io): Promise<State> {
  const x = io.sample()
  const d = decide(s, x, c)
  const runs = (await io.live()).sort((a, b) => a.start - b.start) // oldest first
  for (const id of [...mine]) if (!runs.some((r) => r.id === id && r.paused)) mine.delete(id) // ended, or somebody resumed it
  const what = `cpu ${x.cpu.toFixed(2)}/core, ram free ${(x.ramFree * 100).toFixed(0)}%`
  if (d.act === 'resume' || (!d.state.paused && mine.size)) {
    for (const r of runs.filter((r) => mine.has(r.id))) if (await io.control('resume', r.id)) mine.delete(r.id) // the oldest first
    io.log(`resumed: ${what}`)
  } else if (d.state.paused) {
    // the oldest run we may touch keeps going so it finishes first; the others (also the ones that start meanwhile) wait
    const keep = runs.find((r) => !r.paused || mine.has(r.id))
    if (keep && mine.has(keep.id) && (await io.control('resume', keep.id))) mine.delete(keep.id)
    for (const r of runs.filter((r) => !r.paused && r !== keep)) if (await io.control('pause', r.id)) mine.add(r.id)
    if (d.act === 'pause') io.log(`paused ${mine.size} run(s), the oldest keeps running: ${what}`)
  }
  return d.state
}

/** Best effort: resume every run in `mine`; the ones that fail stay in it. */
export async function release(mine: Set<string>, io: Io): Promise<void> {
  for (const id of [...mine]) if (await io.control('resume', id).catch(() => false)) mine.delete(id)
}

const headers = (): Record<string, string> => (process.env.YUKTA_TOKEN ? { 'X-API-Key': process.env.YUKTA_TOKEN } : {})
export const get = async (path: string): Promise<any> => {
  const r = await http('GET', `${process.env.YUKTA_SERVER_URL ?? DEV_URL}${path}`, { headers: headers(), timeoutMs: 15000 })
  if (r.code === 0) throw new Error('the server is not reachable') // the loop ends with the server (the next yk run starts it again)
  const j = r.code === 200 ? tryJson(r.body) : null
  return j && typeof j === 'object' && 'data' in j ? j.data : j
}
export const live: Io['live'] = async () => {
  const all: any[] = (await get('/api/executions?limit=1000')) ?? []
  const roots = all.filter((e) => e.sessionId === checkSession() && e.status === 'RUNNING' && e.parentExecutionId == null)
  return Promise.all(
    roots.map(async (e) => ({
      id: e.executionId as string,
      paused: (await get(`/api/executions/${e.executionId}`))?.controlState === 'PAUSED',
      start: Date.parse(e.startTime) || Infinity, // unknown start: treated as the newest
    })),
  )
}
/** The Io of the guard: the load is sampled here, and pause/resume go out as directives of the supervisor (the run and the runs it started). */
export function guardIo(a: Agent): Io {
  let why = ''
  return {
    sample: () => {
      const x = sample()
      why = `cpu ${x.cpu.toFixed(2)}/core, ram free ${(x.ramFree * 100).toFixed(0)}%`
      return x
    },
    live,
    control: async (verb, id) => {
      const all: any[] = (await get('/api/executions?limit=1000')) ?? []
      const tree = [id]
      for (let i = 0; i < tree.length; i++)
        for (const e of all) if (e.parentExecutionId === tree[i] && e.status === 'RUNNING') tree.push(e.executionId)
      return directives(a, verb, tree, why)
    },
    log: logLine,
  }
}

export const lockPath = (): string => join(STATE_DIR, 'throttle.lock')
const minePath = (): string => join(STATE_DIR, 'throttle.json')

/** yk throttle [--once]: the loop (one tick with --once). Runs it paused by itself are kept in throttle.json, so a restart of the loop still resumes them.
 * Without `io` it is the decision maker of the guard supervisor: it saves it, takes the credential, attaches it to the runs and answers the reviews while it runs. */
/** How long the loop waits for a server that is down or has lost the guard before it gives up (yk up and the next run start it again). */
const GIVE_UP_MS = 10 * 60_000

/** Saves the guard, takes its credential, attaches it to the runs and says it is ready. The cursor is taken before the attach, so no review is missed. */
async function connect(): Promise<{ a: Agent; cursor: number }> {
  const a = agent(DEV_URL, await saveGuard())
  const cursor = tryJson((await a.call('GET', '/snapshot')).body)?.data?.cursor ?? 0
  await attachGuard()
  writeFileSync(readyPath(), String(Date.now()))
  return { a, cursor }
}

export async function cmdThrottle(argv: string[], io?: Io): Promise<number> {
  const c = config()
  if (argv.includes('--once')) c.hold = 1
  const once = argv.includes('--once')
  mkdirp(STATE_DIR)
  if (!once && !tryLock(lockPath())) return (console.log('throttle: already running'), 0)
  rmSync(readyPath(), { force: true })
  let stopped = false
  const own = !io
  // Set while the guard is the decision maker: a server restart loses the guard (and its credential), so it is saved and attached again instead of the loop ending.
  let reconnect: () => Promise<boolean> = async () => false
  if (!io) {
    try {
      let link = await connect()
      // the agent the Io and the reviews hold; a reconnect swaps what is behind it
      const via: Agent = { call: (m, p, b) => link.a.call(m, p, b), token: () => link.a.token() }
      let pending: Promise<boolean> | undefined
      reconnect = () =>
        (pending ??= retrying(
          connect,
          () => stopped,
          (e) => logLine(`the guard is not reachable: ${e.message}`),
          GIVE_UP_MS,
        )
          .then((l) => {
            if (!l) {
              stopped = true // the server stayed away: yk up or the next run starts the loop again
              return false
            }
            link = l
            logLine('the guard is attached again')
            return true
          })
          .finally(() => (pending = undefined)))
      void (async () => {
        while (!stopped) {
          try {
            return await answerReviews(via, () => stopped, link.cursor)
          } catch (e) {
            if (stopped) return
            logLine(`reviews: ${(e as Error).message}`)
            if (!(await reconnect())) return
          }
        }
      })()
      io = guardIo(via)
    } catch (e) {
      logLine(`the guard did not start: ${(e as Error).message}`)
      writeFileSync(readyPath(), 'failed') // yk stops waiting for it
      return 0
    }
  }
  const mine = new Set<string>((tryJson(text(minePath())) as string[] | null) ?? [])
  let s: State = { paused: mine.size > 0, streak: 0 }
  try {
    do {
      try {
        s = await tick(s, mine, c, io)
      } catch (e) {
        io.log((e as Error).message)
        await release(mine, io) // never leave the runs we paused behind a dead loop
        writeFileSync(minePath(), JSON.stringify([...mine])) // what could not be resumed (server down) is resumed by the next start
        if (once || !(await reconnect())) return 0
        continue // the server is back and the guard attached again
      }
      writeFileSync(minePath(), JSON.stringify([...mine]))
      if (!once) await sleep(c.interval * 1000)
    } while (!once && !stopped)
  } finally {
    stopped = true
    // unless YK_THROTTLE=off the guard stays attached (detach and attach restart its engines, see saveGuard) and the next yk command starts the loop again; otherwise nobody would answer its reviews
    if (own && process.env.YK_THROTTLE === 'off') await detachGuard().catch(() => {})
  }
  return 0
}
