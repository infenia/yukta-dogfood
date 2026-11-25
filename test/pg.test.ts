// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// PostgreSQL persistence of the dev server: the default store, the opt-out, the build directory and the server properties.
import { afterEach, expect, test } from 'bun:test'
import { DEV_HOME, join } from '../src/base.ts'
import { serverProperties } from '../src/client.ts'
import { buildDir, pgProperties, store } from '../src/pg.ts'

const saved = process.env.YK_PERSISTENCE
afterEach(() => {
  if (saved === undefined) delete process.env.YK_PERSISTENCE
  else process.env.YK_PERSISTENCE = saved
})

test('postgres is the default; YK_PERSISTENCE=memory opts out, and the two builds live apart', () => {
  delete process.env.YK_PERSISTENCE
  expect(store()).toBe('postgres')
  expect(buildDir('abc')).toBe(join(DEV_HOME, 'builds', 'abc-pg'))
  process.env.YK_PERSISTENCE = 'memory'
  expect(store()).toBe('memory')
  expect(buildDir('abc')).toBe(join(DEV_HOME, 'builds', 'abc'))
})

test('the properties select the postgres stores over loopback, for R2DBC and Flyway', () => {
  const p = pgProperties('s3cret')
  for (const k of [
    'spring.profiles.active=postgres',
    'yukta.session.store-type=postgres',
    'yukta.restart.store-type=postgres',
    'spring.r2dbc.password=s3cret',
    'spring.flyway.password=s3cret',
  ])
    expect(p).toContain(k)
  expect(p.find((l) => l.startsWith('spring.r2dbc.url='))).toMatch(/^spring\.r2dbc\.url=r2dbc:postgresql:\/\/127\.0\.0\.1:\d+\/yukta$/)
  expect(p.find((l) => l.startsWith('spring.flyway.url='))).toMatch(/^spring\.flyway\.url=jdbc:postgresql:\/\/127\.0\.0\.1:\d+\/yukta$/)
})

test('serverProperties adds the postgres stores only when asked', () => {
  expect(serverProperties(false)).not.toContain('store-type')
  expect(serverProperties(true)).toContain('yukta.session.store-type=postgres')
})
