/**
 * Prove that the ACP rows in the REAL config files are effective, not inert.
 *
 * The loader's schema forwards unknown keys, so a misspelled or unsupported
 * timeout key parses fine and does nothing. This tool parses the real patch
 * files with the same `!!js` semantics the loader uses, pushes every
 * `@local/dsh-subagent-acp-resilient` row through the plugin's own schema and
 * `apply()` validation, and prints the ladder that will actually be enforced.
 *
 * Usage:
 *   node tools/verify-config.mjs            # default: this profile + the PTC bundle
 *   node tools/verify-config.mjs <file.yml> ...
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
/* js-yaml 5 is ESM-only named exports while 4 exposes a default; accept both. */
import * as yamlNamespace from 'js-yaml';
import { Config, DECLARED_CONFIG_KEYS, apply } from '../lib/index.js';

const yaml = yamlNamespace.default ?? yamlNamespace;

/* Mirror the loader's `!!js` scalar evaluation. */
const jsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => data !== null,
  construct: (data) => {
    try {
      return Function('process', `"use strict";return (${data});`)(process);
    } catch (error) {
      return `<<unresolvable !!js: ${String(error?.message ?? error)}>>`;
    }
  }
});
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([jsType]);

const PLUGIN = '@local/dsh-subagent-acp-resilient';

/**
 * Default target: the active profile's patch, derived from the environment so no
 * machine-specific path is baked into this file. Additional patch files (a
 * bundle, a generated companion) are passed as arguments.
 */
function defaultProfilePatch() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const profile = process.env.DSH_PROFILE ?? 'web';
  return join(home, 'profiles', profile, 'cordis.patch.yml');
}

const passed = process.argv.slice(2);
const files = passed.length > 0 ? passed : [defaultProfilePatch()];
const results = [];

/** Depth-first walk over every node of the parsed patch document. */
function* walk(node, path = '$') {
  if (Array.isArray(node)) {
    for (const [index, entry] of node.entries()) yield* walk(entry, `${path}[${index}]`);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  yield { node, path };
  for (const [key, value] of Object.entries(node)) yield* walk(value, `${path}.${key}`);
}

for (const file of files) {
  const entry = { file, exists: existsSync(file), rows: [], parseError: undefined };
  results.push(entry);
  if (!entry.exists) continue;
  let document;
  try {
    document = yaml.load(readFileSync(file, 'utf8'), { schema: SCHEMA });
  } catch (error) {
    entry.parseError = String(error?.message ?? error);
    continue;
  }
  for (const { node, path } of walk(document)) {
    if (node.name !== PLUGIN || node.config === undefined) continue;
    const row = { id: node.id, path, providerName: node.config.providerName, ok: false };
    entry.rows.push(row);
    try {
      /* 1. the schema the loader applies, with defaults resolved. */
      const parsed = Config(node.config);
      /* 2. the plugin's own coherence checks, through the real apply(). */
      const registered = [];
      const warnings = [];
      apply({
        logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
        subagents: { registerProvider: (provider) => registered.push(provider) },
        subprocess: { spawn: () => ({}) }
      }, parsed);
      if (registered.length !== 1) throw new Error('apply did not register a provider');
      row.ok = true;
      row.warnings = warnings;
      row.registeredName = registered[0].name;
      /* 3. the ladder that will actually be enforced. */
      row.effective = Object.fromEntries(
        DECLARED_CONFIG_KEYS
          .filter((key) => typeof parsed[key] === 'number')
          .map((key) => [key, parsed[key]])
      );
      row.effectiveMs = Object.fromEntries(
        Object.entries(row.effective).map(([key, value]) => [
          key,
          key.endsWith('Ms') ? `${value} (${Math.round(value / 1000)}s)` : String(value)
        ])
      );
      row.command = parsed.command;
      row.args = parsed.args;
      row.env = parsed.env;
    } catch (error) {
      row.error = String(error?.message ?? error);
    }
  }
}

/* An unresolved `!!js` value means the row cannot work at all. */
const unresolved = [];
for (const entry of results) {
  for (const row of entry.rows) {
    for (const value of [row.command, ...(row.args ?? [])]) {
      if (typeof value === 'string' && value.startsWith('<<unresolvable')) unresolved.push({ file: entry.file, id: row.id, value });
    }
  }
}

const summary = {
  files: results.map((entry) => ({
    file: entry.file,
    exists: entry.exists,
    parseError: entry.parseError,
    acpRows: entry.rows.length,
    allValid: entry.rows.length > 0 && entry.rows.every((row) => row.ok)
  })),
  unresolvedJs: unresolved,
  rows: results.flatMap((entry) => entry.rows.map((row) => ({ file: entry.file, ...row })))
};
console.log(JSON.stringify(summary, null, 2));

const bad = summary.files.some((file) => !file.exists || file.parseError !== undefined || !file.allValid) || unresolved.length > 0;
process.exit(bad ? 1 : 0);
