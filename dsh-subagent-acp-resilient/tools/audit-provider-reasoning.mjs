#!/usr/bin/env node
/**
 * Audit every configured `llm-pi-ai` provider route for reasoning-effort capability.
 *
 * Why this exists: a hand-declared route (a gateway pi-ai ships no catalog for)
 * reports `reasoning: false` unless its model entries declare `reasoningEfforts`
 * — the catalog fallback is keyed by PROVIDER ROUTE, never by model id across
 * routes. A binding that asks such a route for an effort therefore fails before
 * any network I/O with `UNSUPPORTED_REASONING_EFFORT`. This tool mirrors
 * `resolveModelReasoning` (dsh-llm-pi-ai) plus pi-ai's `getSupportedThinkingLevels`
 * and reports, per route and model, where the capability comes from and whether
 * every "demands an effort" binding can actually be satisfied.
 *
 * Usage:
 *   node tools/audit-provider-reasoning.mjs [cordis.patch.yml ...]
 *
 * Environment (no machine-specific path is baked into this file):
 *   DSH_HOME / DSH_PROFILE   default `~/.dsh` and `web`
 *   DSH_PI_AI_DIR            override the discovered `@earendil-works/pi-ai` root
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/* js-yaml 5 is ESM-only named exports while 4 exposes a default; accept both. */
import * as yamlNamespace from 'js-yaml';

const yaml = yamlNamespace.default ?? yamlNamespace;

/** Mirror the loader's `!!js` scalar semantics: keep the expression as text. */
const jsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (data) => String(data),
});
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([jsType]);

function defaultProfilePatch() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const profile = process.env.DSH_PROFILE ?? 'web';
  return join(home, 'profiles', profile, 'cordis.patch.yml');
}

/** Locate the pi-ai provider-data directory without a hard-coded install path. */
function piAiDataDir() {
  const explicit = process.env.DSH_PI_AI_DIR;
  const globalRoot = join(dirname(process.execPath), 'node_modules');
  const candidates = [
    explicit,
    explicit && join(explicit, 'dist', 'providers', 'data'),
    join(globalRoot, '@earendil-works', 'pi-ai', 'dist', 'providers', 'data'),
    join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data'),
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE ?? 'web', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate) && readdirSync(candidate).some((f) => f.endsWith('.json'))) return candidate;
  }
  throw new Error('cannot locate the pi-ai provider data; set DSH_PI_AI_DIR to the @earendil-works/pi-ai package root');
}

const DATA = piAiDataDir();
const EXT = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Mirror pi-ai `getSupportedThinkingLevels` for a catalog model. */
const catalogLevels = (m) => {
  if (!m?.reasoning) return [];
  return EXT.filter((l) => {
    const mapped = m.thinkingLevelMap?.[l];
    if (mapped === null) return false;
    if (l === 'xhigh' || l === 'max') return mapped !== undefined;
    return true;
  });
};

/** Mirror `resolveModelReasoning`: undefined = fall through to the catalog. */
const declaredLevels = (e) => {
  const efforts = e.reasoningEfforts;
  if (efforts === false || efforts === undefined) return undefined;
  const out = [];
  for (const l of EXT) {
    const wire = efforts[l];
    if (wire === undefined) continue; // undeclared => pinned to null => unsupported
    if (wire === null) { if (l === 'off') out.push(l); continue; }
    out.push(l);
  }
  return out;
};

const catalogProviders = new Set(readdirSync(DATA).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')));
const catalogModels = (route) => {
  const path = join(DATA, route + '.json');
  if (!existsSync(path)) return undefined;
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const byId = new Map();
  for (const api of Object.keys(doc)) for (const [id, m] of Object.entries(doc[api])) if (!byId.has(id)) byId.set(id, m);
  return byId;
};

const files = process.argv.slice(2);
const targets = files.length > 0 ? files : [defaultProfilePatch()];
let failures = 0;

for (const file of targets) {
  if (!existsSync(file)) { console.log('missing patch: ' + file); failures++; continue; }
  const tree = yaml.load(readFileSync(file, 'utf8'), { schema: SCHEMA });
  const entries = Array.isArray(tree) ? tree : [];
  const providers = entries.find((e) => e?.id === 'llm-pi-ai')?.config?.providers ?? {};
  const status = new Map();

  console.log('\n===== ' + file + ' =====');
  for (const [route, cfg] of Object.entries(providers)) {
    const shipped = catalogProviders.has(route);
    const cat = catalogModels(route);
    const configured = cfg.models ?? [];
    const list = configured.length > 0 ? configured : [...(cat ?? new Map()).values()].map((m) => ({ id: m.id }));
    const source = configured.length > 0 ? 'profile' : 'installed catalog (whole)';
    const empties = [];
    console.log('\n[' + route + '] ' + (shipped ? 'catalog route' : 'CUSTOM route (pi-ai ships none)')
      + '  api=' + (cfg.api ?? '(catalog)') + '  models=' + list.length + ' from ' + source);
    for (const e of list) {
      const base = cat?.get(e.id);
      const dec = declaredLevels(e);
      let levels;
      let src;
      if (dec !== undefined) { levels = dec; src = 'profile'; }
      else if (base) { levels = catalogLevels(base); src = 'catalog'; }
      else { levels = []; src = 'none'; }
      status.set(route + '/' + e.id, { levels });
      if (levels.length === 0) empties.push(e.id);
      console.log('   - ' + (e.id + ' '.repeat(30)).slice(0, 30) + ' ' + (src + ' '.repeat(8)).slice(0, 8)
        + ' => ' + (levels.length === 0 ? 'EMPTY (off only)' : levels.join(',')));
    }
    if (empties.length > 0) { console.log('   >>> EMPTY (' + empties.length + '): ' + empties.join(', ')); failures++; }
  }

  const bindings = [];
  const roles = entries.find((e) => e?.id === 'subagent-director')?.config?.roles ?? {};
  for (const [id, r] of Object.entries(roles)) bindings.push({ where: 'director role ' + id, provider: r.provider, model: r.model, effort: r.reasoningEffort });
  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, path + '[' + i + ']')); return; }
    if (node && typeof node === 'object') {
      const ao = node.agentOptions;
      if (ao && typeof ao === 'object' && (ao.provider || ao.model)) bindings.push({ where: 'tool ' + path, provider: ao.provider, model: ao.model, effort: ao.reasoningEffort });
      for (const [k, v] of Object.entries(node)) walk(v, path + '.' + k);
    }
  };
  walk(entries, 'patch');

  console.log('\n-- bindings that demand an effort --');
  for (const b of bindings) {
    const st = status.get(b.provider + '/' + b.model);
    let verdict;
    if (!b.effort) verdict = 'no effort required';
    else if (!st) verdict = 'FAIL: model not configured on that route';
    else if (st.levels.length === 0) verdict = 'FAIL: EMPTY capability (UNSUPPORTED_REASONING_EFFORT)';
    else if (!st.levels.includes(b.effort)) verdict = 'FAIL: level "' + b.effort + '" not offered (' + st.levels.join(',') + ')';
    else verdict = 'OK';
    if (verdict.startsWith('FAIL')) failures++;
    console.log('   ' + (b.where + ' '.repeat(44)).slice(0, 44) + ' ' + (b.provider + '/' + b.model + ' '.repeat(38)).slice(0, 38)
      + ' effort=' + String(b.effort) + ' -> ' + verdict);
  }

  const allowed = entries.find((e) => e?.id === 'subagent-model-selection-settings')?.config?.allowedModels ?? [];
  console.log('\n-- allowlist vs configured --');
  for (const a of allowed) {
    const st = status.get(a.provider + '/' + a.model);
    /* A provider absent from llm-pi-ai is not an LLM route at all (an ACP provider,
     * for example) — informational, not a defect. */
    const isLlmRoute = Object.prototype.hasOwnProperty.call(providers, a.provider);
    let line;
    if (st) line = 'configured, efforts=' + (st.levels.length ? st.levels.join(',') : 'EMPTY');
    else if (!isLlmRoute) line = 'not an llm-pi-ai route (ACP/other provider) - N/A';
    else { line = 'DANGLING: not configured on that route'; failures++; }
    console.log('   ' + (a.provider + '/' + a.model + ' '.repeat(44)).slice(0, 44) + ' ' + line);
  }
}

console.log('\n===== summary: ' + (failures === 0 ? 'OK (no empties, no dangling, all bindings satisfiable)' : failures + ' finding(s) above') + ' =====');
process.exit(failures === 0 ? 0 : 1);
