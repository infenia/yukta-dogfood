// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Infenia Private Limited
// The stubs of a filed spec (ticket body, section Stubs: the whole content of each new or changed source file the tests compile against, bodies that
// only throw) as the scaffold patch of a run, and a clean tree at a base to check a spec against: both in a throwaway detached worktree of the base, so
// the person's checkout (any branch, any edits) is never what decides.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { git, join, mkdirp, writeFileSync } from './lib.ts'

/** Runs `f` with a detached worktree of `base` in the repo `root`; the worktree is removed afterwards. */
export function atBase<T>(root: string, base: string, f: (wt: string) => T): T {
  const wt = join(mkdtempSync(join(tmpdir(), 'ticket-base-')), 'wt')
  const add = git(['worktree', 'add', '-q', '--detach', wt, base], { cwd: root, check: false })
  if (add.code) throw new Error(`cannot check out ${base}: ${add.stderr.trim().slice(0, 200)}`)
  try {
    return f(wt)
  } finally {
    git(['worktree', 'remove', '--force', wt], { cwd: root, check: false })
    rmSync(dirname(wt), { recursive: true, force: true })
  }
}

/** The patch that turns the tree at `wt` into one with the stubs written (empty without stubs). Leaves `wt` as it was. */
export function stubPatch(wt: string, stubs: { path: string; content: string }[] | undefined): string {
  if (!stubs?.length) return ''
  for (const s of stubs) {
    if (s.path.startsWith('/') || s.path.split('/').includes('..')) throw new Error(`stub path ${s.path} is not inside the repository`)
    mkdirp(dirname(join(wt, s.path)))
    writeFileSync(join(wt, s.path), s.content.endsWith('\n') ? s.content : s.content + '\n')
  }
  git(['add', '-A'], { cwd: wt })
  const patch = git(['diff', '--cached', '--binary'], { cwd: wt }).stdout
  git(['reset', '-q', '--hard'], { cwd: wt })
  git(['clean', '-qfd'], { cwd: wt })
  return patch
}
