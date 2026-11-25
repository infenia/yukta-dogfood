// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// The ticket body round trip: render -> parse gives the same TicketBody, a person's edit still parses, a broken one names what is wrong,
// and specOf gives a valid ticket-spec.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT } from './helpers.ts'
import { parseTicket, renderTicket, specOf } from '../../src/ticket/body.ts'
import { validateDoc } from '../../src/ticket/validate-schema.ts'

const valid = JSON.parse(readFileSync(join(KIT, 'fixtures/ticket-body/valid.json'), 'utf8'))

test('render then parse gives the same body', () => {
  const r = parseTicket(renderTicket(valid))
  expect(r.errors).toEqual([])
  expect(r.ticket).toEqual(valid)
})

test('stubs round-trip: whole files, a code fence inside one stays in it', () => {
  const b = {
    ...valid,
    stubs: [
      {
        path: 'core/src/main/java/A.java',
        content: 'class A {\n  /** ```not a fence``` */\n  void allow() { throw new UnsupportedOperationException(); }\n}\n',
      },
    ],
  }
  const md = renderTicket(b)
  expect(md).toContain('### `core/src/main/java/A.java`')
  const r = parseTicket(md)
  expect(r.errors).toEqual([])
  expect(r.ticket.stubs).toEqual(b.stubs)
})

test('dependencies round-trip as issue links', () => {
  const b = { ...valid, depends_on: [12, 15] }
  const md = renderTicket(b)
  expect(md).toContain('- depends on: #12, #15')
  expect(parseTicket(md).ticket).toEqual(b)
})

test('a body without optional parts round-trips too', () => {
  const { risk_reason, plan_file, base_sha, ...bare } = valid
  void [risk_reason, plan_file, base_sha]
  const b = { ...bare, decisions: [], out_of_scope: [], roles: {} }
  const r = parseTicket(renderTicket(b))
  expect(r.errors).toEqual([])
  expect(r.ticket).toEqual(b)
})

test("a person's edit parses: reworded prose, a ticked criterion, a new step, a new decision", () => {
  const md = renderTicket(valid)
    .replace('- [ ] AC1:', '- [x] AC1:')
    .replace('A new class A in core', 'A new final class A in core')
    .replace('- The window is fixed, not sliding.', '- The window is fixed, not sliding.\n- Counts are per client id.')
    .replace(
      '## Tests',
      '### S2: Wire limiter\n\n```yaml\ndepends_on: [S1]\ncovers: []\ncomplexity: trivial\nwrite_files: [core/src/main/java/B.java]\nread_files: []\ninstructions: [Call A.allow in B]\ncontracts: []\nconstraints: []\nnon_goals: []\ndone_when:\n  commands: [yk gradle :core:test]\nlimits: { max_diff_lines: 20, max_files: 1 }\n```\n\n## Tests',
    )
  const r = parseTicket(md)
  expect(r.errors).toEqual([])
  expect(r.ticket.steps.map((s: { id: string }) => s.id)).toEqual(['S1', 'S2'])
  expect(r.ticket.steps[1].depends_on).toEqual(['S1'])
  expect(r.ticket.decisions).toEqual(['The window is fixed, not sliding.', 'Counts are per client id.'])
  expect(r.ticket.architecture).toStartWith('A new final class A')
})

test('a review-only criterion and a router-decided role line', () => {
  const md = renderTicket(valid)
    .replace(/- \[ \] AC1: .*/, '- [ ] AC1: the limit is documented')
    .replace('- implementer: sonnet/medium', '- implementer: sonnet/medium\n- reviewer: sonnet/medium (router)')
  const r = parseTicket(md)
  expect(r.errors).toEqual([])
  expect(r.ticket.acceptance_criteria[0]).toEqual({ id: 'AC1', text: 'the limit is documented', verification: { kind: 'review' } })
  expect(Object.keys(r.ticket.roles)).toEqual(['implementer'])
})

test('a heading inside a fenced block stays in its section', () => {
  const arch = 'A new class A.\n\n```md\n## Not a section\n### S9: not a step\n```'
  const r = parseTicket(renderTicket({ ...valid, architecture: arch }))
  expect(r.errors).toEqual([])
  expect(r.ticket.architecture).toBe(arch)
  expect(r.ticket.steps).toHaveLength(1)
})

test('a broken body says what is wrong', () => {
  const md = renderTicket(valid)
  expect(parseTicket(md.replace(/## Security[\s\S]*?(?=## Decisions)/, '')).errors).toContain("missing section '## Security'")
  expect(parseTicket(md.replace('allow_new_dependencies: false', 'allow_new_dependencies: [')).errors[0]).toStartWith(
    "section 'Scope': bad YAML",
  )
  expect(parseTicket(md.replace('- type: feature', '- type: story')).errors.join('\n')).toContain('/type')
  expect(parseTicket(md.replace('AC1:', 'Criterion one:')).errors[0]).toStartWith('acceptance criterion')
})

test('specOf gives a valid ticket-spec', () => {
  const spec = specOf(valid, '42')
  expect(validateDoc('ticket-spec', spec, 'spec').lines).toEqual([])
  expect(spec.ticket_id).toBe('42')
  expect(spec.steps).toEqual(valid.steps)
})

test('a body edited on GitHub (CRLF line endings) parses the same', () => {
  const r = parseTicket(renderTicket(valid).replaceAll('\n', '\r\n'))
  expect(r.errors).toEqual([])
  expect(r.ticket).toEqual(valid)
})
