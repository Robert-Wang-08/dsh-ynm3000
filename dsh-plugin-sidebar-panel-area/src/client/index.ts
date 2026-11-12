/**
 * @local/dsh-plugin-sidebar-panel-area — browser half.
 *
 * DOM-level enhancement of the official sidebar shell (no core patch):
 *  - inserts a 16px resize bar between the global-panel list and the
 *    workspace/session region;
 *  - dragging (or the keyboard) caps the panel list height; when the list is
 *    taller than its box, the viewport is anchored to the BOTTOM, so the top
 *    entries scroll out and the tail (latest entries + More) stays visible;
 *  - double-click / the chevron collapses to the trailing three rows (an
 *    "upward" collapse): the top entries are hidden, registration order is
 *    untouched;
 *  - remembers `{ height, collapsed }` in localStorage.
 *
 * The plugin only relies on the two structural points the official shell has
 * kept stable (`nav[class*="_panelList"]` followed by the region seat) and
 * restores every inline style it sets when disposed. Rail mode (56px sidebar)
 * is left untouched.
 */

const STORAGE_KEY = 'dsh.sidebar-panel-area.v1'
const STYLE_ID = 'dsh-sidebar-panel-area-style'
const NAV_SELECTOR = 'nav[class*="_panelList"]'
const REGION_SELECTOR = '[class*="_regionArea"]'
const FOOT_SELECTOR = '[class*="_footArea"]'
const ROOT_ATTR = 'data-dsh-panel-area'
const COLLAPSED_ATTR = 'data-dsh-panel-area-collapsed'
const BAR_CLASS = 'dsh-pa-bar'
const HANDLE_CLASS = 'dsh-pa-handle'
const TOGGLE_CLASS = 'dsh-pa-toggle'
const DRAGGING_CLASS = 'dsh-pa-dragging'

const MIN_HEIGHT = 44
const MIN_REGION = 180
const DEFAULT_RATIO = 0.4
const BAR_HEIGHT = 16
/** Collapsed state keeps this many trailing launcher rows visible. */
const COLLAPSED_ROWS = 3

interface Prefs {
  height: number | null
  collapsed: boolean
}

interface OriginalStyles {
  height: string
  maxHeight: string
  overflowY: string
  overscrollBehavior: string
  scrollbarGutter: string
  display: string
  marginBottom: string
  navId: string
  weSetId: boolean
}

interface Mounted {
  root: HTMLElement
  nav: HTMLElement
  bar: HTMLElement
  handle: HTMLElement
  toggle: HTMLButtonElement
  toggleText: HTMLSpanElement
  foot: HTMLElement | null
  prefs: Prefs
  original: OriginalStyles
}

interface DragState {
  pointerId: number
  startY: number
  startHeight: number
  lastHeight: number
  moved: boolean
}

const zh = (() => {
  const lang = `${document.documentElement.lang} ${navigator.language ?? ''}`.toLowerCase()
  return lang.includes('zh')
})()

const L = zh
  ? {
      resize: '调整插件区高度',
      resizeTitle: '拖动调整插件区高度；双击折叠或展开',
      collapse: '折叠插件区',
      expand: '展开插件区',
      expandShort: '展开',
    }
  : {
      resize: 'Resize the panel area',
      resizeTitle: 'Drag to resize the panel area; double-click to collapse or expand',
      collapse: 'Collapse panel area',
      expand: 'Expand panel area',
      expandShort: 'Expand',
    }

let active: Mounted | null = null
let bodyObserver: MutationObserver | null = null
let rootObserver: MutationObserver | null = null
let rootResize: ResizeObserver | null = null
let styleEl: HTMLStyleElement | null = null
let scheduled = false
let drag: DragState | null = null
let booted = false

/* ------------------------------------------------------------------ prefs */

function readPrefs(): Prefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (raw !== null && raw !== undefined) {
      const parsed = JSON.parse(raw) as Partial<Prefs>
      const height = typeof parsed.height === 'number' && Number.isFinite(parsed.height) && parsed.height > 0
        ? parsed.height
        : null
      return { height, collapsed: parsed.collapsed === true }
    }
  } catch { /* corrupt or unavailable storage: fall back to defaults */ }
  return { height: null, collapsed: false }
}

function writePrefs(prefs: Prefs): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch { /* private mode / quota: in-memory only */ }
}

/* ------------------------------------------------------------------ style */

const CSS = `
.${BAR_CLASS}{flex:none;display:flex;align-items:center;gap:2px;height:${BAR_HEIGHT}px;margin:0 2px 2px;position:relative;box-sizing:border-box}
.${HANDLE_CLASS}{flex:1;min-width:24px;height:${BAR_HEIGHT}px;position:relative;cursor:row-resize;touch-action:none;border-radius:6px;outline:none}
.${HANDLE_CLASS}::before{content:'';position:absolute;left:50%;top:50%;width:36px;height:2px;transform:translate(-50%,-50%);border-radius:1px;background:var(--dsw-alias-border-l3,#c9ccd1);opacity:.35;transition:opacity .12s ease}
.${BAR_CLASS}:hover .${HANDLE_CLASS}::before,.${HANDLE_CLASS}:focus-visible::before,.${DRAGGING_CLASS} .${HANDLE_CLASS}::before{opacity:1}
.${HANDLE_CLASS}:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4c8dff));outline-offset:-2px}
.${TOGGLE_CLASS}{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:${BAR_HEIGHT}px;min-width:${BAR_HEIGHT}px;padding:0;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a6);font:inherit;font-size:11px;line-height:1;cursor:pointer;opacity:0;transition:opacity .12s ease,background .12s ease}
.${BAR_CLASS}:hover .${TOGGLE_CLASS},.${TOGGLE_CLASS}:focus-visible,${'['}${COLLAPSED_ATTR}${']'} .${TOGGLE_CLASS}{opacity:1}
.${TOGGLE_CLASS}:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18))}
.${TOGGLE_CLASS}:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4c8dff));outline-offset:-1px}
.${TOGGLE_CLASS} svg{width:12px;height:12px;flex:none}
.${TOGGLE_CLASS} .dsh-pa-toggle-text{display:none;white-space:nowrap}
${'['}${COLLAPSED_ATTR}${']'} .${TOGGLE_CLASS}{opacity:1;width:auto;padding:0 6px}
${'['}${COLLAPSED_ATTR}${']'} .${TOGGLE_CLASS} .dsh-pa-toggle-text{display:inline}
.${DRAGGING_CLASS}{cursor:row-resize;user-select:none}
@media (prefers-reduced-motion:reduce){.${HANDLE_CLASS}::before,.${TOGGLE_CLASS}{transition:none}}
`

function injectStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.append(style)
  styleEl = style
}

/* ------------------------------------------------------------------ icons */

const CHEVRON_UP = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const CHEVRON_DOWN = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/* ------------------------------------------------------------------ geometry */

function isRail(root: HTMLElement): boolean {
  return root.clientWidth <= 100 || root.className.includes('_collapsed')
}

function absoluteMax(m: Mounted): number {
  const rootRect = m.root.getBoundingClientRect()
  const navRect = m.nav.getBoundingClientRect()
  const footHeight = m.foot?.getBoundingClientRect().height ?? 0
  const barHeight = m.bar.getBoundingClientRect().height || BAR_HEIGHT
  const navTop = navRect.top - rootRect.top
  return Math.max(MIN_HEIGHT, Math.floor(rootRect.height - navTop - barHeight - footHeight - MIN_REGION - 4))
}

/**
 * Height that keeps the trailing {@link COLLAPSED_ROWS} launcher rows visible.
 * Measuring the rows (rather than assuming 36px) keeps the last row — usually
 * "More" — fully in view when labels wrap or the density changes.
 */
function collapsedHeight(m: Mounted): number {
  const rows = Array.from(m.nav.children).filter((el): el is HTMLElement => el instanceof HTMLElement)
  const tail = rows.slice(-COLLAPSED_ROWS)
  const gap = Number.parseFloat(getComputedStyle(m.nav).rowGap) || 0
  const total = tail.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0)
    + gap * Math.max(0, tail.length - 1)
  return Math.max(MIN_HEIGHT, Math.round(total))
}

/** Show the tail of the list: the top rows scroll out, the bottom stays put. */
function anchorBottom(m: Mounted): void {
  m.nav.scrollTop = m.nav.scrollHeight
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/* ------------------------------------------------------------------ mount */

function findNav(): HTMLElement | null {
  for (const nav of document.querySelectorAll<HTMLElement>(NAV_SELECTOR)) {
    if (nav.getBoundingClientRect().width <= 0) continue
    const root = nav.parentElement
    if (root === null || root.querySelector(REGION_SELECTOR) === null) continue
    return nav
  }
  return null
}

function createBar(navId: string): { bar: HTMLElement; handle: HTMLElement; toggle: HTMLButtonElement; toggleText: HTMLSpanElement } {
  const bar = document.createElement('div')
  bar.className = BAR_CLASS

  const handle = document.createElement('div')
  handle.className = HANDLE_CLASS
  handle.tabIndex = 0
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-orientation', 'horizontal')
  handle.setAttribute('aria-label', L.resize)
  handle.setAttribute('aria-controls', navId)
  handle.title = L.resizeTitle

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = TOGGLE_CLASS
  toggle.setAttribute('aria-controls', navId)
  toggle.title = L.collapse
  const toggleText = document.createElement('span')
  toggleText.className = 'dsh-pa-toggle-text'
  toggle.innerHTML = CHEVRON_UP
  toggle.append(toggleText)

  bar.append(handle, toggle)
  return { bar, handle, toggle, toggleText }
}

function mount(nav: HTMLElement): void {
  unmount()
  const root = nav.parentElement
  if (root === null) return
  const foot = root.querySelector<HTMLElement>(FOOT_SELECTOR)
  const navId = nav.id || 'dsh-pa-panel-list'
  const weSetId = nav.id === ''
  if (weSetId) nav.id = navId

  const { bar, handle, toggle, toggleText } = createBar(navId)
  nav.after(bar)

  const m: Mounted = {
    root,
    nav,
    bar,
    handle,
    toggle,
    toggleText,
    foot,
    prefs: readPrefs(),
    original: {
      height: nav.style.height,
      maxHeight: nav.style.maxHeight,
      overflowY: nav.style.overflowY,
      overscrollBehavior: nav.style.overscrollBehavior,
      scrollbarGutter: nav.style.scrollbarGutter,
      display: nav.style.display,
      marginBottom: nav.style.marginBottom,
      navId,
      weSetId,
    },
  }
  active = m
  root.setAttribute(ROOT_ATTR, '')

  handle.addEventListener('pointerdown', event => { startDrag(event, m) })
  handle.addEventListener('pointermove', event => { moveDrag(event, m) })
  handle.addEventListener('pointerup', endDrag)
  handle.addEventListener('pointercancel', endDrag)
  handle.addEventListener('lostpointercapture', endDrag)
  handle.addEventListener('dblclick', event => {
    event.preventDefault()
    setCollapsed(m, !m.prefs.collapsed)
  })
  handle.addEventListener('keydown', event => { onKey(event, m) })
  toggle.addEventListener('click', event => {
    event.preventDefault()
    setCollapsed(m, !m.prefs.collapsed)
  })

  rootResize = new ResizeObserver(() => { if (active === m) applyLayout(m) })
  rootResize.observe(root)

  rootObserver = new MutationObserver(() => { scheduleEnsure() })
  rootObserver.observe(root, { attributes: true, attributeFilter: ['class'] })

  applyLayout(m)
}

function unmount(): void {
  if (active === null) return
  const m = active
  active = null
  drag = null
  rootResize?.disconnect()
  rootResize = null
  rootObserver?.disconnect()
  rootObserver = null
  m.bar.remove()
  m.root.removeAttribute(ROOT_ATTR)
  m.root.removeAttribute(COLLAPSED_ATTR)
  m.root.classList.remove(DRAGGING_CLASS)
  const s = m.nav.style
  s.height = m.original.height
  s.maxHeight = m.original.maxHeight
  s.overflowY = m.original.overflowY
  s.overscrollBehavior = m.original.overscrollBehavior
  s.scrollbarGutter = m.original.scrollbarGutter
  s.display = m.original.display
  s.marginBottom = m.original.marginBottom
  if (m.original.weSetId) m.nav.removeAttribute('id')
}

function ensureMounted(): void {
  // A collapsed panel list is intentionally display:none; keep it mounted and
  // let the early path below own it instead of treating it as "no sidebar".
  if (active !== null && active.nav.isConnected) {
    if (!active.bar.isConnected) active.nav.after(active.bar)
    applyLayout(active)
    return
  }
  const nav = findNav()
  if (nav === null) {
    if (active !== null) unmount()
    return
  }
  if (active !== null) unmount()
  mount(nav)
}

function scheduleEnsure(): void {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    if (booted) ensureMounted()
  })
}

/* ------------------------------------------------------------------ layout */

function resetNav(m: Mounted): void {
  const s = m.nav.style
  s.height = m.original.height
  s.maxHeight = m.original.maxHeight
  s.overflowY = m.original.overflowY
  s.overscrollBehavior = m.original.overscrollBehavior
  s.scrollbarGutter = m.original.scrollbarGutter
  s.marginBottom = m.original.marginBottom
  m.nav.scrollTop = 0
}

function applyLayout(m: Mounted): void {
  // A drag owns the height until it ends; a class mutation (the drag hook) must
  // not reset the list to the persisted preference mid-gesture.
  if (drag !== null) return
  if (isRail(m.root)) {
    m.bar.style.display = 'none'
    resetNav(m)
    return
  }

  m.bar.style.display = 'flex'

  if (m.prefs.collapsed) {
    // "Upward" collapse: keep the list in the flow, clip the TOP rows and pin
    // the viewport to the tail (latest/More stay reachable). The registration
    // order is untouched; the hidden head is reachable by scrolling or the
    // expand toggle.
    m.root.setAttribute(COLLAPSED_ATTR, '')
    m.nav.style.display = m.original.display
    m.nav.style.marginBottom = '0'
    m.nav.style.overflowY = 'auto'
    m.nav.style.overscrollBehavior = 'contain'
    m.nav.style.scrollbarGutter = 'stable'
    const max = absoluteMax(m)
    const target = Math.min(collapsedHeight(m), max)
    m.nav.style.height = `${target}px`
    m.nav.style.maxHeight = `${target}px`
    anchorBottom(m)
    updateAria(m, max)
    updateToggle(m)
    return
  }

  m.root.removeAttribute(COLLAPSED_ATTR)
  m.nav.style.display = m.original.display
  const max = absoluteMax(m)
  const target = m.prefs.height === null
    ? Math.min(Math.round(m.root.clientHeight * DEFAULT_RATIO), max)
    : clamp(m.prefs.height, MIN_HEIGHT, max)

  m.nav.style.marginBottom = '0'
  m.nav.style.overflowY = 'auto'
  m.nav.style.overscrollBehavior = 'contain'
  m.nav.style.scrollbarGutter = 'stable'
  if (m.prefs.height === null) {
    m.nav.style.height = 'auto'
    m.nav.style.maxHeight = `${target}px`
  } else {
    m.nav.style.height = `${target}px`
    m.nav.style.maxHeight = `${target}px`
  }
  // When the list is taller than the box, show its tail rather than its head:
  // the bottom entries (and "More") stay visible, the top entries scroll out.
  anchorBottom(m)
  updateAria(m, max)
  updateToggle(m)
}

function updateAria(m: Mounted, max: number): void {
  m.handle.setAttribute('aria-valuemin', String(MIN_HEIGHT))
  m.handle.setAttribute('aria-valuemax', String(max))
  m.handle.setAttribute('aria-valuenow', String(Math.round(m.nav.getBoundingClientRect().height) || MIN_HEIGHT))
}

function updateToggle(m: Mounted): void {
  const collapsed = m.prefs.collapsed
  m.toggle.setAttribute('aria-expanded', String(!collapsed))
  const label = collapsed ? L.expand : L.collapse
  m.toggle.setAttribute('aria-label', label)
  m.toggle.title = label
  m.toggle.innerHTML = collapsed ? CHEVRON_DOWN : CHEVRON_UP
  m.toggle.append(m.toggleText)
  m.toggleText.textContent = collapsed ? L.expandShort : ''
}

function setCollapsed(m: Mounted, collapsed: boolean): void {
  if (m.prefs.collapsed === collapsed) return
  m.prefs = { ...m.prefs, collapsed }
  writePrefs(m.prefs)
  applyLayout(m)
}

function setHeight(m: Mounted, height: number, persist: boolean): number {
  const max = absoluteMax(m)
  const next = Math.round(clamp(height, MIN_HEIGHT, max))
  m.nav.style.height = `${next}px`
  m.nav.style.maxHeight = `${next}px`
  m.nav.style.overflowY = 'auto'
  m.nav.style.marginBottom = '0'
  anchorBottom(m)
  if (persist) {
    m.prefs = { ...m.prefs, height: next, collapsed: false }
    writePrefs(m.prefs)
  }
  updateAria(m, max)
  return next
}

/* ------------------------------------------------------------------ drag */

function startDrag(event: PointerEvent, m: Mounted): void {
  if (event.button !== 0 && event.pointerType !== 'touch') return
  event.preventDefault()
  if (m.prefs.collapsed) setCollapsed(m, false)
  const startHeight = m.nav.getBoundingClientRect().height
  drag = {
    pointerId: event.pointerId,
    startY: event.clientY,
    startHeight,
    lastHeight: startHeight,
    moved: false,
  }
  m.handle.setPointerCapture(event.pointerId)
  m.root.classList.add(DRAGGING_CLASS)
}

function moveDrag(event: PointerEvent, m: Mounted): void {
  if (drag === null || event.pointerId !== drag.pointerId) return
  const dy = event.clientY - drag.startY
  if (Math.abs(dy) > 2) drag.moved = true
  drag.lastHeight = setHeight(m, drag.startHeight + dy, false)
}

function endDrag(event?: PointerEvent): void {
  if (drag === null) return
  const m = active
  const moved = drag.moved
  const height = drag.lastHeight
  drag = null
  if (m === null) return
  m.root.classList.remove(DRAGGING_CLASS)
  if (event !== undefined && m.handle.hasPointerCapture(event.pointerId)) {
    m.handle.releasePointerCapture(event.pointerId)
  }
  if (!moved) return
  if (height <= MIN_HEIGHT + 1) {
    setCollapsed(m, true)
  } else {
    m.prefs = { ...m.prefs, height, collapsed: false }
    writePrefs(m.prefs)
    applyLayout(m)
  }
}

function onKey(event: KeyboardEvent, m: Mounted): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    setCollapsed(m, !m.prefs.collapsed)
    return
  }
  if (m.prefs.collapsed) setCollapsed(m, false)
  const max = absoluteMax(m)
  const current = m.prefs.height ?? m.nav.getBoundingClientRect().height
  let next: number
  switch (event.key) {
    case 'ArrowUp': next = current - 16; break
    case 'ArrowDown': next = current + 16; break
    case 'PageUp': next = current - 64; break
    case 'PageDown': next = current + 64; break
    case 'Home': next = MIN_HEIGHT; break
    case 'End': next = max; break
    default:
      return
  }
  event.preventDefault()
  m.prefs = { ...m.prefs, height: Math.round(clamp(next, MIN_HEIGHT, max)), collapsed: false }
  writePrefs(m.prefs)
  applyLayout(m)
}

/* ------------------------------------------------------------------ start */

function start(): () => void {
  if (typeof document === 'undefined' || booted) return () => {}
  booted = true
  injectStyle()
  const observe = (): void => {
    if (!booted || bodyObserver !== null) return
    bodyObserver = new MutationObserver(() => {
      // Once mounted, only a lost nav/bar needs a re-discovery pass; other app
      // mutations (chat streaming) must not schedule work every frame.
      if (active !== null && active.nav.isConnected && active.bar.isConnected) return
      scheduleEnsure()
    })
    bodyObserver.observe(document.body, { childList: true, subtree: true })
    ensureMounted()
  }
  if (document.body === null) document.addEventListener('DOMContentLoaded', observe, { once: true })
  else observe()
  return stop
}

function stop(): void {
  booted = false
  bodyObserver?.disconnect()
  bodyObserver = null
  unmount()
  styleEl?.remove()
  styleEl = null
}

/**
 * Browser plugin entry. The loader calls it once per activation and disposes
 * the returned effect on reload/shutdown.
 * @param ctx - cordis context supplied by the client loader.
 */
export function apply(ctx: { effect?: (fn: () => () => void) => void } = {}): void {
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => start())
  } else {
    start()
  }
}
