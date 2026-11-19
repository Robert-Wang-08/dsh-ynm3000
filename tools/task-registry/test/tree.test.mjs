import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTree, updateNodeMeta, isTaskId } from '../lib/tree.mjs'

const TREE = `---
title: 测试树
recent_days: 30
inbox_id: T-INBOX
feishu_state: pending_scope
---

# 近期任务表

## 近期

- \`T-NCBS-CR\` ncbs-cr ｜在办｜2026-11-19｜2 篇
  - \`T-NCBS-CR-ROOTWORD\` 数据词根统一 ｜在办
- \`T-INBOX\` 待分类 ｜待人工

## 历史

- \`T-LEGACY-SRS\` srs处理 ｜在办
`

test('parses nodes, parents and sections', () => {
  const tree = parseTree(TREE)
  assert.deepEqual(tree.errors, [])
  assert.equal(tree.nodes.length, 4)
  assert.equal(tree.byId.get('T-NCBS-CR-ROOTWORD').parent_id, 'T-NCBS-CR')
  assert.equal(tree.byId.get('T-NCBS-CR').level, 1)
  assert.equal(tree.byId.get('T-LEGACY-SRS').section, '历史')
  assert.equal(tree.inboxId, 'T-INBOX')
})

test('rejects duplicate ids and missing parents', () => {
  const dup = TREE.replace('`T-LEGACY-SRS`', '`T-NCBS-CR`')
  assert.ok(parseTree(dup).errors.some(e => e.includes('duplicate')))
  const orphan = TREE.replace('  - `T-NCBS-CR-ROOTWORD`', '    - `T-NCBS-CR-ROOTWORD`')
  assert.ok(parseTree(orphan).errors.some(e => e.includes('depth') || e.includes('parent') || e.includes('indent')))
})

test('validates ids', () => {
  assert.equal(isTaskId('T-NCBS-CR'), true)
  assert.equal(isTaskId('NCBS'), false)
  assert.equal(isTaskId('T-'), false)
})

test('updates only the derived date and count fields', () => {
  const next = updateNodeMeta(TREE, new Map([['T-NCBS-CR-ROOTWORD', { date: '2026-11-20', count: 3 }]]))
  assert.match(next.text, /T-NCBS-CR-ROOTWORD` 数据词根统一 ｜在办｜2026-11-20｜3 篇/)
  assert.match(next.text, /T-NCBS-CR` ncbs-cr ｜在办｜2026-11-19｜2 篇/)
})
