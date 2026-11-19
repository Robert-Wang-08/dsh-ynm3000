import fs from 'node:fs'
import path from 'node:path'
import { sha256, writeAtomic, writeJson, readJson, nowIso } from './fsx.mjs'
import { stampToIso } from './summary.mjs'

export function vaultPaths(vault) {
  const dir = path.join(vault, '近期任务表')
  const registry = path.join(dir, '_registry')
  return {
    dir,
    registry,
    tree: path.join(dir, '近期任务表.md'),
    tasks: path.join(registry, 'tasks.json'),
    rules: path.join(registry, 'rules.json'),
    links: path.join(registry, 'summary-links.json'),
    feishu: path.join(registry, 'feishu.md'),
  }
}

export function emptyLinks() {
  return { schema_version: 1, updated: null, entries: [] }
}

export function loadLinks(file) {
  return readJson(file, emptyLinks())
}

export function upsertLink(links, entry) {
  const index = links.entries.findIndex(item => item.summary === entry.summary)
  if (index < 0) {
    links.entries.push(entry)
    return true
  }
  const current = links.entries[index]
  if (current.summary_sha256 === entry.summary_sha256 && current.rules_version === entry.rules_version) {
    return false
  }
  links.entries[index] = entry
  return true
}

export function saveLinks(file, links) {
  links.updated = nowIso()
  return writeJson(file, links)
}

export function lastActivityOf(links, taskId) {
  let last = null
  let count = 0
  for (const entry of links.entries) {
    for (const assignment of entry.assignments || []) {
      if (assignment.task_id !== taskId) continue
      count += 1
      const iso = stampToIso(entry.window?.end || null)
      if (!iso) continue
      if (!last || iso > last) last = iso
    }
  }
  return { last, count }
}

export function compileModel(tree, links, { now = new Date() } = {}) {
  const recentDays = tree.recentDays
  const cutoff = now.getTime() - recentDays * 86400000
  const nodes = tree.nodes.map(node => {
    const { last, count } = lastActivityOf(links, node.id)
    return {
      id: node.id,
      title: node.title,
      parent_id: node.parent_id,
      order: node.order,
      level: node.level,
      section: node.section,
      status: node.status,
      last_activity: last,
      summary_count: count,
      recent: Boolean(last && Date.parse(last) >= cutoff),
    }
  })
  const byParent = new Map()
  for (const node of nodes) {
    const key = node.parent_id || 'root'
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key).push(node)
  }
  const rollup = id => {
    const node = nodes.find(item => item.id === id)
    let count = node.summary_count || 0
    let last = node.last_activity
    for (const child of byParent.get(id) || []) {
      const value = rollup(child.id)
      count += value.count
      if (value.last && (!last || Date.parse(value.last) > Date.parse(last))) last = value.last
    }
    node.summary_count = count
    node.last_activity = last
    node.recent = Boolean(last && Date.parse(last) >= cutoff)
    return { count, last }
  }
  for (const node of nodes) if (!node.parent_id) rollup(node.id)

  return {
    schema_version: 1,
    revision: 1,
    source_hash: sha256(tree.raw),
    recent_days: recentDays,
    inbox_id: tree.inboxId,
    generated_at: nowIso(),
    nodes,
    feishu: {
      state: tree.feishuState || 'pending_scope',
      url: tree.feishuUrl || null,
      published_revision: null,
    },
  }
}

export function renderFeishu(tree, model) {
  const lines = []
  lines.push('# 近期任务表')
  lines.push('')
  lines.push(`> 本文件由 task-registry 生成，是飞书文档的 Markdown 等效副本。`)
  lines.push(`> 飞书文档：${model.feishu.url || '待授权（scope 未批准，暂无链接）'}`)
  lines.push(`> 数据截至：${model.generated_at}；近期窗口：${model.recent_days} 天。`)
  lines.push('')
  for (const section of ['近期', '历史']) {
    const nodes = model.nodes.filter(node => node.section === section)
    if (!nodes.length) continue
    lines.push(`## ${section}`)
    for (const node of nodes) {
      const indent = '  '.repeat(node.level - 1)
      const date = node.last_activity ? node.last_activity.slice(0, 10) : ''
      const count = node.summary_count ? `${node.summary_count} 篇` : ''
      const meta = [node.status, date, count].filter(Boolean).join('｜')
      lines.push(`${indent}- ${node.title} [${node.id}]${meta ? ` ｜${meta}` : ''}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function summaryFiles(vault) {
  return fs.readdirSync(vault)
    .filter(name => /^SUMMARY_(?!INDEX).*\.md$/.test(name))
    .map(name => path.join(vault, name))
}

export function inWindow(stamp, sinceDays) {
  if (!stamp) return false
  const iso = stampToIso(stamp)
  if (!iso) return false
  return Date.parse(iso) >= Date.now() - sinceDays * 86400000
}

export function writeCompiled(file, model) {
  return writeJson(file, model)
}

export { writeAtomic }
