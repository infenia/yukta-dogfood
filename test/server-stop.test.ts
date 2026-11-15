// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// Offline test of `yk down` (serverStop): it stops the process group named by server.pid and forgets it, but never forgets a newer launch.
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { alive } from '../src/server.ts'
import { read, rm, put, tmp, ts } from './helpers.ts'

setDefaultTimeout(60_000)
let d: string, home: string
beforeAll(() => {
  d = tmp()
  home = join(d, 'home')
})
afterAll(() => rm(d))

// a stand-in for the server: its own process group; `script` runs in sh and may react to SIGTERM
function fakeServer(script: string): number {
  // setsid: its own process group; started from a shell that exits, so init reaps it (a child of this test would stay a zombie, which counts as alive)
  const r = spawnSync('sh', ['-c', 'setsid sh -c "$0" </dev/null >/dev/null 2>&1 & echo $!', script], { encoding: 'utf8' })
  const pid = parseInt(r.stdout.trim(), 10)
  put(join(home, 'server.pid'), `${pid}\n`)
  put(join(home, 'server.env'), 'YUKTA_DEV_LABEL=old\n')
  return pid
}
const down = () => ts('yk', ['down'], { env: { YUKTA_DEV_HOME: home } })

test('down stops the server and forgets it', () => {
  const pid = fakeServer('sleep 60 & wait')
  expect(down().out).toContain('stopped the dev server')
  expect(alive(pid)).toBe(false)
  expect(read(join(home, 'server.pid'))).toBe('')
  expect(read(join(home, 'server.env'))).toBe('')
})

test('down leaves server.pid and server.env of a server launched while it was stopping', () => {
  // on SIGTERM the old server "exits" after a newer launch has written its own files
  const pid = fakeServer(
    `trap 'echo 424242 > "${home}/server.pid"; echo YUKTA_DEV_LABEL=new > "${home}/server.env"; exit 0' TERM; sleep 60 & wait`,
  )
  expect(down().out).toContain('stopped the dev server')
  expect(alive(pid)).toBe(false)
  expect(read(join(home, 'server.pid')).trim()).toBe('424242')
  expect(read(join(home, 'server.env'))).toContain('new')
})
