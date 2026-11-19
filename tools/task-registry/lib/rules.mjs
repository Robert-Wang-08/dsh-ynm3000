import fs from 'node:fs'

const EVIDENCE_RE = /(执行cwd|\]\(<|[A-Za-z]:[\\/]|git (?:log|commit)|提交 [0-9a-f]{7,}|\/src\/|\\\\src\\|\.md\b)/

export function loadRules(file) {
  const rules = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!rules.tasks || typeof rules.tasks !== 'object') throw new Error('rules.tasks missing')
  return { version: rules.version || '1.0.0', tasks: rules.tasks }
}

function lower(text) {
  return String(text).toLowerCase()
}

export function itemTexts(body) {
  const lines = body.split('\n')
  const items = []
  let current = null
  for (const line of lines) {
    const heading = line.match(/^###\s+(.+?)\s*$/)
    if (heading) {
      if (current) items.push(current)
      current = { title: heading[1], text: heading[1] }
      continue
    }
    if (current) current.text += `\n${line}`
  }
  if (current) items.push(current)
  if (items.length === 0) items.push({ title: '(whole)', text: body })
  return items
}

export function workspacesOf(text) {
  const value = lower(text)
  const out = new Set()
  if (/src[\\/]dsh|\.dsh[\\/]|dsh-superagent|dsh-(?:plugin|config|provider)|superagent profile/.test(value)) out.add('dsh')
  if (/(?:^|[\\/\s(])(?:ncbs|cbs|ca)(?:[\\/\s).]|$)|cbs-cr|ncbs-cr/.test(value)) out.add('ncbs')
  if (/logseq|nutstore/.test(value)) out.add('logseq')
  return out
}

export function hasEvidence(text) {
  return EVIDENCE_RE.test(text)
}

export function matchItem(text, rules) {
  const value = lower(text)
  const workspaces = workspacesOf(text)
  const hits = []
  if (!hasEvidence(text)) return hits
  for (const [taskId, rule] of Object.entries(rules.tasks)) {
    if (rule.enabled === false) continue
    const required = rule.workspaces || []
    if (required.length && !required.some(w => workspaces.has(w))) continue
    const all = rule.keywords_all || []
    if (all.length && !all.every(k => value.includes(lower(k)))) continue
    const any = rule.keywords_any || []
    if (any.length && !any.some(k => value.includes(lower(k)))) continue
    const exclude = rule.exclude || []
    if (exclude.some(k => value.includes(lower(k)))) continue
    if (!all.length && !any.length && !(rule.aliases || []).length) continue
    const aliasHit = (rule.aliases || []).some(a => value.includes(lower(a)))
    if (!all.length && !any.length && !aliasHit) continue
    hits.push(taskId)
  }
  return hits
}

/**
 * Deterministic classification of one summary.
 * Returns aggregated assignments per task; the caller decides primary/INBOX.
 */
export function classifySummary({ body }, rules) {
  const items = itemTexts(body)
  const perTask = new Map()
  for (const item of items) {
    const taskIds = matchItem(item.text, rules)
    for (const id of taskIds) {
      const entry = perTask.get(id) || { task_id: id, hits: 0, evidence: [] }
      entry.hits += 1
      if (entry.evidence.length < 3) entry.evidence.push(item.title.slice(0, 60))
      perTask.set(id, entry)
    }
  }
  const ranked = [...perTask.values()].sort((a, b) => b.hits - a.hits || a.task_id.localeCompare(b.task_id))
  let primary = null
  if (ranked.length === 1) primary = ranked[0].task_id
  else if (ranked.length > 1 && ranked[0].hits > ranked[1].hits) primary = ranked[0].task_id
  return {
    items: items.length,
    assignments: ranked.map(entry => ({
      task_id: entry.task_id,
      role: entry.task_id === primary ? 'primary' : 'secondary',
      hits: entry.hits,
      evidence: entry.evidence.join('；'),
      rule_id: `rule:${entry.task_id}`,
    })),
    primary,
    unresolved: ranked.length === 0,
  }
}
