import { sha256 } from './fsx.mjs'
import { splitFrontmatter } from './tree.mjs'

const LABEL_KEYS = ['tasks', 'primary_task', 'task_labeling']
const KEY_RE = /^[A-Za-z_][\w-]*:/

export function bodyHash(text) {
  return sha256(splitFrontmatter(text).body)
}

export function summaryFileHash(text) {
  return sha256(text)
}

/** Tolerant frontmatter reader: flat scalars, inline arrays and simple block lists. */
export function parseFrontmatter(text) {
  const { frontmatter, body, hasFrontmatter } = splitFrontmatter(text)
  const fm = {}
  const lines = frontmatter.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(KEY_RE)
    if (!m) continue
    const key = m[0].slice(0, -1)
    const raw = lines[i].slice(m[0].length).trim()
    if (raw === '') {
      const items = []
      let j = i + 1
      while (j < lines.length && /^\s+/.test(lines[j]) && !KEY_RE.test(lines[j].trim())) {
        const item = lines[j].trim()
        if (item.startsWith('- ')) items.push(unquote(item.slice(2).trim()))
        j++
      }
      fm[key] = items
      continue
    }
    if (raw.startsWith('[') && raw.endsWith(']')) {
      fm[key] = raw.slice(1, -1).split(',').map(v => unquote(v.trim())).filter(Boolean)
      continue
    }
    fm[key] = unquote(raw)
  }
  return { fm, body, frontmatter, hasFrontmatter }
}

function unquote(value) {
  return value.replace(/^['"]|['"]$/g, '')
}

/** Normalized window: `YYYYMMDD-HHmm`, from either frontmatter dialect. */
export function summaryWindow(fm) {
  const start = fm.summary_start || fm.start || null
  const end = fm.summary_end || fm.end || null
  return {
    start: normalizeStamp(start),
    end: normalizeStamp(end),
  }
}

export function normalizeStamp(value) {
  if (!value) return null
  const compact = String(value).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/)
  if (compact) return `${compact[1]}${compact[2]}${compact[3]}-${compact[4]}${compact[5]}`
  const m = String(value).match(/^(\d{4})-?(\d{2})-?(\d{2})[ T](\d{2}):?(\d{2})/)
  if (!m) return null
  return `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}`
}

export function stampToIso(stamp) {
  if (!stamp) return null
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+08:00`
}

export function taskIds(fm) {
  const value = fm.tasks
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) return value.split(',').map(v => v.trim()).filter(Boolean)
  return []
}

/** Remove the three tool-owned keys and their continuation lines. */
export function stripLabels(text) {
  const { frontmatter, body, hasFrontmatter } = splitFrontmatter(text)
  if (!hasFrontmatter) return text
  const lines = frontmatter.split('\n')
  const kept = []
  let skip = false
  for (const line of lines) {
    if (KEY_RE.test(line)) {
      const key = line.match(KEY_RE)[0].slice(0, -1)
      skip = LABEL_KEYS.includes(key)
      if (skip) continue
    } else if (skip && /^\s/.test(line)) {
      continue
    } else {
      skip = false
    }
    kept.push(line)
  }
  const head = `---\n${kept.join('\n').replace(/^\n+/, '').replace(/\n+$/, '')}\n---\n`
  return `${head}${body}`
}

export function addLabels(text, { tasks, primary, taxonomyRevision = 1, rulesVersion = '1.0.0', method = 'rules', review = 'auto' }) {
  const cleaned = stripLabels(text)
  const { frontmatter, body } = splitFrontmatter(cleaned)
  const lines = frontmatter.split('\n').filter(Boolean)
  lines.push('tasks:')
  for (const id of tasks) lines.push(`  - ${id}`)
  if (primary) lines.push(`primary_task: ${primary}`)
  lines.push('task_labeling:')
  lines.push(`  taxonomy_revision: ${taxonomyRevision}`)
  lines.push(`  rules_version: ${rulesVersion}`)
  lines.push(`  method: ${method}`)
  lines.push(`  review: ${review}`)
  const next = `---\n${lines.join('\n')}\n---\n${body}`
  return { text: next, changed: next !== text }
}

/** Guarded in-place summary edit: refuses to touch the body and keeps a backup upstream. */
export function labelsEqual(fm, { tasks, primary }) {
  const current = taskIds(fm)
  const currentPrimary = fm.primary_task || null
  if (current.length !== tasks.length) return false
  for (let i = 0; i < tasks.length; i++) if (current[i] !== tasks[i]) return false
  return currentPrimary === (primary || null)
}
