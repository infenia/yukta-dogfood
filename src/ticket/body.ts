// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// The ticket body: the GitHub issue holds the whole spec, so a person reviews and edits it before the run and the run reads it back.
// renderTicket writes a TicketBody (schemas/ticket-body.schema.json) as Markdown; parseTicket reads it back; specOf turns it into the run's
// ticket-spec. Prose sections are plain text; the parts the pipeline reads field by field are one fenced YAML block each (Steps: one per
// `### Sn: title`, Tests, Scope), so an edit stays easy and a broken one is caught by the schema, not guessed at.
//
//   ## Summary · ## Type and size · ## Acceptance criteria · ## Architecture · ## Steps · ## Tests · ## Scope · ## Security
//   ## Decisions · ## Out of scope · ## Assumptions · ## Pipeline roles · ## Source
import { type Json } from './lib.ts'
import { ROLE_NAMES, rolesOf } from './roles.ts'
import { validateDoc } from './validate-schema.ts'

const H2 = /^\s{0,3}##\s+(.+?)\s*#*\s*$/
const H3 = /^\s{0,3}###\s+(S\d+)\s*:\s*(.*?)\s*$/
const FENCE = /^\s*```ya?ml\s*\n([\s\S]*?)\n\s*```\s*$/m
const ITEM = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/
const CRITERION = /^(AC\d+)\s*:\s*(.+?)\s*(?:\(verify:\s*(?:`([^`]+)`|review)\))?$/

const yaml = (v: Json): string => '```yaml\n' + Bun.YAML.stringify(v, null, 2).trimEnd() + '\n```'
const bullets = (xs: string[], none = '- none'): string => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : none)

export function renderTicket(t: Json): string {
  const sec = (title: string, content: string): string => `## ${title}\n\n${content.trim()}\n`
  const ac = t.acceptance_criteria.map((c: Json) => {
    const v = c.verification.kind === 'command' ? `\`${c.verification.command}\`` : 'review'
    return `- [ ] ${c.id}: ${c.text} (verify: ${v})`
  })
  const steps = t.steps.map(({ id, title, ...rest }: Json) => `### ${id}: ${title}\n\n${yaml(rest)}`).join('\n\n')
  const size = [
    `- type: ${t.type}`,
    `- complexity: ${t.complexity}`,
    `- risk: ${t.risk}`,
    ...(t.risk_reason ? [`- risk reason: ${t.risk_reason}`] : []),
  ]
  const roles = ROLE_NAMES.filter((r) => t.roles[r]).map((r) => `${r}: ${t.roles[r].model}/${t.roles[r].effort}`)
  const source = [
    ...(t.plan_file ? [`- plan: ${t.plan_file}`] : []),
    ...(t.base_sha ? [`- base: ${t.base_sha}`] : []),
    ...(t.depends_on?.length ? [`- depends on: ${t.depends_on.map((n: number) => `#${n}`).join(', ')}`] : []),
  ]
  return [
    sec('Summary', t.summary),
    sec('Type and size', size.join('\n')),
    sec('Acceptance criteria', ac.join('\n')),
    sec('Architecture', t.architecture),
    sec('Steps', steps),
    sec('Tests', yaml({ mode: t.tests_mode, locked_files: t.locked_files, cases: t.test_cases })),
    sec('Scope', yaml(t.scope)),
    sec('Security', t.security),
    sec('Decisions', bullets(t.decisions)),
    sec('Out of scope', bullets(t.out_of_scope)),
    sec('Assumptions', bullets(t.assumptions)),
    sec('Pipeline roles', bullets(roles, '- none chosen: the router decides every role')),
    ...(source.length ? [sec('Source', source.join('\n'))] : []),
  ].join('\n')
}

/** A line filter: true for a line outside a ``` fence, so a heading inside a code or YAML block is not taken for a section. */
function outsideFences(): (line: string) => boolean {
  let open = false
  return (line) => {
    if (/^\s*```/.test(line)) open = !open
    return !open && !/^\s*```/.test(line)
  }
}

/** The H2 sections of the issue Markdown: lowercased title to its text. */
function sections(md: string): Map<string, string> {
  const out = new Map<string, string>()
  let key: string | null = null
  let buf: string[] = []
  const flush = (): void => void (key !== null && out.set(key, buf.join('\n').trim()))
  const fenced = outsideFences()
  for (const line of md.split(/\r?\n/)) {
    const m = fenced(line) && H2.exec(line)
    if (m) {
      flush()
      key = m[1]!.toLowerCase()
      buf = []
    } else buf.push(line)
  }
  flush()
  return out
}

/** The list items of a section; a lone `- none` is an empty list. */
const items = (text: string | undefined): string[] => {
  const xs = (text ?? '').split('\n').flatMap((l) => ITEM.exec(l)?.[1] ?? [])
  return xs.length === 1 && xs[0]!.toLowerCase() === 'none' ? [] : xs
}

/** `- key: value` items of a section as a map (keys lowercased). */
const fields = (text: string | undefined): Map<string, string> =>
  new Map(
    items(text).flatMap((x): [string, string][] => {
      const m = /^([^:]+):\s*(.*)$/.exec(x)
      return m ? [[m[1]!.trim().toLowerCase(), m[2]!.trim()]] : []
    }),
  )

/** A TicketBody read back from the issue Markdown, and the problems found (a missing section, bad YAML, a schema error); `errors` empty means valid. */
export function parseTicket(md: string): { ticket: Json; errors: string[] } {
  const s = sections(md)
  const errors: string[] = []
  const block = (title: string, text = s.get(title.toLowerCase())): Json => {
    if (text === undefined) return void errors.push(`missing section '## ${title}'`)
    const m = FENCE.exec(text)
    if (!m) return void errors.push(`section '${title}': no \`\`\`yaml block`)
    try {
      return Bun.YAML.parse(m[1]!)
    } catch (e) {
      errors.push(`section '${title}': bad YAML: ${(e as Error).message}`)
    }
  }
  const prose = (title: string): string | undefined => {
    const t = s.get(title.toLowerCase())
    if (t === undefined) errors.push(`missing section '## ${title}'`)
    return t
  }

  const steps: Json[] = []
  let cur: { id: string; title: string; lines: string[] } | null = null
  const push = (): void => {
    if (cur) steps.push({ id: cur.id, title: cur.title, ...block(`Steps ${cur.id}`, cur.lines.join('\n')) })
  }
  const fenced = outsideFences()
  for (const line of (s.get('steps') ?? '').split('\n')) {
    const m = fenced(line) && H3.exec(line)
    if (m) {
      push()
      cur = { id: m[1]!, title: m[2]!, lines: [] }
    } else cur?.lines.push(line)
  }
  push()
  if (!s.has('steps')) errors.push("missing section '## Steps'")

  const acceptance = items(s.get('acceptance criteria')).map((x) => {
    const m = CRITERION.exec(x)
    if (!m) return void errors.push(`acceptance criterion '${x.slice(0, 80)}': expected 'ACn: text (verify: \`command\` | review)'`)
    return { id: m[1], text: m[2], verification: m[3] ? { kind: 'command', command: m[3] } : { kind: 'review' } }
  })
  const size = fields(s.get('type and size'))
  const source = fields(s.get('source'))
  const tests = block('Tests') ?? {}
  const ticket: Json = {
    summary: prose('Summary'),
    type: size.get('type'),
    complexity: size.get('complexity'),
    risk: size.get('risk'),
    ...(size.get('risk reason') ? { risk_reason: size.get('risk reason') } : {}),
    acceptance_criteria: acceptance,
    architecture: prose('Architecture'),
    steps,
    tests_mode: tests.mode,
    test_cases: tests.cases ?? [],
    locked_files: tests.locked_files ?? [],
    scope: block('Scope'),
    security: prose('Security'),
    decisions: items(s.get('decisions')),
    out_of_scope: items(s.get('out of scope')),
    assumptions: items(s.get('assumptions')),
    roles: rolesOf(md),
    ...(source.get('plan') ? { plan_file: source.get('plan') } : {}),
    ...(source.get('base') ? { base_sha: source.get('base') } : {}),
    ...(source.get('depends on') ? { depends_on: [...source.get('depends on')!.matchAll(/#?(\d+)/g)].map((m) => Number(m[1])) } : {}),
  }
  if (!errors.length) errors.push(...validateDoc('ticket-body', ticket, 'ticket').lines)
  return { ticket, errors }
}

/** The run's ticket-spec from a (valid) body: the issue number and the run's scaffold patch are the only parts the body does not hold. */
export function specOf(t: Json, ticketId: string, scaffoldPatch = 'spec/scaffold.patch'): Json {
  return {
    spec_version: 1,
    ticket_id: ticketId,
    objective: t.summary,
    risk: t.risk,
    assumptions: t.assumptions,
    scope: t.scope,
    acceptance_criteria: t.acceptance_criteria,
    tests_mode: t.tests_mode,
    test_cases: t.test_cases,
    locked_files: t.locked_files,
    scaffold_patch: scaffoldPatch,
    steps: t.steps,
  }
}
