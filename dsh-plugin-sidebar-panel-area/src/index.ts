/**
 * @local/dsh-plugin-sidebar-panel-area — node half.
 *
 * The feature lives entirely in the browser half (DOM-level sidebar layout).
 * This half only exists so the bundle can be mounted by the host roster and so
 * `dsh.client` publishes the browser bundle.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'sidebar-panel-area'

export function apply(ctx: Context) {
  ctx.logger?.info?.('sidebar-panel-area host half mounted (client-driven)')
}
