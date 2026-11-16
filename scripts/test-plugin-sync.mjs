import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exportManifest, makePlan, applyPlan } from './plugin-sync.mjs';
const root=mkdtempSync(resolve('.ptc/plugin-sync-test-'));
function put(p,v){ mkdirSync(resolve(p,'..'),{recursive:true}); writeFileSync(p,JSON.stringify(v)); }
function pkg(p,name){ put(join(p,'package.json'),{name,version:'1.0.0'}); }
let passed=0;
function check(label,fn){fn();passed++;console.log('PASS '+label);}
try {
 const a=join(root,'A'), b=join(root,'B'), pa=join(a,'home/profiles/web'),pb=join(b,'home/profiles/web');
 pkg(join(a,'repo/widget'),'@local/widget');pkg(join(b,'repo/widget'),'@local/widget');
 put(join(pa,'package.json'),{dependencies:{'@local/widget':'link:'+join(a,'repo/widget')},dsh:{profile:{bundles:['@local/widget']}}});
 put(join(pb,'package.json'),{dependencies:{'target-only':'1.0.0'},dsh:{profile:{bundles:['target-only']}}});
 const m=exportManifest(pa,join(a,'repo'));
 check('export omits sender absolute path',()=>assert(!JSON.stringify(m).includes(a)));
 let p=makePlan(m,pb,join(b,'repo'));
 check('A to B resolves receiver workspace',()=>{assert.equal(p.errors.length,0);assert(p.packages[0].spec.includes('/B/'));assert.deepEqual(p.retained,['target-only']);});
 put(join(pb,'package.json'),{dependencies:{'@local/widget':'link:'+join(b,'repo/widget')},dsh:{profile:{bundles:['@local/widget']}}});
 check('B to A keeps A path',()=>{const back=makePlan(exportManifest(pb,join(b,'repo')),pa,join(a,'repo'));assert.equal(back.errors.length,0);assert(back.packages[0].spec.includes('/A/'));});
 check('relative target link retains receiver path',()=>{put(join(pb,'package.json'),{dependencies:{'@local/widget':'link:../../../repo/widget'},dsh:{profile:{bundles:['@local/widget']}}});assert.equal(makePlan(m,pb,join(b,'repo')).errors.length,0);});
 check('traversal rejected',()=>assert.throws(()=>makePlan({...m,dependencies:{'@local/widget':{...m.dependencies['@local/widget'],path:'../escape'}}},pb,join(b,'repo')),/unsafe/));
 check('absolute path rejected',()=>assert.throws(()=>makePlan({...m,dependencies:{'@local/widget':{...m.dependencies['@local/widget'],path:'C:/escape'}}},pb,join(b,'repo')),/unsafe/));
 check('wrong source rejected',()=>{pkg(join(b,'repo/widget'),'@local/wrong');assert(makePlan(m,pb,join(b,'repo')).errors.length);pkg(join(b,'repo/widget'),'@local/widget');});
 check('same-name different contents rejected',()=>{put(join(b,'repo/widget/package.json'),{name:'@local/widget',version:'2.0.0'});assert(makePlan(m,pb,join(b,'repo')).errors.length);pkg(join(b,'repo/widget'),'@local/widget');});
 check('source kind conflict rejected',()=>{put(join(pb,'package.json'),{dependencies:{'@local/widget':'1.0.0'}});assert(makePlan(m,pb,join(b,'repo')).errors.length);});
 check('symlink escape rejected',()=>{put(join(pb,'package.json'),{dependencies:{}});pkg(join(b,'outside'),'@local/widget');symlinkSync(join(b,'outside'),join(b,'repo/escape'),process.platform==='win32'?'junction':'dir');const evil={...m,dependencies:{'@local/widget':{...m.dependencies['@local/widget'],path:'escape'}}};assert(makePlan(evil,pb,join(b,'repo')).errors.length);});
 check('version conflict reported',()=>{put(join(pb,'package.json'),{dependencies:{widget:'2.0.0'}});assert(makePlan({schema:m.schema,dependencies:{widget:{kind:'registry',spec:'1.0.0'}},bundles:['widget']},pb,join(b,'repo')).errors[0].reason.includes('2.0.0'));});
 check('floating new registry version blocked',()=>{assert(makePlan({schema:m.schema,dependencies:{widget:{kind:'registry',spec:'latest'}},bundles:['widget']},pb,join(b,'repo')).errors.length);});
 put(join(pb,'package.json'),{dependencies:{},dsh:{profile:{bundles:[]}}});p=makePlan(m,pb,join(b,'repo'));
 check('host stop gate prevents any installer call',()=>assert.throws(()=>applyPlan(p,'web',join(b,'home'),false,()=>assert.fail()),/stop target/));
 check('failure restores original configuration',()=>{const before=readFileSync(join(pb,'package.json'),'utf8');assert.throws(()=>applyPlan(p,'web',join(b,'home'),true,()=>{put(join(pb,'package.json'),{broken:true});throw Error('injected installer failure');}),/configuration restored/);assert.equal(readFileSync(join(pb,'package.json'),'utf8'),before);});
 check('successful apply verifies registration and module',()=>{applyPlan(p,'web',join(b,'home'),true,args=>{if(args.includes('add')){put(join(pb,'package.json'),{dependencies:{'@local/widget':p.packages[0].spec},dsh:{profile:{bundles:['@local/widget']}}});mkdirSync(join(pb,'node_modules/@local'),{recursive:true});symlinkSync(join(b,'repo/widget'),join(pb,'node_modules/@local/widget'),process.platform==='win32'?'junction':'dir');}});});
 check('host provided bundles do not become invented dependencies',()=>{put(join(pb,'package.json'),{dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base']}}});const host=exportManifest(pb,join(b,'repo'));assert.deepEqual(host.hostBundles,['@deepseek-ai/dsh-base']);assert.equal(makePlan(host,pb,join(b,'repo')).errors.length,0);});
 check('patch layer stays last and CLI order is deterministic',()=>{
  const pack='dsh-config-pack';put(join(pb,'package.json'),{dependencies:{[pack]:'1.0.0'},dsh:{profile:{bundles:[pack]}}});
  const pp=makePlan(m,pb,join(b,'repo'));assert.equal(pp.errors.length,0);assert.deepEqual(pp.bundles,['@local/widget',pack]);
  const calls=[];
  applyPlan(pp,'web',join(b,'home'),true,args=>{calls.push(args);const cur=JSON.parse(readFileSync(join(pb,'package.json'),'utf8'));if(args.includes('remove')){delete cur.dependencies[pack];cur.dsh.profile.bundles=[];}if(args.includes('add')){const name=args.at(-1).startsWith('dsh-config-pack@')?pack:'@local/widget';cur.dependencies[name]=name===pack?'1.0.0':pp.packages[0].spec;cur.dsh.profile.bundles.push(name);}put(join(pb,'package.json'),cur);});
  assert(calls[0].includes('remove'));assert(calls[2].at(-1).startsWith('dsh-config-pack@')); });
 check('changed profile blocks stale plan before installation',()=>{const pp=makePlan(m,pb,join(b,'repo'));put(join(pb,'package.json'),{dependencies:{}});assert.throws(()=>applyPlan(pp,'web',join(b,'home'),true,()=>assert.fail()),/changed since/);});
 check('dist code differences fail fingerprint identity',()=>{
  const meta={name:'@local/widget',version:'1.0.0',main:'dist/index.js'};
  put(join(a,'repo/widget/package.json'),meta);put(join(b,'repo/widget/package.json'),meta);
  mkdirSync(join(a,'repo/widget/dist'),{recursive:true});mkdirSync(join(b,'repo/widget/dist'),{recursive:true});
  writeFileSync(join(a,'repo/widget/dist/index.js'),'export default 1');writeFileSync(join(b,'repo/widget/dist/index.js'),'export default 2');
  const dm=exportManifest(pa,join(a,'repo'));
  put(join(pb,'package.json'),{dependencies:{}});assert(makePlan(dm,pb,join(b,'repo')).errors.length);
 });
 check('range re-registration is blocked before installation',()=>{
  put(join(pb,'package.json'),{dependencies:{widget:'^1.0.0'},dsh:{profile:{bundles:[]}}});
  const rm={schema:m.schema,dependencies:{widget:{kind:'registry',spec:'^1.0.0'}},bundles:['widget']};
  assert(makePlan(rm,pb,join(b,'repo')).errors.some(e=>e.reason.includes('exact version')));
 });
 check('incompatible installed registry engines triggers configuration rollback',()=>{
  put(join(pb,'package.json'),{dependencies:{},dsh:{profile:{bundles:[]}}});
  const rp=makePlan({schema:m.schema,dependencies:{widget:{kind:'registry',spec:'1.0.0'}},bundles:['widget']},pb,join(b,'repo'),{hostVersion:'0.2.1-rc.5'});
  const before=readFileSync(join(pb,'package.json'),'utf8');
  assert.throws(()=>applyPlan(rp,'web',join(b,'home'),true,args=>{if(args.includes('add')){put(join(pb,'package.json'),{dependencies:{widget:'1.0.0'},dsh:{profile:{bundles:['widget']}}});put(join(pb,'node_modules/widget/package.json'),{name:'widget',version:'1.0.0',engines:{dsh:'0.2.0-rc.2'}});}}),/engines.dsh/);
  assert.equal(readFileSync(join(pb,'package.json'),'utf8'),before);
 });
 console.log('RESULT '+passed+' passed');
} finally { rmSync(root,{recursive:true,force:true}); }
