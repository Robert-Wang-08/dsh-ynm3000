/**
 * dsh-plugin-superagent-appearance — 浅色护眼绿外观层。
 *
 * 只在浅色主题生效：宿主通过 webserver/index-inject 把样式塞进页面 head，
 * 由 body:not([data-ds-dark-theme]) 限定作用域，深色主题完全不受影响。
 * 不改任何官方包，纯 profile 层覆盖；删掉挂载行即恢复默认。
 *
 * 预设（profile patch 的 config.preset 选择，默认 soft）：
 *   soft    浅薄荷绿，最淡，长时间阅读首选（#EAF6EA 画布）
 *   classic 经典豆沙绿 #C7EDCC（RGB 199/237/204，民间最流行的护眼色，偏深）
 *   paper   青草绿 #E3EDCD（常见护眼配色清单里的浅绿变体，偏黄绿）
 */
const PRESETS = {
  soft: { base: '#eaf6ea', l1: '#eff9ef', l2: '#f3fbf3', l3: '#f7fdf7', code: '#dff0db', banner: '#f0faf0', doc: '#f3fbf3', fill: '#f0faf0', hover: '#f5fcf5' },
  classic: { base: '#c7edcc', l1: '#ceeed2', l2: '#d5f0d9', l3: '#ddf2e0', code: '#d2efd6', banner: '#ddf2e0', doc: '#e2f4e5', fill: '#d5f0d9', hover: '#ddf2e0' },
  paper: { base: '#e3edcd', l1: '#e8f0d6', l2: '#edf3de', l3: '#f1f6e6', code: '#dde8c8', banner: '#edf3de', doc: '#f1f6e6', fill: '#edf3de', hover: '#f1f6e6' },
};
const DEFAULT_PRESET = 'soft';

/** Builds one scoped CSS block for a preset name; unknown names fall back to `soft`. */
function cssFor(name) {
  const preset = Object.prototype.hasOwnProperty.call(PRESETS, name) ? name : DEFAULT_PRESET;
  const p = PRESETS[preset];
  return [
    '/* dsh-plugin-superagent-appearance — light eye-care green: ' + preset + ' */',
    'body:not([data-ds-dark-theme]) {',
    '  background-color: ' + p.base + ';',
    '  --dsh-boot-bg: ' + p.base + ';',
    '  --dsw-alias-bg-base: ' + p.base + ';',
    '  --dsw-alias-bg-layer-1: ' + p.l1 + ';',
    '  --dsw-alias-bg-layer-2: ' + p.l2 + ';',
    '  --dsw-alias-bg-layer-3: ' + p.l3 + ';',
    '  --dsw-alias-bg-module-platform: ' + p.base + ';',
    '  --dsw-alias-bg-multi-select: ' + p.l3 + ';',
    '  --dsw-alias-bg-overlay: ' + p.l1 + ';',
    '  --dsw-alias-bg-document-preview: ' + p.doc + ';',
    '  --dsw-alias-markdown-code-block: ' + p.code + ';',
    '  --dsw-alias-markdown-code-block-banner: ' + p.banner + ';',
    '  --dsw-alias-markdown-inline-code: ' + p.code + ';',
    '  --dsw-alias-button-elevated-fill: ' + p.fill + ';',
    '  --dsw-alias-button-floating-fill: ' + p.fill + ';',
    '  --dsw-alias-button-floating-hover: ' + p.hover + ';',
    '  --dsw-alias-settings-card-fill: ' + p.l2 + ';',
    '  --dsw-alias-turn-trigger-bg: ' + p.fill + ';',
    '  --dsw-alias-turn-trigger-bg-hover: ' + p.hover + ';',
    '}',
  ].join('\n');
}

/** Host plugin body: append one style row built from this entry's `preset` config. */
export function apply(ctx, config) {
  const preset = config && typeof config.preset === 'string' ? config.preset : DEFAULT_PRESET;
  const css = cssFor(preset);
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'style', text: css });
  });
}
