// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// The generated heal workflow: a fixed ladder of rungs (heal.json), no classifier, every attempt on the agent workflow.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HERE = join(import.meta.dir, '..', '..')
const session = JSON.parse(readFileSync(join(HERE, 'session.json'), 'utf8'))
const policy = JSON.parse(readFileSync(join(HERE, 'heal.json'), 'utf8'))
const heal = session.workflows.heal
const to = (src: string, port?: string): string[] =>
  heal.edges.filter((e: any) => e.source === src && (port === undefined || e.sourcePort === port)).map((e: any) => e.target)

test('the heal workflow climbs the ladder of heal.json in order, one attempt per rung', () => {
  const rungs: string[] = policy.ladder.map((r: string) => `fix-${r.replace('/', '-')}`)
  expect(rungs).toEqual(['fix-haiku-low', 'fix-haiku-medium', 'fix-haiku-high', 'fix-sonnet-low', 'fix-sonnet-medium', 'fix-sonnet-high'])
  expect(to('known?', 'unknown')).toEqual([rungs[0]!])
  rungs.forEach((id, k) => {
    const node = heal.nodes.find((n: any) => n.nodeId === id)
    const [model, effort] = policy.ladder[k].split('/')
    expect(node.config.workflowId).toBe('attempt')
    expect([node.config.payload.model, node.config.payload.effort]).toEqual([model, effort])
    expect(to(id, 'success')).toEqual(['done'])
    const next = to(id, 'failure')
    // a failed rung goes through the escalation guard to the next rung, or the guard and the last rung give up
    if (k + 1 < rungs.length) {
      expect(next).toEqual([`carry.${rungs[k + 1]}`])
      expect(to(`carry.${rungs[k + 1]}?`, 'go')).toEqual([rungs[k + 1]!])
      expect(to(`carry.${rungs[k + 1]}?`, 'stop')).toEqual(['giveup'])
    } else expect(next).toEqual(['giveup'])
  })
})

test('no classifier, no claude workflow: every attempt runs the agent workflow', () => {
  for (const wf of Object.values<any>(session.workflows))
    for (const n of wf.nodes) expect([wf.workflowId, n.type === 'CLASSIFY']).toEqual([wf.workflowId, false])
  expect(session.workflows.claude).toBeUndefined()
  const call = session.workflows.attempt.nodes.find((n: any) => n.nodeId === 'agent')
  expect(call.config.workflowId).toBe('agent')
  const called = new Set(
    Object.values<any>(session.workflows).flatMap((w) =>
      w.nodes.filter((n: any) => n.type === 'SUB_WORKFLOW').map((n: any) => n.config.workflowId),
    ),
  )
  expect([...called].sort()).toEqual(['agent', 'attempt', 'heal', 'tool'])
})
