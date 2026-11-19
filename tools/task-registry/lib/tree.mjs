const ID_RE = /^T-[A-Z0-9][A-Z0-9-]{1,38}$/
const STATUS = ['待人工', '待决定', '待外部', '在办', '已闭环', '作废']
const SECTIONS = ['近期', '历史']

export function isTaskId(value) {
  return typeof value === 'string' && ID_RE.test(value)
}

export function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { frontmatter: '', body: text, hasFrontmatter: false }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { frontmatter: '', body: text, hasFrontmatter: false }
  const after = text.indexOf('\n', end + 4)
  const fm = text.slice(3, end).replace(/^\n/, '')
  return {
    frontmatter: fm,
    body: after < 0 ? '' : text.slice(after + 1),
    hasFrontmatter: true,
  }
}

export function frontmatterValue(frontmatter, key) {
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm')
  const m = frontmatter.match(re)
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined
}

/**
 * Parse the task table markdown.
 * Node line: `- \`T-ID\` title ｜status｜YYYY-MM-DD｜N 篇` (full-width or ASCII pipes).
 */
export function parseTree(text, { file = 'tree.md' } = {}) {
  const { frontmatter, body } = splitFrontmatter(text)
  const errors = []
  const warnings = []
  const nodes = []
  const lines = body.split('\n')
  let section = null
  let stack = []
  let order = new Map()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      section = heading[1]
      stack = []
      if (!SECTIONS.includes(section)) warnings.push(`line ${i + 1}: unexpected section "${section}"`)
      continue
    }
    const m = line.match(/^(\s*)-\s+`([^`]+)`\s*(.*)$/)
    if (!m) continue
    const indent = m[1].replace(/\t/g, '  ')
    if (indent.length % 2 !== 0) errors.push(`line ${i + 1}: indent must be a multiple of 2 spaces`)
    const level = indent.length / 2 + 1
    const id = m[2].trim()
    const rest = m[3]
    if (!isTaskId(id)) errors.push(`line ${i + 1}: invalid task id "${id}"`)
    const parts = rest.split(/[｜|]/).map(part => part.trim())
    const title = parts[0] || '(untitled)'
    const status = parts[1] || ''
    const date = parts[2] || ''
    const countMatch = (parts[3] || '').match(/^(\d+)/)
    if (status && !STATUS.includes(status)) warnings.push(`line ${i + 1}: unknown status "${status}"`)
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) warnings.push(`line ${i + 1}: bad date "${date}"`)
    if (level > 3) errors.push(`line ${i + 1}: depth ${level} > 3`)

    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    const parent = level === 1 ? null : stack[stack.length - 1]
    if (level > 1 && !parent) errors.push(`line ${i + 1}: level ${level} node has no parent`)
    if (parent && parent.level !== level - 1) errors.push(`line ${i + 1}: indent jumps from level ${parent.level} to ${level}`)

    const key = section || '未分区'
    const index = order.get(key) || 0
    order.set(key, index + 1)
    const node = {
      id,
      title,
      status: status || null,
      last_date: date || null,
      summary_count: countMatch ? Number(countMatch[1]) : 0,
      level,
      parent_id: parent ? parent.id : null,
      section: key,
      order: index,
      line: i + 1,
    }
    if (nodes.some(n => n.id === id)) errors.push(`line ${i + 1}: duplicate task id "${id}"`)
    nodes.push(node)
    stack.push(node)
  }

  const byId = new Map(nodes.map(n => [n.id, n]))
  for (const node of nodes) {
    if (node.parent_id && !byId.has(node.parent_id)) errors.push(`line ${node.line}: parent "${node.parent_id}" missing`)
  }
  const inboxId = frontmatterValue(frontmatter, 'inbox_id') || 'T-INBOX'
  if (!byId.has(inboxId)) errors.push(`inbox task "${inboxId}" missing`)

  return {
    file,
    frontmatter,
    body,
    nodes,
    byId,
    inboxId,
    recentDays: Number(frontmatterValue(frontmatter, 'recent_days') || 30),
    feishuUrl: frontmatterValue(frontmatter, 'feishu_url') || null,
    feishuState: frontmatterValue(frontmatter, 'feishu_state') || 'pending_scope',
    errors,
    warnings,
  }
}

/** Rewrite only date/count fields of node lines; everything else stays byte-identical. */
export function updateNodeMeta(text, updates) {
  const { body } = splitFrontmatter(text)
  let changed = false
  const out = body.split('\n').map(line => {
    const m = line.match(/^(\s*)-\s+`([^`]+)`\s*(.*)$/)
    if (!m) return line
    const update = updates.get(m[2].trim())
    if (!update) return line
    const parts = m[3].split(/[｜|]/).map(part => part.trim())
    const title = parts[0] || '(untitled)'
    const status = parts[1] || ''
    const date = update.date !== undefined ? update.date : (parts[2] || '')
    const count = update.count === undefined ? (parts[3] || '') : (update.count > 0 ? `${update.count} 篇` : '')
    const next = `${m[1]}- \`${m[2].trim()}\` ${title} ｜${status}${date ? `｜${date}` : ''}${count ? `｜${count}` : ''}`
    if (next !== line) changed = true
    return next
  })
  if (!changed) return { text, changed }
  const head = text.startsWith('---') ? text.slice(0, text.indexOf('\n---') + 4) : ''
  return { text: head ? `${head}\n${out.join('\n')}` : out.join('\n'), changed }
}

export function sectionOf(tree, id) {
  return tree.byId.get(id)?.section || null
}

export function descendants(tree, id) {
  const out = []
  const walk = parent => {
    for (const node of tree.nodes) {
      if (node.parent_id === parent) {
        out.push(node.id)
        walk(node.id)
      }
    }
  }
  walk(id)
  return out
}
