// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// The "Pipeline roles" section of a ticket body (body.ts): one `- role: model/effort` line per role, read by init and applied by route over the static table.
// Only a bare line binds. The router's own choice is written with a trailing ` (router)`, which the parser ignores, so the run decides those
// roles itself (from the criteria, labels and Sizing at run time) and a later change to the table or the sizing still reaches them.
// Anything else in the section is ignored; an unknown role, model or effort is an error (`yk ticket new`) or skipped (init: the static table stays).
import { type Json, sectionItems } from './lib.ts'

export const ROLE_NAMES = ['architect', 'test_writer', 'implementer', 'reviewer']
const MODELS = ['opus', 'sonnet', 'haiku']
const EFFORTS = ['low', 'medium', 'high']

/** `role=model/effort` (or `role: model/effort`) to [role, {model, effort}], or an error text. */
export function parseRole(s: string): [string, Json] | string {
  const m = /^\s*([a-z_]+)\s*[=:]\s*([a-z]+)\s*\/\s*([a-z]+)\s*$/.exec(s)
  if (!m || !ROLE_NAMES.includes(m[1]!) || !MODELS.includes(m[2]!) || !EFFORTS.includes(m[3]!))
    return `bad role '${s}': expected <${ROLE_NAMES.join('|')}>=<${MODELS.join('|')}>/<${EFFORTS.join('|')}>`
  return [m[1]!, { model: m[2]!, effort: m[3]! }]
}

/** The valid (binding) role lines under a 'Pipeline roles' heading, up to the next heading. */
export function rolesOf(body: string | null | undefined): Json {
  const out: Json = {}
  for (const item of sectionItems(body, /pipeline roles/i)) {
    const r = parseRole(item)
    if (Array.isArray(r)) out[r[0]] = r[1]
  }
  return out
}
