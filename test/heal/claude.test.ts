// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// Offline test of the headless claude launcher against a fake claude that records its arguments: the MCP access of the fixers (none without a key, read
// tools only with one, the key never in an argument, YUKTA_FIXER_MCP=off) and the role of the system prompt (common rules plus fixer-rules/<kind>.md).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { ts, put, read, rm, script, tmp } from '../helpers.ts'

setDefaultTimeout(120_000)
let d: string
beforeAll(() => {
  d = tmp()
  script(
    join(d, 'claude'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync('${d}/argv', process.argv.slice(2).join('\\n') + '\\n')\nwriteFileSync('${d}/key', (process.env.YK_MCP_KEY ?? '') + '\\n')\nconsole.log('{"is_error":false,"structured_output":{"fixed":false,"summary":"x"}}')`,
  )
  put(join(d, 'rules'), 'rules\n')
})
afterAll(() => rm(d))
const call = (env: Record<string, string | undefined> = {}) => {
  rm(join(d, 'argv'))
  rm(join(d, 'key'))
  const o = ts('src/heal/claude.ts', [], {
    input: '{"prompt":"fix it"}',
    env: {
      YUKTA_DEV_HOME: join(d, 'home'),
      YK_MODEL: 'haiku',
      YK_RULES: join(d, 'rules'),
      YK_SCHEMA: '{}',
      YK_CLAUDE_BIN: join(d, 'claude'),
      YUKTA_FIXER_MCP: undefined,
      YUKTA_FIXER_MCP_KEY: undefined,
      YUKTA_SERVER_URL: undefined,
      YK_MCP_URL: undefined,
      YK_MCP_KEY: undefined,
      ...env,
    },
  })
  expect(o.code, o.err).toBe(0)
  return read(join(d, 'argv'))
}

test('an agent loads the token-saving MCP servers and plugins, no hooks, nothing of the yukta', () => {
  const lines = call().split('\n')
  expect(lines).toContain('--strict-mcp-config')
  expect(lines).toContain('--mcp-config')
  const settings = JSON.parse(lines[lines.indexOf('--settings') + 1]!)
  expect(settings.disableAllHooks).toBe(true)
  expect(settings.enabledPlugins['ponytail@ponytail']).toBe(true)
  expect(settings.enabledPlugins['jdtls-lsp@claude-plugins-official']).toBe(true)
  expect(settings.enabledPlugins['token-optimizer@alexgreensh-token-optimizer']).toBe(true)
  for (const p of ['yukta@yukta', 'yukta-dogfood@yukta', 'yukta-dogfood@yukta-dogfood']) expect(settings.enabledPlugins[p], p).toBe(false)
  expect(Object.keys(JSON.parse(lines[lines.indexOf('--mcp-config') + 1]!).mcpServers).filter((k) => /yukta/.test(k))).toEqual([])
  const allowed = lines.slice(lines.indexOf('--allowedTools'), lines.indexOf('--disallowedTools'))
  expect(allowed).toContain('mcp__codebase-memory-mcp')
  expect(allowed.some((l) => l.startsWith('mcp__yukta'))).toBe(false)
  expect(lines.slice(lines.indexOf('--disallowedTools'))).toContain('mcp__yukta')
  expect(lines).not.toContain('--disable-slash-commands')
})

test.each([
  ['style', 'static-analysis'],
  ['spotbugs', 'SpotBugs'],
  ['tests', 'Java test'],
  ['coverage', 'coverage'],
  ['compile', 'compile'],
  ['ui_vitest', 'UI test'],
  ['ui_tsc', 'UI static-check'],
  ['cli_vet', 'Go'],
  ['reuse', '-'],
  ['spotless', '-'],
])('the fixer role of stage %s', (stage, role) => {
  const argv = call({ YUKTA_FIXER_MCP: 'off', YK_RULES: join(d, 'rules'), YK_STAGE: stage })
  expect(argv, `${stage}: common rules missing`).toContain('rules')
  if (role === '-') expect(argv, `${stage}: got a role`).not.toMatch(/^Role:/m)
  else expect(argv, `${stage}: expected role '${role}'`).toMatch(new RegExp(`^Role: ${role}`, 'm'))
})
