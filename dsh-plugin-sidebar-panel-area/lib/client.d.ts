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
/**
 * Browser plugin entry. The loader calls it once per activation and disposes
 * the returned effect on reload/shutdown.
 * @param ctx - cordis context supplied by the client loader.
 */
declare function apply(ctx?: {
  effect?: (fn: () => () => void) => void;
}): void;
export { apply };