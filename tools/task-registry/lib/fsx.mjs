import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

export function exists(file) {
  return fs.existsSync(file)
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** Copy the file next to itself before an in-place edit; keeps the last 5 backups per tag. */
export function backup(file, tag = 'edit') {
  if (!fs.existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.bak-before-${tag}-${stamp}`
  fs.copyFileSync(file, target)
  const dir = path.dirname(file)
  const base = path.basename(file)
  const prefix = `${base}.bak-before-${tag}-`
  const old = fs.readdirSync(dir).filter(name => name.startsWith(prefix)).sort()
  for (const name of old.slice(0, Math.max(0, old.length - 5))) {
    try { fs.unlinkSync(path.join(dir, name)) } catch { /* best effort */ }
  }
  return target
}

/** Write through a temp file on the same volume, then replace. Returns true when content changed. */
export function writeAtomic(file, text) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
  return true
}

export function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function writeJson(file, value) {
  return writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function nowIso() {
  const d = new Date()
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const pad = n => String(Math.abs(n)).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
}

export function today() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function daysAgoIso(days) {
  const d = new Date(Date.now() - days * 86400000)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const pad = n => String(Math.abs(n)).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
}
