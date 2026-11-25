// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// PostgreSQL persistence of the dev server: sessions, workflow definitions, run history and node checkpoints survive a restart or a swap.
// The default; YK_PERSISTENCE=memory keeps everything in memory as before (a release build always does: it has no postgres module).
//
// The database is one Docker container, yukta-dev-pg (postgres:18-alpine, the image yukta's own tests use), on 127.0.0.1:YUKTA_DEV_PG_PORT (55432) only,
// data in the Docker volume yukta-dev-pg. The password is a dev secret ($DEV_HOME/pg-password) and reaches Docker through a 0600 env file, never an argument.
// `yk down` leaves the database running; `docker rm -f yukta-dev-pg && docker volume rm yukta-dev-pg` wipes it.
import { DEV_HOME, die, join, mkdirp, need, run, sleep } from './base.ts'
import { writeFileSync } from 'node:fs'

export const PG_NAME = 'yukta-dev-pg'
const IMAGE = 'postgres:18-alpine'
const USER = 'yukta'
const DB = 'yukta'
export const pgPort = (): string => process.env.YUKTA_DEV_PG_PORT || '55432'

/** postgres (default) or memory (YK_PERSISTENCE=memory). */
export const store = (): 'postgres' | 'memory' => (process.env.YK_PERSISTENCE === 'memory' ? 'memory' : 'postgres')

/** The build directory of a commit: a postgres build has the persistence module on its classpath, so it is kept apart from a memory build. */
export const buildDir = (sha: string): string => join(DEV_HOME, 'builds', store() === 'postgres' ? `${sha}-pg` : sha)

/** The server properties that select the PostgreSQL stores (yukta docs: contributing/modules/persistence-postgres). The `postgres` profile
 * (boot application-postgres.yaml) is what lets R2DBC and Flyway start at all: without it application.yaml excludes their auto-configuration. */
export function pgProperties(password: string): string[] {
  const host = `127.0.0.1:${pgPort()}/${DB}`
  return [
    'spring.profiles.active=postgres',
    'yukta.session.store-type=postgres',
    'yukta.restart.store-type=postgres',
    `spring.r2dbc.url=r2dbc:postgresql://${host}`,
    `spring.r2dbc.username=${USER}`,
    `spring.r2dbc.password=${password}`,
    `spring.flyway.url=jdbc:postgresql://${host}`,
    `spring.flyway.user=${USER}`,
    `spring.flyway.password=${password}`,
  ]
}

/** Starts the database container (created on first use) and waits until it accepts connections. */
export async function pgEnsure(password: string): Promise<void> {
  need('docker')
  const state = run(['docker', 'inspect', '-f', '{{.State.Running}}', PG_NAME])
  if (state.code) {
    mkdirp(DEV_HOME)
    const envFile = join(DEV_HOME, 'pg.env')
    writeFileSync(envFile, `POSTGRES_USER=${USER}\nPOSTGRES_DB=${DB}\nPOSTGRES_PASSWORD=${password}\n`, { mode: 0o600 })
    console.error(`postgres: creating ${PG_NAME} (${IMAGE}) on 127.0.0.1:${pgPort()}`)
    const r = run(
      ['docker', 'run', '-d', '--name', PG_NAME, '--restart', 'unless-stopped', '--env-file', envFile].concat([
        '-p',
        `127.0.0.1:${pgPort()}:5432`,
        '-v',
        `${PG_NAME}:/var/lib/postgresql`,
        IMAGE,
      ]),
      { timeoutMs: 300000 },
    )
    if (r.code) die(`postgres: docker run failed: ${(r.stderr || r.stdout).trim().slice(-300)} (YK_PERSISTENCE=memory runs without it)`)
  } else if (state.stdout.trim() !== 'true') {
    const r = run(['docker', 'start', PG_NAME])
    if (r.code) die(`postgres: docker start ${PG_NAME} failed: ${r.stderr.trim().slice(-300)}`)
  }
  for (let i = 0; i < 60; i++) {
    if (run(['docker', 'exec', PG_NAME, 'pg_isready', '-q', '-U', USER, '-d', DB]).code === 0) return
    await sleep(1000)
  }
  die(`postgres: ${PG_NAME} did not accept connections within 60 s (docker logs ${PG_NAME})`)
}
