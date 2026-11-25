// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// Dogfood helpers: the dev server (built from origin/main), locks, up/ensure. `lib.ts` re-exports every module.
import { spawn } from 'node:child_process'
import { closeSync, openSync, utimesSync } from 'node:fs'
import { detachGuard, readyPath, throttleLock } from './guard.ts'
import { createConnection } from 'node:net'
import {
  DEV_HOME,
  DEV_PORT,
  DEV_URL,
  HERE,
  Json,
  REPO_ROOT,
  STATE_DIR,
  basename,
  die,
  dirname,
  existsSync,
  git,
  isDir,
  isFile,
  join,
  mkdirp,
  need,
  osArch,
  readdirSync,
  renameSync,
  rmSync,
  run,
  sh,
  sleep,
  sq,
  statSync,
  text,
  tryJson,
  writeFileSync,
} from './base.ts'
import { executable, http, keyHeader, newestBuildCli, pgPassword, serverEnv, serverProperties } from './client.ts'
import { buildDir, pgEnsure, store } from './pg.ts'

// ---- the dev server: built from origin/main, one per machine, on $DEV_PORT
export async function healthy(url = DEV_URL): Promise<boolean> {
  return (await http('GET', `${url}/actuator/health`, { timeoutMs: 3000 })).code === 200
}

export const RUNNING = /RUNNING|PENDING|QUEUED|PAUSED/
/** The executions of the dev server (any session). */
export async function executions(): Promise<Json[] | null> {
  const r = await http('GET', `${DEV_URL}/api/executions?limit=1000`, { headers: keyHeader(), timeoutMs: 5000 })
  const j = tryJson(r.body)
  if (r.code !== 200 || j === undefined) return null
  return Array.isArray(j) ? j : (j.data ?? null)
}

/** The number of executions not yet ended, on any session. When it cannot be read it says 1: never stop a server we cannot see idle.
 * The 30-minute `pickup` schedule of earlier versions never ends and its command is gone: it is stopped here (and pickup.exec removed), else
 * it would keep every swap pending. ponytail: drop this once no dev server started before the removal is left. */
export async function busy(): Promise<number> {
  const ex = await executions()
  if (!ex) return 1
  const old = ex.filter((e) => e.workflowId === 'pickup' && RUNNING.test(e.status ?? ''))
  for (const e of old)
    await http('POST', `${DEV_URL}/api/executions/${e.executionId}/stop?tree=true`, { headers: keyHeader(), timeoutMs: 5000 })
  if (old.length) console.error(`stopped the retired pickup schedule (${old.length} execution${old.length > 1 ? 's' : ''})`)
  rmSync(join(DEV_HOME, 'pickup.exec'), { force: true })
  return ex.filter((e) => e.workflowId !== 'pickup' && RUNNING.test(e.status ?? '')).length
}

/** Brings the managed worktree $DEV_HOME/main to origin/main (or $YUKTA_DEV_MAIN_REF) and returns its commit. */
export function mainSync(): string {
  const wt = join(DEV_HOME, 'main')
  const ref = process.env.YUKTA_DEV_MAIN_REF ?? 'origin/main'
  if (!existsSync(join(wt, '.git'))) {
    if (git(['fetch', '-q', 'origin', 'main'], REPO_ROOT).code) console.error('warning: fetch failed; using the local origin/main')
    const r = git(['worktree', 'add', '-q', '--detach', wt, ref], REPO_ROOT)
    if (r.stderr) console.error(r.stderr.trim())
  } else {
    if (git(['fetch', '-q', 'origin', 'main'], wt).code) console.error('warning: fetch failed; using the local origin/main')
    const r = git(['checkout', '-q', '--force', '--detach', ref], wt)
    if (r.stderr) console.error(r.stderr.trim())
  }
  return git(['rev-parse', 'HEAD'], wt).stdout.trim()
}

/** Builds the server jar and the CLI of the main worktree into buildDir(SHA) (pg.ts; with the PostgreSQL module unless YK_PERSISTENCE=memory), unless that build exists. Keeps the three newest builds. */
export function mainBuild(sha: string): void {
  const wt = join(DEV_HOME, 'main')
  const out = buildDir(sha)
  const log = join(DEV_HOME, 'build.log')
  if (isFile(join(out, 'yukta.jar')) && statSync(join(out, 'yukta.jar')).size > 0 && executable(join(out, 'yukta-cli'))) return
  // The ui build needs the node/pnpm toolchain gradle downloaded into ui/.gradle; reuse a checkout's copy.
  const common = dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], REPO_ROOT).stdout.trim())
  for (const src of [join(REPO_ROOT, 'ui/.gradle'), join(common, 'ui/.gradle')]) {
    if (isDir(join(src, 'pnpm'))) {
      mkdirp(join(wt, 'ui/.gradle'))
      for (const d of readdirSync(src))
        if (!existsSync(join(wt, 'ui/.gradle', d))) run(['cp', '-r', '--reflink=auto', join(src, d), join(wt, 'ui/.gradle/')])
      break
    }
  }
  const pg = store() === 'postgres' ? ' -Pyukta.persistence=postgres' : ''
  console.error(`building main@${sha.slice(0, 9)}${pg ? ' with postgres' : ''} (bootJar + CLI; minutes on a new commit, log: ${log}) ...`)
  const b = sh(`./gradlew${pg} :boot:bootJar :cli:goBuild -q --console=plain >${sq(log)} 2>&1`, wt)
  if (b.code) die(`build of main@${sha.slice(0, 9)} failed; see ${log}`)
  const libs = join(wt, 'boot/build/libs')
  const jar = isDir(libs)
    ? readdirSync(libs)
        .filter((f) => f.endsWith('.jar') && !f.includes('plain'))
        .map((f) => join(libs, f))
        .sort((a, c) => statSync(c).mtimeMs - statSync(a).mtimeMs)[0]
    : undefined
  if (!jar) die(`no boot jar after the build; see ${log}`)
  rmSync(`${out}.tmp`, { recursive: true, force: true })
  mkdirp(`${out}.tmp`)
  run(['cp', jar, join(`${out}.tmp`, 'yukta.jar')])
  run(['cp', join(wt, 'cli/build', `yukta-cli-${osArch()}`), join(`${out}.tmp`, 'yukta-cli')])
  renameSync(`${out}.tmp`, out)
  const dirs = readdirSync(join(DEV_HOME, 'builds'))
    .map((d) => join(DEV_HOME, 'builds', d))
    .filter(isDir)
    .sort((a, c) => statSync(c).mtimeMs - statSync(a).mtimeMs)
  for (const d of dirs.slice(3)) rmSync(d, { recursive: true, force: true })
}

/** Starts the dev server in its own process group (so serverStop stops it with its children) and records it in $DEV_HOME/server.env. */
export async function serverLaunch(kind: string, id: string, label: string, rules: string, cmd: string[]): Promise<void> {
  mkdirp(join(DEV_HOME, 'sessions'))
  rmSync(join(DEV_HOME, 'server.pid'), { force: true })
  const par = process.env.YUKTA_DEV_GRADLE_PARALLEL ?? '2'
  // The key goes in a file, not the environment: the server's children (the gradle stages and their test JVMs) inherit its environment.
  const db = kind === 'main' ? store() : 'memory' // a release has no postgres module
  if (db === 'postgres') await pgEnsure(pgPassword())
  writeFileSync(join(DEV_HOME, 'server.properties'), serverProperties(db === 'postgres'), { mode: 0o600 })
  const logFd = openSync(join(DEV_HOME, 'server.log'), 'w')
  const child = spawn(cmd[0]!, [...cmd.slice(1), `--spring.config.additional-location=file:${join(DEV_HOME, 'server.properties')}`], {
    cwd: DEV_HOME,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      SERVER_PORT: DEV_PORT,
      YUKTA_SERVER_ADDRESS: '127.0.0.1',
      YUKTA_PROCESS_ALLOW_ANY: 'true',
      YUKTA_PLUGINS_ENABLED: 'PROCESS_EXECUTOR,AGENT_SESSION', // restricted types the workflows use (AGENT_SESSION: the claude workflow)
      // yukta processes start with PATH only (infenia/yukta#2327); the tools (gradle, go, pnpm,
      // claude) need the user's environment, and this is a trusted local server
      YUKTA_PROCESS_PASS_ENV: '*',
      YUKTA_CONCURRENCY_GROUPS_GRADLE: par,
      YUKTA_CONCURRENCY_GROUPS_TOOL: par,
      YUKTA_DEV_HOME: DEV_HOME,
      YUKTA_SESSION_BASE_DIR: join(DEV_HOME, 'sessions'),
      YUKTA_SESSION_EXECUTION_TIMEOUT_SECONDS: '86400',
      YUKTA_SUPERVISOR_RULES_FILE: rules,
    },
  })
  child.unref()
  closeSync(logFd)
  writeFileSync(join(DEV_HOME, 'server.pid'), `${child.pid}\n`)
  let cli = join(kind === 'main' ? buildDir(id) : join(DEV_HOME, 'builds', id), 'yukta-cli')
  if (!executable(cli)) cli = newestBuildCli()
  writeFileSync(
    join(DEV_HOME, 'server.env'),
    `YUKTA_DEV_KIND=${kind}\nYUKTA_DEV_SHA=${id}\nYUKTA_DEV_LABEL=${label}\nYUKTA_DEV_CLI=${cli}\nYUKTA_DEV_KEYED=2\nYUKTA_DEV_STORE=${db}\nYUKTA_SERVER_URL=${DEV_URL}\n`,
  )
  console.error(`waiting for Yukta at ${DEV_URL} (log: ${join(DEV_HOME, 'server.log')}) ...`)
  for (let i = 0; i < 60; i++) {
    if (!alive(child.pid!)) {
      rmSync(join(DEV_HOME, 'server.env'), { force: true })
      die(`server exited early; see ${join(DEV_HOME, 'server.log')}`)
    }
    if (await healthy()) {
      console.log(`ready: ${DEV_URL} (${label})`)
      return
    }
    await sleep(2000)
  }
  die(`server did not become healthy in 120s; see ${join(DEV_HOME, 'server.log')}`)
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/** Stops the server yk started (whole process group). Never touches anything else. Forgets it (server.pid, server.env) only if they still
 * describe the server it stopped: a launch that came in while it waited for the old one to exit owns them now. */
export async function serverStop(): Promise<void> {
  const pid = parseInt(text(join(DEV_HOME, 'server.pid')).trim(), 10)
  if (!Number.isNaN(pid)) {
    if (groupAlive(pid)) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        /* gone */
      }
      for (let i = 0; i < 20 && groupAlive(pid); i++) await sleep(1000)
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    if (parseInt(text(join(DEV_HOME, 'server.pid')).trim(), 10) === pid) {
      rmSync(join(DEV_HOME, 'server.pid'), { force: true })
      rmSync(join(DEV_HOME, 'server.env'), { force: true })
    }
  }
}

/** The process on the dev port is the server yk started. */
export function ours(): boolean {
  const pid = parseInt(text(join(DEV_HOME, 'server.pid')).trim(), 10)
  return !Number.isNaN(pid) && alive(pid)
}

// ---- a lock that an exiting process cannot leave behind: a file with the pid and start time of its holder
/** The start time of a process (field 22 of /proc/PID/stat, in ticks since boot), "" where /proc has none. A reused pid has another one. */
export function startOf(pid: number): string {
  try {
    const s = text(`/proc/${pid}/stat`)
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? '' // ponytail: Linux only; elsewhere the pid alone decides
  } catch {
    return ''
  }
}
/** A lock file's content ("pid start"; an older one has the pid only) names a live holder: the pid is alive and is still the process that took the lock. */
export function holds(content: string): boolean {
  const [p, start = ''] = content.trim().split(/\s+/)
  const pid = parseInt(p ?? '', 10)
  return !Number.isNaN(pid) && alive(pid) && (!start || startOf(pid) === start)
}
export function tryLock(path: string): (() => void) | null {
  mkdirp(dirname(path))
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, 'wx')
      writeFileSync(fd, `${process.pid} ${startOf(process.pid)}\n`)
      closeSync(fd)
      const mine = text(path)
      const release = (): void => {
        if (text(path) === mine) rmSync(path, { force: true })
      }
      process.on('exit', release)
      return release
    } catch {
      const seen = text(path)
      if (holds(seen)) return null
      if (text(path) === seen) rmSync(path, { force: true }) // a stale lock (a dead holder, or a pid another process now has); ponytail: two takers can still race here, the window is the gap between this read and the remove
    }
  }
  return null
}
export const lockHeld = (path: string): boolean => holds(text(path))
export async function lock(path: string, waitMs = 600000): Promise<() => void> {
  const end = Date.now() + waitMs
  for (;;) {
    const r = tryLock(path)
    if (r) return r
    if (Date.now() > end) die(`could not take ${path}`)
    await sleep(500)
  }
}

/** The store of the running server (server.env); a server started before the store was recorded ran in memory. */
const storeOf = (): string => serverEnv('YUKTA_DEV_STORE') || 'memory'

/** Makes the dev server run the current origin/main (or a release). A no-op when it already does; when it is stale and busy the swap is left for a later call. */
export async function serverUp(args: string[] = []): Promise<number> {
  let kind = 'main'
  let tag = ''
  if (args[0] === '--release') {
    kind = 'release'
    tag = args[1] ?? ''
  }
  need('git')
  if (kind === 'main') need('java')
  mkdirp(DEV_HOME)
  const release = await lock(join(DEV_HOME, 'up.lock'))
  try {
    let id: string
    let label: string
    let cmd: string[]
    let rules: string
    if (kind === 'release') {
      const r = run(['bun', join(HERE, 'src/release.ts'), ...(tag ? ['--version', tag] : [])])
      if (r.code) {
        console.error(r.stderr)
        return 1
      }
      const bin = r.stdout.trim().split('\n').pop()!
      tag = basename(dirname(dirname(bin)))
      id = `release-${tag}`
      label = `release ${tag}`
      cmd = [bin]
      rules = join(HERE, 'rules.json')
    } else {
      id = mainSync()
      mainBuild(id)
      label = `main@${id.slice(0, 9)}${store() === 'postgres' ? ' (postgres)' : ''}`
      cmd = ['java', '-jar', join(buildDir(id), 'yukta.jar')]
      rules = join(HERE, 'rules.json')
    }
    if (await healthy()) {
      if (!ours()) die(`port ${DEV_PORT} is used by a server yk did not start; stop it or set YUKTA_DEV_PORT`)
      // a server started before yk set an API key is replaced like a stale one
      if (
        serverEnv('YUKTA_DEV_SHA') === id &&
        serverEnv('YUKTA_DEV_KEYED') === '2' &&
        storeOf() === (kind === 'main' ? store() : 'memory')
      ) {
        console.log(`ready: ${DEV_URL} (${label})`)
        return 0
      }
      const n = await busy()
      if (n > 0) {
        console.log(`STALE: the server runs ${serverEnv('YUKTA_DEV_LABEL')}, ${label} is built; swap pending (${n} executions running)`)
        return 0
      }
      console.error(`swapping ${serverEnv('YUKTA_DEV_LABEL')} for ${label}`)
      await serverStop()
    } else if (await portOpen(Number(DEV_PORT))) die(`port ${DEV_PORT} is in use by another program; free it or set YUKTA_DEV_PORT`)
    await serverLaunch(kind, id, label, rules, cmd)
    return 0
  } finally {
    release()
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = createConnection({ port, host: '127.0.0.1' })
    s.on('connect', () => {
      s.destroy()
      r(true)
    })
    s.on('error', () => r(false))
  })
}

/** Before a run: starts the dev server if it is down, and swaps an idle server for an already built newer main (no fetch, no build:
 * `yk up` and the SessionStart hook do those). YUKTA_SERVER_URL pointing elsewhere opts out: that server is used as it is. */
export async function ensureServer(): Promise<void> {
  await ensureServerUp()
  await startThrottle()
}

/** The resource guard (throttle.ts, guard.ts) decides for the supervisor that owns the runs of the session for as long as the server is up: started here, so every run that
 * yk starts is covered. It answers the reviews of people's commands too, so this waits (up to 10 s) until it is attached.  On by default; YK_THROTTLE=off takes the guard off the runs. */
async function startThrottle(): Promise<void> {
  if (process.env.YUKTA_SERVER_URL !== DEV_URL) return
  if (process.env.YK_THROTTLE === 'off') return void (await detachGuard().catch(() => {}))
  if (lockHeld(throttleLock())) return
  rmSync(readyPath(), { force: true })
  spawn(process.execPath, [join(HERE, 'yk'), '_throttle'], { detached: true, stdio: 'ignore', env: process.env }).unref()
  for (let i = 0; i < 40 && !existsSync(readyPath()); i++) await sleep(250) // the loop writes it when attached, or when it gave up
}

async function ensureServerUp(): Promise<void> {
  if (process.env.YUKTA_SERVER_URL && process.env.YUKTA_SERVER_URL !== DEV_URL) return
  process.env.YUKTA_SERVER_URL = DEV_URL
  if (!(await healthy())) {
    console.error(`>> no dev server on ${DEV_URL}; starting one (yk up)`)
    const code = await serverUp()
    if (code) process.exit(code)
    return
  }
  if (!ours() || serverEnv('YUKTA_DEV_KIND') !== 'main') return
  const fetched = join(DEV_HOME, 'fetched')
  if (!isFile(fetched) || Date.now() - statSync(fetched).mtimeMs > 60000) {
    writeFileSync(fetched, '')
    utimesSync(fetched, new Date(), new Date())
    git(['fetch', '-q', 'origin', 'main'], join(DEV_HOME, 'main'))
  }
  const r = git(['rev-parse', process.env.YUKTA_DEV_MAIN_REF ?? 'origin/main'], join(DEV_HOME, 'main'))
  if (r.code) return
  const sha = r.stdout.trim()
  const jar = join(buildDir(sha), 'yukta.jar')
  const built = isFile(jar) && statSync(jar).size > 0
  if ((sha !== serverEnv('YUKTA_DEV_SHA') || storeOf() !== store()) && !built)
    run([process.execPath, join(HERE, 'src/yk.ts'), 'up', '--background'])
  if (
    (sha !== serverEnv('YUKTA_DEV_SHA') || serverEnv('YUKTA_DEV_KEYED') !== '2' || storeOf() !== store()) &&
    built &&
    (await busy()) === 0
  )
    await serverUp()
}
