// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// One resource guard per machine: the lock lives in DEV_HOME, a stale or reused pid is no holder, and a 401 or 429 backs off instead of looping.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { spawn } from 'bun'
import { agent, backoff } from '../src/guard.ts'
import { holds, startOf, tryLock } from '../src/server.ts'
import { put, read, rm, tmp } from './helpers.ts'

let d: string
beforeAll(() => (d = tmp()))
afterAll(() => rm(d))

// a throttle loop with a stand-in io (no server) that stays up until killed; its checkout state dir differs, its DEV_HOME is shared
const script = (): string => {
  const f = join(d, 'loop.ts')
  put(
    f,
    `import { cmdThrottle } from '${join(import.meta.dir, '../src/throttle.ts')}'
const io = { sample: () => ({ cpu: 0, ramFree: 1 }), live: async () => [], control: async () => true, log: () => {} }
process.exit(await cmdThrottle([], io))`,
  )
  return f
}
const start = (n: number) =>
  spawn([process.execPath, script()], {
    env: { ...process.env, YUKTA_DEV_HOME: join(d, 'home'), YUKTA_DEV_STATE_DIR: join(d, `checkout-${n}`), YK_THROTTLE_INTERVAL: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })

test('two throttles with different checkout state dirs: exactly one survives', async () => {
  const a = start(1)
  await Bun.sleep(1500)
  const b = start(2)
  expect(await Promise.race([b.exited, Bun.sleep(8000).then(() => -1)])).toBe(0)
  expect(await new Response(b.stdout).text()).toContain('throttle: already running')
  expect(a.exitCode, 'the first one is still running').toBeNull()
  expect(read(join(d, 'home', 'throttle.lock')).split(' ')[0]).toBe(String(a.pid))
  a.kill()
  await a.exited
})

test('a stale lock (dead pid) or a reused pid is taken over; a live holder is not', () => {
  const f = join(d, 'l1.lock')
  put(f, '999999999 123\n') // no such process
  expect(tryLock(f)).not.toBeNull()
  expect(read(f).split(' ')[0]).toBe(String(process.pid))
  const g = join(d, 'l2.lock')
  put(g, `${process.pid} ${Number(startOf(process.pid)) + 1}\n`) // a live pid with another start time: the pid was reused
  expect(holds(read(g))).toBe(false)
  expect(tryLock(g)).not.toBeNull()
  expect(tryLock(g), 'we hold it now').toBeNull()
  put(join(d, 'l3.lock'), `${process.pid}\n`) // an older lock file: the pid alone
  expect(holds(read(join(d, 'l3.lock')))).toBe(true)
})

test('backoff doubles to a cap, jitters, honours Retry-After and resets', async () => {
  const waits: number[] = []
  const b = backoff(
    async (ms) => void waits.push(ms),
    () => 0,
  ) // no jitter cut
  for (let i = 0; i < 8; i++) await b.wait()
  expect(waits).toEqual([2000, 4000, 8000, 16000, 32000, 64000, 120000, 120000])
  waits.length = 0
  b.reset()
  await b.wait(30)
  expect(waits).toEqual([30000])
  const j = backoff(
    async (ms) => void waits.push(ms),
    () => 1,
  )
  await j.wait()
  expect(waits.at(-1)).toBe(1000) // up to half is cut
})

test('a 401 issues one credential and a repeat waits; a 429 waits for Retry-After and is returned', async () => {
  const hits: string[] = []
  const answers = [401, 401, 401, 401, 200]
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url)
      if (u.pathname.endsWith('/credential')) {
        hits.push('credential')
        return Response.json({ data: { token: 't' + hits.length } })
      }
      hits.push(u.pathname)
      if (u.pathname === '/api/agent/v1/limited') return new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } })
      return new Response('{}', { status: answers.shift() ?? 200 })
    },
  })
  const waits: number[] = []
  const a = agent(
    `http://127.0.0.1:${server.port}`,
    't0',
    backoff(
      async (ms) => void waits.push(ms),
      () => 0,
    ),
  )
  expect((await a.call('GET', '/signals')).code).toBe(401) // 401 -> credential at once -> 401 again
  expect(waits, 'the first 401 did not wait').toEqual([])
  expect((await a.call('GET', '/signals')).code).toBe(401) // another 401 right after: waits before the credential
  expect(waits.length).toBe(1)
  expect(hits.filter((h) => h === 'credential').length).toBe(2)
  const r = await a.call('GET', '/limited')
  expect(r.code).toBe(429)
  expect(waits.at(-1)).toBe(7000)
  server.stop(true)
})

test('an idle, healthy tick does not poll the server', async () => {
  const { tick, config } = await import('../src/throttle.ts')
  let calls = 0
  const io = { sample: () => ({ cpu: 0.1, ramFree: 0.9 }), live: async () => (calls++, []), control: async () => true, log: () => {} }
  await tick({ paused: false, streak: 0 }, new Set(), config(), io)
  expect(calls).toBe(0)
  io.sample = () => ({ cpu: 9, ramFree: 0.9 }) // over the limit: the streak starts, the runs are looked at
  await tick({ paused: false, streak: 0 }, new Set(), config(), io)
  expect(calls).toBe(1)
})
