/**
 * E2E smoke for @local/dsh-plugin-sidebar-panel-area.
 *
 * Usage:
 *   $env:DSH_TEST_URL = 'http://127.0.0.1:3081/?token=...'
 *   node scripts/e2e.mjs
 *
 * Requires the DSH source checkout's Playwright install and Microsoft Edge.
 * Writes screenshots under DSH_PANEL_AREA_SHOTS (default .ptc/panel-area-shots).
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire('D:/src/deepseek-harness/package.json')
const { chromium } = require('D:/src/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright')

const url = process.env.DSH_TEST_URL
if (!url) {
  console.error('DSH_TEST_URL is required')
  process.exit(2)
}
const shots = process.env.DSH_PANEL_AREA_SHOTS ?? 'D:/src/dsh/.ptc/panel-area-shots'
mkdirSync(shots, { recursive: true })

const failures = []
const consoleErrors = []
function check(name, condition, detail) {
  const ok = Boolean(condition)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
  if (!ok) failures.push(`${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
}

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
const page = await context.newPage()
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', error => { consoleErrors.push(`pageerror: ${error.message}`) })

const read = () => page.evaluate(() => {
  const nav = document.querySelector('nav[class*="_panelList"]')
  const bar = document.querySelector('.dsh-pa-bar')
  const region = document.querySelector('[class*="_regionArea"]')
  const root = nav?.parentElement ?? null
  const rect = el => (el === null ? null : el.getBoundingClientRect())
  const children = nav === null ? [] : Array.from(nav.children)
  const first = children[0] ?? null
  const last = children[children.length - 1] ?? null
  return {
    navHeight: rect(nav)?.height ?? null,
    navDisplay: nav === null ? null : getComputedStyle(nav).display,
    navOverflowY: nav === null ? null : getComputedStyle(nav).overflowY,
    navRows: nav === null ? 0 : nav.querySelectorAll('button').length,
    navScrollTop: nav?.scrollTop ?? null,
    navScrollHeight: nav?.scrollHeight ?? null,
    navClientHeight: nav?.clientHeight ?? null,
    navTop: rect(nav)?.top ?? null,
    navBottom: rect(nav)?.bottom ?? null,
    firstRowBottom: rect(first)?.bottom ?? null,
    lastRowBottom: rect(last)?.bottom ?? null,
    navLabels: children.map(child => child.getAttribute('aria-label') ?? child.textContent?.trim() ?? ''),
    barHeight: rect(bar)?.height ?? null,
    barDisplay: bar === null ? null : getComputedStyle(bar).display,
    regionHeight: rect(region)?.height ?? null,
    rootWidth: root?.clientWidth ?? null,
    stored: localStorage.getItem('dsh.sidebar-panel-area.v1'),
    handle: document.querySelector('.dsh-pa-handle') !== null,
    toggle: document.querySelector('.dsh-pa-toggle') !== null,
  }
})

const shot = async name => {
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false })
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('nav[class*="_panelList"]', { state: 'attached', timeout: 30000 })
  await page.waitForSelector('.dsh-pa-bar', { timeout: 15000 })
  await page.waitForTimeout(400)

  const before = await read()
  console.log('BEFORE', JSON.stringify(before))
  check('bar mounted', before.handle && before.toggle)
  check('bar visible in wide mode', before.barDisplay !== 'none')
  check('nav has content', (before.navRows ?? 0) >= 3 && (before.navHeight ?? 0) > 100)
  await shot('01-before')

  // Drag the divider down.
  const handle = page.locator('.dsh-pa-handle')
  const box = await handle.boundingBox()
  if (box === null) throw new Error('handle has no box')
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  for (let i = 1; i <= 10; i += 1) await page.mouse.move(startX, startY + i * 8)
  await page.mouse.up()
  await page.waitForTimeout(200)
  const dragged = await read()
  console.log('DRAGGED', JSON.stringify(dragged))
  check('drag grew the panel list', (dragged.navHeight ?? 0) > (before.navHeight ?? 0) + 40, {
    before: before.navHeight, after: dragged.navHeight,
  })
  check('drag shrank the session region', (dragged.regionHeight ?? 0) < (before.regionHeight ?? 0) - 20)
  check('drag persisted a height', dragged.stored !== null && JSON.parse(dragged.stored).height !== null)
  await shot('02-dragged')

  // Reload: the height must come back.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('nav[class*="_panelList"]', { state: 'attached', timeout: 30000 })
  await page.waitForSelector('.dsh-pa-bar', { timeout: 15000 })
  await page.waitForTimeout(400)
  const reloaded = await read()
  console.log('RELOADED', JSON.stringify(reloaded))
  check('height survives reload', Math.abs((reloaded.navHeight ?? 0) - (dragged.navHeight ?? 0)) <= 2, {
    dragged: dragged.navHeight, reloaded: reloaded.navHeight,
  })
  await shot('03-reloaded')

  // Double-click collapses: the head is clipped, the tail stays visible, order
  // unchanged; reload keeps it collapsed.
  await page.locator('.dsh-pa-handle').dblclick()
  await page.waitForTimeout(250)
  const collapsed = await read()
  console.log('COLLAPSED', JSON.stringify(collapsed))
  check('collapsed list stays visible', collapsed.navDisplay !== 'none', { display: collapsed.navDisplay })
  check('collapse shrinks the list', (collapsed.navHeight ?? 0) < (reloaded.navHeight ?? 0) - 80, {
    reloaded: reloaded.navHeight, collapsed: collapsed.navHeight,
  })
  check('collapsed list is anchored to the bottom', (collapsed.navScrollTop ?? 0) > 0
    && Math.abs(((collapsed.navScrollTop ?? 0) + (collapsed.navClientHeight ?? 0)) - (collapsed.navScrollHeight ?? 0)) <= 2, {
    scrollTop: collapsed.navScrollTop, client: collapsed.navClientHeight, scrollHeight: collapsed.navScrollHeight,
  })
  check('last row is visible', (collapsed.lastRowBottom ?? 0) <= (collapsed.navBottom ?? 0) + 1)
  check('first row is hidden above', (collapsed.firstRowBottom ?? 0) <= (collapsed.navTop ?? 0) + 1)
  check('registration order unchanged', JSON.stringify(collapsed.navLabels) === JSON.stringify(before.navLabels), {
    before: before.navLabels, collapsed: collapsed.navLabels,
  })
  check('collapse persisted', collapsed.stored !== null && JSON.parse(collapsed.stored).collapsed === true)
  check('collapsed region grows', (collapsed.regionHeight ?? 0) > (reloaded.regionHeight ?? 0) + 40)
  await shot('04-collapsed')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('nav[class*="_panelList"]', { state: 'attached', timeout: 30000 })
  await page.waitForSelector('.dsh-pa-bar', { timeout: 15000 })
  await page.waitForTimeout(400)
  const collapsedReload = await read()
  console.log('COLLAPSED_RELOAD', JSON.stringify(collapsedReload))
  check('collapse survives reload', collapsedReload.navDisplay !== 'none'
    && Math.abs((collapsedReload.navHeight ?? 0) - (collapsed.navHeight ?? 0)) <= 2, {
    collapsed: collapsed.navHeight, reloaded: collapsedReload.navHeight,
  })
  check('collapsed reload stays bottom-anchored', (collapsedReload.navScrollTop ?? 0) > 0)

  // The expanded toggle restores the remembered height.
  await page.locator('.dsh-pa-toggle').click()
  await page.waitForTimeout(250)
  const expanded = await read()
  console.log('EXPANDED', JSON.stringify(expanded))
  check('toggle expands the panel list', expanded.navDisplay !== 'none')
  check('expand restores the height', Math.abs((expanded.navHeight ?? 0) - (dragged.navHeight ?? 0)) <= 2, {
    dragged: dragged.navHeight, expanded: expanded.navHeight,
  })
  await shot('05-expanded')

  // Keyboard resize.
  await page.locator('.dsh-pa-handle').focus()
  const beforeKey = await read()
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(200)
  const keyed = await read()
  console.log('KEYED', JSON.stringify(keyed))
  check('ArrowUp shrinks by 16px', Math.abs((beforeKey.navHeight ?? 0) - (keyed.navHeight ?? 0) - 16) <= 2, {
    before: beforeKey.navHeight, after: keyed.navHeight,
  })

  // Rail mode: the bar hides; expanding the sidebar restores it.
  const collapseButton = page.locator('button[aria-label="收起侧边栏"], button[aria-label="Collapse sidebar"]').first()
  if (await collapseButton.count() === 0) {
    check('sidebar collapse button found', false)
  } else {
    await collapseButton.click()
    await page.waitForTimeout(500)
    const rail = await read()
    console.log('RAIL', JSON.stringify(rail))
    check('bar hides in rail mode', rail.barDisplay === 'none' || rail.rootWidth === null, { bar: rail.barDisplay, root: rail.rootWidth })
    await shot('06-rail')

    const expandButton = page.locator('button[aria-label="打开侧边栏"], button[aria-label="Open sidebar"]').first()
    if (await expandButton.count() === 0) {
      check('sidebar expand button found', false)
    } else {
      await expandButton.click()
      await page.waitForTimeout(600)
      const wide = await read()
      console.log('WIDE_AGAIN', JSON.stringify(wide))
      check('bar returns after expand', wide.barDisplay !== 'none')
      check('nav height returns after expand', Math.abs((wide.navHeight ?? 0) - (keyed.navHeight ?? 0)) <= 2, {
        keyed: keyed.navHeight, wide: wide.navHeight,
      })
      await shot('07-wide-again')
    }
  }

  if (consoleErrors.length > 0) {
    console.log('CONSOLE_ERRORS', JSON.stringify(consoleErrors.slice(0, 10)))
  }
} catch (error) {
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
  try {
    await page.screenshot({ path: join(shots, '99-failure.png') })
  } catch { /* ignore */ }
} finally {
  await browser.close()
}

console.log('')
console.log(failures.length === 0 ? 'RESULT: OK' : `RESULT: FAIL (${failures.length})`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
