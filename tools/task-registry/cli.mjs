#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readText, writeAtomic, backup, sha256, nowIso, exists, ensureDir } from './lib/fsx.mjs'
import { parseTree, updateNodeMeta, isTaskId } from './lib/tree.mjs'
import { loadRules, classifySummary } from './lib/rules.mjs'
import { parseFrontmatter, summaryWindow, taskIds, addLabels, stripLabels, bodyHash } from './lib/summary.mjs'
import {
  vaultPaths, loadLinks, saveLinks, upsertLink, compileModel, renderFeishu,
  summaryFiles, inWindow, emptyLinks,
} from './lib/registry.mjs'

const EXIT = { ok: 0, attention: 2, config: 3, external: 4 }
const CONSOLE_URL = 'https://open.feishu.cn/page/scope-apply?clientID=cli_aa79ee689678dd03'

function parseArgs(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (!next || next.startsWith('--')) out.flags[key] = true
      else { out.flags[key] = next; i++ }
    } else out._.push(arg)
  }
  return out
}

const { _: positional, flags } = parseArgs(process.argv.slice(2))
const command = positional[0]
const dryRun = !flags.apply && !flags.force

function vaultDir() {
  const vault = flags.vault || process.env.TASK_REGISTRY_VAULT
  if (!vault) fail('config', 'missing --vault or TASK_REGISTRY_VAULT')
  return path.resolve(vault)
}

function fail(code, message, extra = {}) {
  const payload = { ok: false, error: message, ...extra }
  console.log(JSON.stringify(payload, null, 2))
  process.exit(typeof code === 'number' ? code : EXIT[code] || 3)
}

function ok(payload) {
  console.log(JSON.stringify({ ok: true, ...payload }, null, 2))
}

function loadTree(vault) {
  const p = vaultPaths(vault)
  if (!exists(p.tree)) fail('config', `task tree not found: ${p.tree}; run init --apply first`)
  const text = readText(p.tree)
  const tree = parseTree(text, { file: p.tree })
  tree.raw = text
  return { tree, paths: p }
}

function assertTree(tree) {
  if (tree.errors.length) fail('config', 'task tree is invalid', { errors: tree.errors, warnings: tree.warnings })
}

function loadTreeModel(vault) {
  const { tree, paths } = loadTree(vault)
  assertTree(tree)
  const links = loadLinks(paths.links)
  return { tree, paths, links }
}

function compileAndWrite(vault, { updateTree = true } = {}) {
  const { tree, paths, links } = loadTreeModel(vault)
  const model = compileModel(tree, links)
  let treeUpdated = false
  if (updateTree) {
    const updates = new Map()
    for (const node of model.nodes) {
      updates.set(node.id, {
        date: node.last_activity ? node.last_activity.slice(0, 10) : '',
        count: node.summary_count,
      })
    }
    const next = updateNodeMeta(tree.raw, updates)
    if (next.changed && exists(paths.tree)) {
      if (dryRun) treeUpdated = false
      else {
        backup(paths.tree, 'compile')
        writeAtomic(paths.tree, next.text)
        treeUpdated = true
      }
    }
    if (!dryRun) model.source_hash = sha256(readText(paths.tree))
  }
  let changed = false
  if (!dryRun) {
    const existing = exists(paths.tasks) ? JSON.parse(readText(paths.tasks)) : null
    const strip = value => JSON.stringify({ ...value, generated_at: null })
    if (!existing || strip(existing) !== strip(model)) {
      model.generated_at = nowIso()
      changed = writeAtomic(paths.tasks, `${JSON.stringify(model, null, 2)}\n`)
    }
  }
  return { model, changed, treeUpdated, paths }
}

function cmdInit() {
  const vault = vaultDir()
  const p = vaultPaths(vault)
  if (exists(p.tree)) fail('config', `already initialized: ${p.tree}`)
  if (dryRun) return ok({ mode: 'dry-run', wouldCreate: [p.tree, p.rules, p.links, p.tasks] })
  ensureDir(p.registry)
  const template = readText(path.join(import.meta.dirname, 'templates', '近期任务表.md'))
  writeAtomic(p.tree, template)
  writeAtomic(p.rules, readText(path.join(import.meta.dirname, 'templates', 'rules.example.json')))
  saveLinks(p.links, emptyLinks())
  const result = compileAndWrite(vault)
  return ok({ mode: 'apply', tree: p.tree, nodes: result.model.nodes.length, revision: result.model.revision })
}

function cmdCompile() {
  const vault = vaultDir()
  const result = compileAndWrite(vault)
  return ok({
    mode: dryRun ? 'dry-run' : 'apply',
    revision: result.model.revision,
    nodes: result.model.nodes.length,
    tasksChanged: result.changed,
    treeDateCountsUpdated: result.treeUpdated,
  })
}

function cmdDoctor() {
  const vault = vaultDir()
  const { tree, paths, links } = loadTreeModel(vault)
  const issues = [...tree.errors]
  const warnings = [...tree.warnings]
  let jsonStatus = 'missing'
  if (exists(paths.tasks)) {
    const json = JSON.parse(readText(paths.tasks))
    jsonStatus = json.source_hash === sha256(tree.raw) ? 'in-sync' : 'stale (run compile --apply)'
    const ids = new Set(json.nodes.map(node => node.id))
    if (ids.size !== json.nodes.length) issues.push('tasks.json has duplicate ids')
  }
  const linkIds = new Set(links.entries.flatMap(entry => (entry.assignments || []).map(a => a.task_id)))
  for (const id of linkIds) if (!tree.byId.has(id)) issues.push(`summary-links references unknown task ${id}`)
  const payload = {
    tree: paths.tree,
    nodes: tree.nodes.length,
    sections: [...new Set(tree.nodes.map(node => node.section))],
    json: jsonStatus,
    links: links.entries.length,
    issues,
    warnings,
  }
  if (issues.length) fail('config', 'doctor found issues', payload)
  if (flags.strict && warnings.length) fail('attention', 'doctor strict: warnings present', payload)
  return ok(payload)
}

function cmdLabel() {
  const summaryPath = path.resolve(flags.summary || fail('config', 'missing --summary'))
  const vault = vaultDir()
  const { tree, paths } = loadTreeModel(vault)
  const text = readText(summaryPath)
  const parsed = parseFrontmatter(text)
  const existing = taskIds(parsed.fm)
  if (existing.length && !flags.force) {
    return ok({ mode: 'skip', reason: 'summary already labelled', tasks: existing, file: summaryPath })
  }
  const rules = loadRules(paths.rules)
  const verdict = classifySummary({ body: parsed.body }, rules)
  let tasks = verdict.assignments.map(item => item.task_id)
  let primary = verdict.primary
  if (tasks.length === 0) {
    tasks = [tree.inboxId]
    primary = null
  }
  const unknown = tasks.filter(id => !tree.byId.has(id))
  if (unknown.length) fail('config', 'classified ids missing from tree', { unknown })
  const labeled = addLabels(text, {
    tasks,
    primary,
    rulesVersion: rules.version,
    method: 'rules',
    review: verdict.unresolved ? 'manual' : 'auto',
  })
  if (!dryRun) {
    backup(summaryPath, 'tasklabel')
    writeAtomic(summaryPath, labeled.text)
    const links = loadLinks(paths.links)
    const entry = {
      summary: path.basename(summaryPath),
      summary_sha256: sha256(labeled.text),
      window: summaryWindow(parsed.fm),
      assignments: verdict.assignments.length
        ? verdict.assignments.map(item => ({ ...item, role: item.task_id === primary ? 'primary' : 'secondary' }))
        : [{ task_id: tree.inboxId, role: 'secondary', evidence: 'no-rule-match', rule_id: 'inbox' }],
      rules_version: rules.version,
      method: 'rules',
      review: verdict.unresolved ? 'manual' : 'auto',
      at: nowIso(),
    }
    if (upsertLink(links, entry)) saveLinks(paths.links, links)
    compileAndWrite(vault)
  }
  return ok({
    mode: dryRun ? 'dry-run' : 'apply',
    file: summaryPath,
    tasks,
    primary,
    unresolved: verdict.unresolved,
    bodyHash: bodyHash(labeled.text),
  })
}

function scanTargets(vault, sinceDays) {
  const files = summaryFiles(vault)
  const out = []
  for (const file of files) {
    const text = readText(file)
    const parsed = parseFrontmatter(text)
    const window = summaryWindow(parsed.fm)
    let recent = inWindow(window.end, sinceDays)
    if (!window.end) {
      const mtime = fs.statSync(file).mtimeMs
      recent = mtime >= Date.now() - sinceDays * 86400000
    }
    if (recent) out.push({ file, text, parsed, window })
  }
  return out
}

function cmdScan() {
  const vault = vaultDir()
  const sinceDays = Number(flags['since-days'] || 30)
  const { tree, paths } = loadTreeModel(vault)
  const rules = loadRules(paths.rules)
  const links = loadLinks(paths.links)
  let added = 0
  let updated = 0
  const details = []
  for (const target of scanTargets(vault, sinceDays)) {
    const name = path.basename(target.file)
    const fmIds = taskIds(target.parsed.fm)
    const verdict = classifySummary({ body: target.parsed.body }, rules)
    let assignments = verdict.assignments
    let review = verdict.unresolved ? 'manual' : 'auto'
    if (fmIds.length) {
      const unknown = fmIds.filter(id => !tree.byId.has(id))
      if (unknown.length) {
        details.push({ summary: name, error: `unknown ids: ${unknown.join(',')}` })
        continue
      }
      assignments = fmIds.map((id, index) => ({
        task_id: id,
        role: id === target.parsed.fm.primary_task ? 'primary' : 'secondary',
        evidence: 'frontmatter',
        rule_id: 'frontmatter',
      }))
      review = 'frontmatter'
    } else if (!assignments.length) {
      assignments = [{ task_id: tree.inboxId, role: 'secondary', evidence: 'no-rule-match', rule_id: 'inbox' }]
    }
    const entry = {
      summary: name,
      summary_sha256: sha256(target.text),
      window: target.window,
      assignments,
      rules_version: rules.version,
      method: fmIds.length ? 'frontmatter' : 'rules',
      review,
      at: nowIso(),
    }
    const existed = links.entries.some(item => item.summary === name)
    if (!upsertLink(links, entry)) {
      details.push({ summary: name, status: 'unchanged' })
      continue
    }
    if (existed) updated += 1
    else added += 1
    details.push({ summary: name, status: 'linked', tasks: assignments.map(a => a.task_id) })
  }
  if (!dryRun) {
    saveLinks(paths.links, links)
    compileAndWrite(vault)
  }
  return ok({ mode: dryRun ? 'dry-run' : 'apply', sinceDays, added, updated, entries: links.entries.length, details })
}

function cmdCheck() {
  const vault = vaultDir()
  const { tree, paths } = loadTreeModel(vault)
  const links = loadLinks(paths.links)
  const sinceDays = Number(flags['since-days'] || 30)
  const problems = []
  for (const target of scanTargets(vault, sinceDays)) {
    const name = path.basename(target.file)
    const entry = links.entries.find(item => item.summary === name)
    const fmIds = taskIds(target.parsed.fm)
    if (!entry && !fmIds.length) problems.push({ summary: name, problem: 'not linked' })
    for (const id of fmIds) if (!tree.byId.has(id) || !isTaskId(id)) problems.push({ summary: name, problem: `invalid id ${id}` })
    if (entry) for (const a of entry.assignments || []) if (!tree.byId.has(a.task_id)) problems.push({ summary: name, problem: `unknown link ${a.task_id}` })
  }
  if (problems.length) fail('attention', 'check found unlinked or invalid summaries', { problems })
  return ok({ sinceDays, checked: scanTargets(vault, sinceDays).length })
}

function cmdUnlabel() {
  const summaryPath = path.resolve(flags.summary || fail('config', 'missing --summary'))
  const vault = vaultDir()
  const { paths } = loadTreeModel(vault)
  const text = readText(summaryPath)
  const next = stripLabels(text)
  if (dryRun) return ok({ mode: 'dry-run', file: summaryPath, changed: next !== text })
  backup(summaryPath, 'unlabel')
  writeAtomic(summaryPath, next)
  const links = loadLinks(paths.links)
  const before = links.entries.length
  links.entries = links.entries.filter(entry => entry.summary !== path.basename(summaryPath))
  if (links.entries.length !== before) saveLinks(paths.links, links)
  compileAndWrite(vault)
  return ok({ mode: 'apply', file: summaryPath, changed: next !== text })
}

function cmdFeishu() {
  const action = positional[1] || 'status'
  const vault = vaultDir()
  const { tree, paths } = loadTreeModel(vault)
  if (action === 'export') {
    const links = loadLinks(paths.links)
    const model = compileModel(tree, links)
    const text = renderFeishu(tree, model)
    if (!dryRun) writeAtomic(paths.feishu, text)
    return ok({ mode: dryRun ? 'dry-run' : 'apply', file: paths.feishu, chars: text.length, url: model.feishu.url })
  }
  if (action === 'preflight' || action === 'status') {
    let cli = null
    try { cli = execFileSync('lark-cli', ['--version'], { encoding: 'utf8' }).trim() } catch { /* not installed */ }
    const payload = {
      feishu: { state: tree.feishuState, url: tree.feishuUrl, binding_doc: paths.feishu },
      larkCli: cli || 'missing',
      requiredScopes: ['docx:document', 'docx:document:create', 'drive:drive', 'drive:file'],
      console: CONSOLE_URL,
      action: tree.feishuUrl ? 'verify-access' : 'apply-scopes-then-create',
    }
    if (!tree.feishuUrl) {
      console.log(JSON.stringify({ ok: false, error: 'feishu document not created yet: app scopes pending', ...payload }, null, 2))
      process.exit(EXIT.external)
    }
    return ok(payload)
  }
  fail('config', `unknown feishu action: ${action}`)
}

const commands = { init: cmdInit, compile: cmdCompile, doctor: cmdDoctor, label: cmdLabel, scan: cmdScan, check: cmdCheck, unlabel: cmdUnlabel, feishu: cmdFeishu }
if (!command || !commands[command]) {
  fail('config', `usage: cli.mjs <${Object.keys(commands).join('|')}> [--vault <vault>] [--apply]`)
}
commands[command]()
