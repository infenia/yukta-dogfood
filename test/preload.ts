// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// The plan tests expect the `reuse` stage; CI has no `reuse` installed, so a stub stands in when it is missing.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onPath } from '../src/base.ts'

if (!onPath('reuse')) {
  const d = mkdtempSync(join(tmpdir(), 'fake-reuse-'))
  writeFileSync(join(d, 'reuse'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(d, 'reuse'), 0o755)
  process.env.PATH = `${d}:${process.env.PATH}`
}
