// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// src/tool.ts: the step of the `tool` workflow runs $YUKTA_TOOL_COMMAND and its exit code picks the port.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ts } from './helpers.ts'

const run = (command: string | undefined, label = 'x') =>
  ts('src/tool.ts', [], {
    env: { YUKTA_TOOL_COMMAND: command, YUKTA_TOOL_LABEL: label },
  })

test('an empty command or "-" passes without running anything', () => {
  for (const c of [undefined, '', '-']) {
    const r = run(c)
    expect(r.code).toBe(0)
    expect(r.out).toContain('tool x: nothing to run')
  }
})

test('exit code 0 passes and any other code is passed through', () => {
  expect(run('true').code).toBe(0)
  expect(run('exit 7').code).toBe(7)
})

test('output goes straight through, and quotes, && and pipes run as written', () => {
  const r = run(`echo 'a b' && echo "c" | tr c d`)
  expect(r.code).toBe(0)
  expect(r.out).toBe('a b\nd\n')
})

test('a command killed by a signal fails with 128 + signo', () => {
  expect(run('kill -TERM $$ ; sleep 5').code).toBe(143)
})

test('every node of every generated workflow has a color', () => {
  const s = JSON.parse(readFileSync(join(import.meta.dir, '..', 'session.json'), 'utf8'))
  for (const k of ['tool', 'claude', 'agent', 'attempt', 'heal', 'check', 'pickup']) {
    for (const n of s.workflows[k].nodes) expect([k, n.nodeId, n.color]).not.toEqual([k, n.nodeId, undefined])
  }
})
