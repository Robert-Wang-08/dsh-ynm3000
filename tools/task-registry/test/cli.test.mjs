import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { bodyHash, parseFrontmatter, taskIds } from '../lib/summary.mjs'

const cli = path.join(import.meta.dirname, '..', 'cli.mjs')

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskreg-'))
  assert.equal(run(['init', '--vault', dir, '--apply']).code, 0)
  return dir
}

const SUMMARY = `---
title: 增量总结（烟测）
summary_scope: ALL
summary_kind: M3
summary_start: 2026-11-18 09:00 +08:00
summary_end: 2026-11-19 12:00 +08:00
summary_sessions: 3
---

# 总结

### 01 DSH 测试

执行cwd: C:\\Users\\wang\\src\\dsh
回归测试 46 passed。
`

test('init + label + scan are idempotent', () => {
  const dir = sandbox()
  const file = path.join(dir, 'SUMMARY_ALL_20261118-0900_20261119-1200_烟测.md')
  fs.writeFileSync(file, SUMMARY, 'utf8')
  const before = bodyHash(SUMMARY)

  const label = run(['label', '--summary', file, '--vault', dir, '--apply'])
  assert.equal(label.code, 0, label.err)
  const labeled = fs.readFileSync(file, 'utf8')
  assert.deepEqual(taskIds(parseFrontmatter(labeled).fm), ['T-DSH-TOOLS-TEST'])
  assert.equal(bodyHash(labeled), before)

  const first = JSON.parse(run(['scan', '--vault', dir, '--apply']).out)
  assert.equal(first.ok, true)
  const second = JSON.parse(run(['scan', '--vault', dir, '--apply']).out)
  assert.equal(second.added, 0)
  assert.equal(second.updated, 0)
  assert.equal(second.entries, first.entries)

  const check = run(['check', '--vault', dir])
  assert.equal(check.code, 0, check.out)
  const doctor = run(['doctor', '--vault', dir, '--strict'])
  assert.equal(doctor.code, 0, doctor.out)
})

test('unlabel removes only tool keys', () => {
  const dir = sandbox()
  const file = path.join(dir, 'SUMMARY_ALL_20261118-0900_20261119-1200_烟测.md')
  fs.writeFileSync(file, SUMMARY, 'utf8')
  run(['label', '--summary', file, '--vault', dir, '--apply'])
  const result = run(['unlabel', '--summary', file, '--vault', dir, '--apply'])
  assert.equal(result.code, 0, result.err)
  const text = fs.readFileSync(file, 'utf8')
  assert.deepEqual(taskIds(parseFrontmatter(text).fm), [])
  assert.ok(text.includes('summary_scope: ALL'))
  assert.equal(bodyHash(text), bodyHash(SUMMARY))
})

test('a broken tree is rejected', () => {
  const dir = sandbox()
  const treeFile = path.join(dir, '近期任务表', '近期任务表.md')
  const tree = fs.readFileSync(treeFile, 'utf8').replace('`T-DSH-TOOLS-TEST`', '`T-NCBS-CR`')
  fs.writeFileSync(treeFile, tree, 'utf8')
  const compile = run(['compile', '--vault', dir, '--apply'])
  assert.equal(compile.code, 3)
})
