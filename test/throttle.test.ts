// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// The load supervisor: the decision with its hysteresis, and one tick against fake runs.
import { expect, test } from 'bun:test'
import { type Cfg, type Io, type Sample, type State, decide, tick } from '../src/throttle.ts'

const c: Cfg = { pauseCpu: 1.5, resumeCpu: 0.9, pauseRam: 0.1, resumeRam: 0.2, hold: 3, interval: 10 }
const calm: Sample = { cpu: 0.3, ramFree: 0.6 }
const hot: Sample = { cpu: 2, ramFree: 0.6 }
const low: Sample = { cpu: 0.3, ramFree: 0.05 }

test('pauses only after `hold` samples in a row, and a calm sample resets the count', () => {
  let s: State = { paused: false, streak: 0 }
  const acts: string[] = []
  for (const x of [hot, hot, calm, hot, hot, hot]) {
    const d = decide(s, x, c)
    s = d.state
    acts.push(d.act)
  }
  expect(acts).toEqual(['none', 'none', 'none', 'none', 'none', 'pause'])
  expect(s.paused).toBe(true)
})
test('low RAM pauses; resuming needs both CPU and RAM back above the resume limits', () => {
  let s: State = { paused: false, streak: 0 }
  for (let i = 0; i < 3; i++) s = decide(s, low, c).state
  expect(s.paused).toBe(true)
  const between: Sample = { cpu: 0.3, ramFree: 0.15 } // above pauseRam, under resumeRam
  for (let i = 0; i < 5; i++) expect(decide(s, between, c).act).toBe('none')
  for (let i = 0; i < 2; i++) s = decide(s, calm, c).state
  expect(decide(s, calm, c).act).toBe('resume')
})

function fake(runs: { id: string; paused: boolean }[], x: () => Sample) {
  const calls: string[] = []
  const io: Io = {
    sample: x,
    live: async () => runs.map((r) => ({ ...r })),
    control: async (verb, id) => {
      calls.push(`${verb} ${id}`)
      const r = runs.find((r) => r.id === id)!
      r.paused = verb === 'pause'
      return true
    },
    log: () => {},
  }
  return { io, calls }
}

test('a tick pauses the live runs, then resumes only the ones it paused (a person-paused run stays paused)', async () => {
  let load = hot
  const runs = [
    { id: 'a', paused: false },
    { id: 'b', paused: false },
    { id: 'human', paused: true },
  ]
  const { io, calls } = fake(runs, () => load)
  const mine = new Set<string>()
  const one = { ...c, hold: 1 }
  let s: State = { paused: false, streak: 0 }
  s = await tick(s, mine, one, io)
  expect(calls).toEqual(['pause a', 'pause b'])
  expect([...mine]).toEqual(['a', 'b'])
  runs.push({ id: 'late', paused: false }) // starts while the others are held back
  s = await tick(s, mine, one, io)
  expect(calls.slice(2)).toEqual(['pause late'])
  load = calm
  s = await tick(s, mine, one, io)
  expect(calls.slice(3)).toEqual(['resume a', 'resume b', 'resume late'])
  expect(runs.find((r) => r.id === 'human')!.paused).toBe(true)
  expect(s.paused).toBe(false)
})
test('a run that somebody else resumed is forgotten, not paused again by mistake', async () => {
  const runs = [{ id: 'a', paused: false }]
  const { io, calls } = fake(runs, () => calm)
  const mine = new Set(['a']) // we paused it before, a person resumed it since
  await tick({ paused: false, streak: 0 }, mine, { ...c, hold: 1 }, io)
  expect(calls).toEqual([])
  expect(mine.size).toBe(0)
})
