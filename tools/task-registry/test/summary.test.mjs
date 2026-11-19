import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFrontmatter, summaryWindow, taskIds, addLabels, stripLabels, bodyHash } from '../lib/summary.mjs'

const SUMMARY = `---
title: 增量总结
tags: [session-summary, ALL]
summary_scope: ALL
summary_kind: M3
summary_start: 2026-11-17 09:53 +08:00
summary_end: 2026-11-19 12:00 +08:00
summary_sessions: 12
---

# 总结

正文第一行。
`

test('reads the summary_* frontmatter dialect', () => {
  const { fm } = parseFrontmatter(SUMMARY)
  assert.equal(fm.summary_scope, 'ALL')
  assert.deepEqual(taskIds(fm), [])
  assert.deepEqual(summaryWindow(fm), { start: '20261117-0953', end: '20261119-1200' })
})

test('reads the drifted scope/start/end dialect', () => {
  const text = SUMMARY.replace('summary_scope: ALL', 'scope: ALL')
    .replace('summary_start: 2026-11-17 09:53 +08:00', 'start: 20261117-0953')
    .replace('summary_end: 2026-11-19 12:00 +08:00', 'end: 20261119-1200')
  const { fm } = parseFrontmatter(text)
  assert.deepEqual(summaryWindow(fm), { start: '20261117-0953', end: '20261119-1200' })
})

test('adds and strips labels without touching the body', () => {
  const before = bodyHash(SUMMARY)
  const labeled = addLabels(SUMMARY, { tasks: ['T-NCBS-CR-ROOTWORD'], primary: 'T-NCBS-CR-ROOTWORD' })
  const after = bodyHash(labeled.text)
  assert.equal(before, after)
  assert.deepEqual(taskIds(parseFrontmatter(labeled.text).fm), ['T-NCBS-CR-ROOTWORD'])
  const stripped = stripLabels(labeled.text)
  assert.deepEqual(taskIds(parseFrontmatter(stripped).fm), [])
  assert.ok(stripped.includes('summary_scope: ALL'))
  assert.equal(bodyHash(stripped), before)
})

test('replaces an existing label block', () => {
  const first = addLabels(SUMMARY, { tasks: ['T-A'], primary: null }).text
  const second = addLabels(first, { tasks: ['T-B', 'T-C'], primary: 'T-B' }).text
  assert.deepEqual(taskIds(parseFrontmatter(second).fm), ['T-B', 'T-C'])
  assert.match(second, /primary_task: T-B/)
})
