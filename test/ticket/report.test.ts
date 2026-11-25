// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// Offline test of the report (#1884; design 13.1 item 21): sample runs of the generated workflows walked against a throwaway repo, a fake gh and a
// fake claude, then the report over their events.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { World, kit, put, read } from './helpers.ts'

setDefaultTimeout(1_800_000)
let w: World
beforeAll(() => {
  w = new World()
})
afterAll(() => w.cleanup())

test('the report: 10 sample runs, cache hit ratio per role, prefix mismatches, BLOCKED rate', async () => {
  rmSync(join(w.d, 'events.jsonl'), { force: true })
  let i = 0
  for (const m of ['happy', 'happy', 'happy', 'happy', 'happy', 'parallel', 'parallel', 'twostep', 'chain', 'happy']) {
    i++
    await w.walk(m, 'true', { runId: `7-2026010${i % 10}T00000${i}Z` })
    expect(w.rc, `sample run ${i} (${m}) failed: ${w.out}`).toBe(0)
  }
  const ev = join(w.d, 'events.jsonl')
  const r = kit(['report', '--events', ev]).out
  expect(r).toContain('ticket report: 10 runs')
  expect(r).toMatch(/cache hit ratio by role: .*implementer 89%/)
  expect(r).toMatch(/architect .*%/)
  expect(r).toContain('cost share by role')
  expect(r).toContain('prefix_hash mismatches: none')
  expect(r).toMatch(/haiku\/medium\/standard: [0-9]+ steps, first try/)
  expect(r, 'every run is routed once; the sample tickets give no sizing').toContain('routing: 10 routed, 0 with sizing')
  expect(JSON.parse(kit(['report', '--events', ev, '--json']).out).blocked_rate).toBeGreaterThan(0)
  // 21. two calls in one run with different prefix_hash and no revision between them: flagged
  const ev2 = join(w.d, 'events2.jsonl')
  put(
    ev2,
    read(ev) +
      '{"run_id":"bad-run","role":"pack","step_id":"S1","prefix_hash":"sha256:aaa"}\n{"run_id":"bad-run","role":"pack","step_id":"S2","prefix_hash":"sha256:bbb"}\n',
  )
  expect(kit(['report', '--events', ev2]).out).toContain('prefix_hash mismatches: bad-run (2 prefixes, 0 revisions)')
  // the BLOCKED rate above 15% is called out
  put(
    join(w.d, 'b.jsonl'),
    '{"run_id":"b","role":"decide","step_id":"S1","attempt":1,"fail_class":"blocked_reported","model":"haiku","effort":"medium","complexity":"standard"}\n',
  )
  expect(kit(['report', '--events', join(w.d, 'b.jsonl')]).out).toContain('the steps are too small')
  // a route event whose sizing raised the static answer is counted
  put(
    join(w.d, 'z.jsonl'),
    '{"run_id":"z","role":"route","complexity":"M","risk":"high","static_complexity":"S","static_risk":"low","sizing_complexity":"M","sizing_risk":"high"}\n',
  )
  expect(kit(['report', '--events', join(w.d, 'z.jsonl')]).out).toContain('1 with sizing; sizing raised complexity in 1, risk in 1')
})
