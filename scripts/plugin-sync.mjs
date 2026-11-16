#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, copyFileSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const schema = 'dsh-plugin-sync/v1';
const read = p => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
const validName = n => /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(n);
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)); };
const canonical = p => realpathSync.native(p);
function packageAt(p, name) {
  const full = canonical(p);
  if (read(join(full, 'package.json')).name !== name) throw Error('package identity mismatch: ' + name);
  return full;
}
function linkPath(profile, spec) { return resolve(profile, spec.slice(5)); }
function identity(p) {
  const hash=createHash('sha256'); let count=0;
  function walk(dir) {
    for(const name of readdirSync(dir).sort()) {
      if(['node_modules','.git','.ptc','.cache','coverage'].includes(name) || name.startsWith('.bak-')) continue;
      const file=join(dir,name), stat=lstatSync(file);
      if(stat.isSymbolicLink()) throw Error('nested symlink requires explicit source reconciliation');
      if(stat.isDirectory()) walk(file);
      else if(stat.isFile()) {
        if(++count>10000) throw Error('source tree too large to fingerprint');
        hash.update(relative(p,file).split(sep).join('/')).update('\0').update(String(stat.size)).update('\0').update(readFileSync(file));
      }
    }
  }
  walk(p); return hash.digest('hex');
}
export function exportManifest(profile, workspace) {
  const pkg = read(join(profile, 'package.json'));
  const root = canonical(workspace);
  const dependencies = {};
  for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
    if (!validName(name) || typeof spec !== 'string') throw Error('invalid dependency: ' + name);
    if (spec.startsWith('link:')) {
      const p = packageAt(linkPath(profile, spec), name);
      dependencies[name] = inside(root, p) ? { kind: 'workspace', path: relative(root, p).split(sep).join('/'), digest:identity(p) } : { kind: 'mapped', digest:identity(p) };
    } else dependencies[name] = { kind: 'registry', spec };
  }
  const bundles=pkg.dsh?.profile?.bundles || [];
  const hostBundles=bundles.filter(n=>!Object.hasOwn(dependencies,n));
  const result = { schema, dependencies, bundles, hostBundles };
  validate(result);
  return result;
}
function validate(m) {
  if (m?.schema !== schema || !m.dependencies || Array.isArray(m.dependencies) || !Array.isArray(m.bundles)) throw Error('invalid manifest');
  for (const [n, d] of Object.entries(m.dependencies)) {
    if (!validName(n) || !d || !['workspace','mapped','registry'].includes(d.kind)) throw Error('invalid package: ' + n);
    if (d.kind !== 'registry' && !/^[a-f0-9]{64}$/.test(d.digest || '')) throw Error('missing source digest: ' + n);
    if (d.kind === 'workspace' && (typeof d.path !== 'string' || !d.path || isAbsolute(d.path) || /^[A-Za-z]:/.test(d.path) || d.path.includes('\\') || d.path.split('/').includes('..'))) throw Error('unsafe workspace path: ' + n);
    if (d.kind === 'registry' && (typeof d.spec !== 'string' || !d.spec || /^(?:link:|file:|workspace:|\/|[A-Za-z]:)/.test(d.spec) || /https?:\/\/[^/]*@/.test(d.spec))) throw Error('non-portable spec: ' + n);
  }
  if (new Set(m.bundles).size !== m.bundles.length || m.bundles.some(n => !validName(n) || (!Object.hasOwn(m.dependencies,n) && !(m.hostBundles||[]).includes(n)))) throw Error('invalid bundle references');
}
export function makePlan(m, profile, workspace, mapping = {}) {
  validate(m);
  const pkg = read(join(profile, 'package.json'));
  const deps = pkg.dependencies || {};
  const localBundles = pkg.dsh?.profile?.bundles || [];
  const errors = [], packages = [];
  const root = canonical(workspace);
  for (const [name, source] of Object.entries(m.dependencies)) {
    let spec;
    try {
      if (source.kind === 'registry') {
        spec = source.spec;
        if (deps[name] && deps[name] !== spec) throw Error('version/source conflict: target=' + deps[name] + ', incoming=' + spec);
        if (!deps[name] && !/^[0-9]+[.][0-9]+[.][0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(spec)) throw Error('new registry dependency requires exact version');
      } else {
        let p;
        if (deps[name]?.startsWith('link:')) {
          // A pre-existing but broken identity never silently falls through to another source.
          p = packageAt(linkPath(profile, deps[name]), name);
        } else if (deps[name]) throw Error('target uses different source kind');
        else if (mapping.packages?.[name]) p = packageAt(resolve(mapping.packages[name]),name);
        else if (source.kind === 'workspace') {
          p = packageAt(resolve(root,source.path),name);
          if (!inside(root,p)) throw Error('workspace symlink escapes root');
        } else throw Error('receiver package mapping required');
        if(identity(p)!==source.digest) throw Error('same-name source/build digest differs; align Git revision first');
        const engines = read(join(p,'package.json')).engines?.dsh;
        if (engines && engines !== mapping.hostVersion) throw Error('engines.dsh needs explicit compatibility review: '+engines+' (automatic planner supports exact hostVersion only)');
        if (!existsSync(join(p,'lib','index.js')) && read(join(p,'package.json')).main?.startsWith('lib/')) throw Error('build output missing');
        spec = 'link:' + p.split(sep).join('/');
      }
      packages.push({ name, spec, digest:source.digest, bundled: m.bundles.includes(name), add: !deps[name] || (m.bundles.includes(name) && !localBundles.includes(name)) });
    } catch (e) { errors.push({name, reason:e.message}); }
  }
  const common = m.bundles.filter(n => localBundles.includes(n));
  const localCommon = localBundles.filter(n => common.includes(n));
  if (common.join('|') !== localCommon.join('|')) errors.push({name:'bundles',reason:'shared bundle order conflict; explicit reconciliation required'});
  for(const n of m.hostBundles||[]) if(!localBundles.includes(n)) errors.push({name:n,reason:'host-provided bundle missing on target; install matching DSH host first'});
  const additions = m.bundles.filter(n => !localBundles.includes(n));
  if (localBundles.includes('dsh-config-pack') && localBundles.at(-1)!=='dsh-config-pack') errors.push({name:'bundles',reason:'target patch layer is not last'});
  for (const p of packages) {
    if (p.add && !p.bundled) errors.push({name:p.name,reason:'dependency without bundle requires explicit installation'});
    if(p.add && !p.spec.startsWith('link:') && !/^[0-9]+[.][0-9]+[.][0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(p.spec)) errors.push({name:p.name,reason:'re-registration also requires an exact version; pin explicitly first'});
  }
  const bundles = [...localBundles.filter(n=>n!=='dsh-config-pack'),...additions.filter(n=>n!=='dsh-config-pack')];
  if (localBundles.includes('dsh-config-pack') || additions.includes('dsh-config-pack')) bundles.push('dsh-config-pack');
  return { schema:'dsh-plugin-sync-plan/v1', profile:resolve(profile), hostVersion:mapping.hostVersion || null, sourcePackageHash:createHash('sha256').update(readFileSync(join(profile,'package.json'))).digest('hex'), packages, bundles, retained:Object.keys(deps).filter(n=>!Object.hasOwn(m.dependencies,n)), errors, deletionPolicy:'retain-target-only' };
}
export function applyPlan(plan, profileName, dshHome, hostStopped, runner) {
  if (!hostStopped) throw Error('stop target host first; then explicitly pass --host-stopped');
  if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) throw Error('invalid profile name');
  if (canonical(plan.profile) !== canonical(join(dshHome,'profiles',profileName))) throw Error('profile path does not match DSH_HOME/profile name');
  if (plan.errors.length) throw Error('plan blocked: ' + JSON.stringify(plan.errors));
  if(createHash('sha256').update(readFileSync(join(plan.profile,'package.json'))).digest('hex')!==plan.sourcePackageHash) throw Error('profile changed since planning');
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const backup = join(dshHome,'backups','pre-plugin-sync-' + stamp);
  mkdirSync(backup,{recursive:true});
  for (const n of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.yml','cordis.patch.yml','compatibility.json']) if (existsSync(join(plan.profile,n))) copyFileSync(join(plan.profile,n),join(backup,n));
  const run = runner || (args => {
    const env = {...process.env,DSH_HOME:dshHome,DSH_PLUGIN_SYNC_ARGS:JSON.stringify(args)};
    const script = '$a = @($env:DSH_PLUGIN_SYNC_ARGS | ConvertFrom-Json); & dsh @a; exit $LASTEXITCODE';
    const stdio = args.includes('--dump-config') ? ['ignore','ignore','inherit'] : 'inherit';
    const r = process.platform === 'win32'
      ? spawnSync('pwsh',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{stdio,env,shell:false})
      : spawnSync('dsh',args,{stdio,env,shell:false});
    if (r.error || r.status !== 0) throw Error('dsh command failed; backup: '+backup+'; '+(r.error?.message || r.status));
  });
  const original=read(join(plan.profile,'package.json'));
  try {
  const patch=original.dependencies?.['dsh-config-pack'];
  const movePatch=patch && original.dsh?.profile?.bundles?.includes('dsh-config-pack') && plan.packages.some(p=>p.add && p.bundled && p.name!=='dsh-config-pack');
  if(movePatch) run(['plugin','--profile',profileName,'remove','dsh-config-pack']);
  // Registration delegates dependency installation to the supported plugin CLI.
  for (const n of plan.bundles) {
    const p = plan.packages.find(p=>p.name===n);
    if (p?.add) run(['plugin','--profile',profileName,'add',p.spec.startsWith('link:')?p.spec.slice(5):p.name+'@'+p.spec]);
  }
  if(movePatch) run(['plugin','--profile',profileName,'add',patch.startsWith('link:') ? linkPath(plan.profile,patch) : 'dsh-config-pack@'+patch]);
  const actual = read(join(plan.profile,'package.json'));
  for(const [name,spec] of Object.entries(original.dependencies||{})) if(!plan.packages.some(p=>p.name===name && p.add) && actual.dependencies?.[name]!==spec) throw Error('target dependency changed unexpectedly: '+name);
  for (const p of plan.packages) {
    const got = actual.dependencies?.[p.name];
    if (!got) throw Error('dependency missing after install: '+p.name);
    if (p.spec.startsWith('link:')) packageAt(linkPath(plan.profile,got),p.name);
    else if (got !== p.spec) throw Error('installed spec differs: '+p.name);
    const installed=packageAt(join(plan.profile,'node_modules',p.name),p.name);
    const installedEngine=read(join(installed,'package.json')).engines?.dsh;
    if(installedEngine && installedEngine!==plan.hostVersion) throw Error('installed engines.dsh requires explicit compatibility review: '+p.name+' '+installedEngine);
    if (p.spec.startsWith('link:') && identity(installed)!==p.digest) throw Error('installed source changed since planning: '+p.name);
    if (p.spec.startsWith('link:') && installed!==canonical(p.spec.slice(5))) throw Error('installed link points to different source: '+p.name);
    if (!p.spec.startsWith('link:') && /^[0-9]+[.][0-9]+[.][0-9]+$/.test(p.spec) && read(join(installed,'package.json')).version!==p.spec) throw Error('installed version differs: '+p.name);
  }
  if (JSON.stringify(actual.dsh?.profile?.bundles)!==JSON.stringify(plan.bundles)) throw Error('bundle order differs after registration; backup: '+backup);
  run(['--profile',profileName,'--dump-config']);
  return {backup,verified:true,requiresBrowserRefresh:true};
  } catch(error) {
    for(const n of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','cordis.yml','cordis.patch.yml','compatibility.json']) {
      const saved=join(backup,n), dest=join(plan.profile,n);
      if(existsSync(saved)) copyFileSync(saved,dest); else rmSync(dest,{force:true});
    }
    throw Error(error.message+'; configuration restored from '+backup+'; host must remain stopped: run pnpm install in '+plan.profile+' to reconcile node_modules before restarting');
  }
}
export function main(argv) {
  const command = argv.shift(), opts = {};
  while(argv.length) { const k=argv.shift(); if (!k.startsWith('--')) throw Error('invalid argument'); opts[k.slice(2)] = k==='--host-stopped'?true:argv.shift(); }
  const profile=opts.profile;
  if (!profile || !opts.workspace) throw Error('--profile <directory> and --workspace <clone> required');
  if(command==='export') { const m=exportManifest(profile,opts.workspace); if(!opts.out) throw Error('--out required'); writeFileSync(opts.out,JSON.stringify(m,null,2)+'\n'); return {written:opts.out}; }
  if(!['plan','apply'].includes(command)) throw Error('expected export, plan or apply');
  const plan=makePlan(read(opts.manifest),profile,opts.workspace,opts.map?read(opts.map):{});
  if(command==='plan') { console.log(JSON.stringify(plan,null,2)); if(plan.errors.length) process.exitCode=2; return; }
  return applyPlan(plan,opts['profile-name']||'web',resolve(opts['dsh-home']),opts['host-stopped']);
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) { try { const result=main(process.argv.slice(2)); if(result) console.log(JSON.stringify(result,null,2)); } catch(e) { console.error(e.message); process.exitCode=1; } }
