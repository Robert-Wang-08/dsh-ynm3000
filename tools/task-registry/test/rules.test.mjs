import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySummary } from '../lib/rules.mjs'

const rules = {
  version: '1.0.0',
  tasks: {
    'T-NCBS-CR-ROOTWORD': { workspaces: ['ncbs', 'logseq'], keywords_all: ['词根'], keywords_any: ['数据词根', '词表'], exclude: ['翻译词根'] },
    'T-DSH-TOOLS-TEST': { workspaces: ['dsh'], keywords_any: ['回归测试', 'node --test'], exclude: [] },
    'T-DSH-TOOLS-BACKUP': { workspaces: ['dsh'], keywords_any: ['备份'], exclude: [] }
  }
}

const BODY = `
### 01 词根质检

**执行cwd**：[nutstore/1.logseq](<D:/nutstore/1.logseq/>)
数据词根 词表 3485 项，零差异复建。

### 02 DSH 测试

执行cwd: C:\\Users\\wang\\src\\dsh
回归测试 46 passed。

### 03 NCBS 报告

执行cwd: C:\\src\\ncbs
46 passed，与本轮 DSH 无关。
`

test('classifies by workspace + keywords + evidence', () => {
  const result = classifySummary({ body: BODY }, rules)
  assert.deepEqual(result.assignments.map(a => a.task_id).sort(), ['T-DSH-TOOLS-TEST', 'T-NCBS-CR-ROOTWORD'])
  assert.equal(result.unresolved, false)
})

test('does not pull NCBS "46 passed" into DSH tests', () => {
  const onlyNcbs = BODY.split('### 03')[1]
  const result = classifySummary({ body: `### 03 NCBS${onlyNcbs}` }, rules)
  assert.equal(result.assignments.some(a => a.task_id === 'T-DSH-TOOLS-TEST'), false)
})

test('unmatched content is reported unresolved', () => {
  const result = classifySummary({ body: '### 随记\n今天整理了一下桌面，没有具体证据。' }, rules)
  assert.equal(result.unresolved, true)
  assert.deepEqual(result.assignments, [])
})

test('evidence is required even when keywords match', () => {
  const result = classifySummary({ body: '### 01 词根\n数据词根 词表 讨论，没有执行位置与文件。' }, rules)
  assert.equal(result.assignments.length, 0)
})
