// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// What every headless agent of the dogfood (heal fixers, ticket roles, the filing session) may load besides its fixed tool list: the tools that cut its
// token use, and nothing of the dogfood itself. Plugins and MCP servers come from the user's own installation, so no path or version is written here.
//   MCP servers  codebase-memory (graph queries instead of reading files); idea and intellij-index (the IDE's index) on request, when the user has them configured
//   plugins      ponytail (smallest change), token-optimizer, jdtls-lsp (the LSP tool for Java)
//   never        the yukta MCP and skill, the yukta and yukta-dogfood plugins, and any hook (the dogfood's hooks and the user's)
import { homedir } from 'node:os'
import { isFile, join, readFileSync } from '../lib.ts'

// Measured (haiku, yukta checkout, input tokens of one empty session): none 27k, codebase-memory +9k, idea +43k, intellij-index +19k. The two IDE servers
// also index the project open in the IDE, not an issue's worktree. So only codebase-memory is on; YUKTA_AGENT_MCP=codebase-memory-mcp,idea,intellij-index adds them.
export const AGENT_MCP = (process.env.YUKTA_AGENT_MCP ?? 'codebase-memory-mcp').split(',').filter(Boolean)
export const AGENT_PLUGINS = ['ponytail@ponytail', 'token-optimizer@alexgreensh-token-optimizer', 'jdtls-lsp@claude-plugins-official']
/** An allow rule for each server (the whole server) and the skills: the permission mode asks nothing, so what is not allowed is denied. */
export const AGENT_ALLOW = [...['codebase-memory-mcp', 'idea', 'intellij-index'].map((s) => `mcp__${s}`), 'Skill', 'LSP'] // static: session.json is generated from it
export const AGENT_DENY = ['Skill(yukta)', 'Skill(yukta:*)', 'mcp__yukta']
const NEVER = ['yukta@yukta', 'yukta-dogfood@yukta', 'yukta-dogfood@yukta-dogfood']

const readJson = (f: string): Record<string, any> => {
  try {
    return isFile(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}
  } catch {
    return {}
  }
}

/** The --mcp-config document: the user's own definition of each allowed server (a server they do not have is left out). */
export function agentMcp(home = homedir()): { mcpServers: Record<string, unknown> } {
  const have: Record<string, unknown> = readJson(join(home, '.claude.json')).mcpServers ?? {}
  return { mcpServers: Object.fromEntries(AGENT_MCP.filter((s) => s in have).map((s) => [s, have[s]])) }
}

/** The --settings document: no hooks, and of every installed plugin only AGENT_PLUGINS on. */
export function agentSettings(home = homedir()): Record<string, unknown> {
  const installed = Object.keys(readJson(join(home, '.claude', 'plugins', 'installed_plugins.json')).plugins ?? {})
  const enabledPlugins: Record<string, boolean> = Object.fromEntries([...installed, ...NEVER].map((p) => [p, false]))
  for (const p of AGENT_PLUGINS) enabledPlugins[p] = true
  return { disableAllHooks: true, enabledPlugins, permissions: { deny: AGENT_DENY } }
}
