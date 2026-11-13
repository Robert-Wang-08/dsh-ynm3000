// Design integration only. Inlined by build-integrated.py inside the reference IIFE.
const viewKeys=['metro','journey','dag','board'];
const contextCache=new Map(),returnTrail=[];
let notice='',pendingScroll=null;
// A task keeps its sibling-assigned track color when filters hide other tasks.
color=function(i){const id=visible()[i]?.id;return palette[Math.max(0,nodes().findIndex(n=>n.id===id))%palette.length];};
const copy=x=>JSON.parse(JSON.stringify(x));
function validateDataset(d){
 if(!d||!Array.isArray(d.projects)||!d.projects.length||d.projects.length>30)throw Error('projects须为1–30个目标');
 const map=new Map();
 function walk(n,parent,lvl){
  if(!n||typeof n!=='object'||typeof n.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(n.id))throw Error('任务ID须为安全短标识');
  if(map.has(n.id))throw Error('重复ID：'+n.id);
  if(lvl>3||map.size>=300)throw Error('最多三级、300个canonical任务');
  if(typeof n.title!=='string'||!n.title.trim()||n.title.length>180)throw Error('任务标题无效');
  if(!Object.hasOwn(stat,n.status)||!Number.isInteger(n.stage)||n.stage<0||n.stage>4)throw Error('status或stage无效：'+n.id);
  if(!Array.isArray(n.children))throw Error('children必须为数组：'+n.id);
  for(const key of ['next','summary','decision','evidence','updated','owner','role','attention'])if(n[key]!==undefined&&(typeof n[key]!=='string'||n[key].length>4000))throw Error('文本字段无效：'+key);
  for(const key of ['dependsOn','references'])if(n[key]!==undefined&&(!Array.isArray(n[key])||n[key].some(id=>typeof id!=='string')||new Set(n[key]).size!==n[key].length))throw Error(key+'必须为去重ID数组');
  map.set(n.id,{node:n,parent,level:lvl});n.children.forEach(c=>walk(c,n.id,lvl+1));
 }
 d.projects.forEach(n=>walk(n,null,1));
 for(const {node:n} of map.values()){
  for(const id of [...(n.dependsOn||[]),...(n.references||[])])if(!map.has(id)||id===n.id)throw Error('缺失或自引用：'+n.id+' → '+id);
  const a=n.acceptance;if(a){
   if(typeof a!=='object'||!Array.isArray(a.requires)||a.requires.some(id=>!n.children.some(child=>child.id===id))||new Set(a.requires).size!==a.requires.length||a.requires.includes(n.id))throw Error('验收requires无效：'+n.id);
   if(typeof a.accepted!=='boolean')throw Error('验收accepted须为boolean');
  }
 }
 const visiting=new Set(),done=new Set();
 function visit(id){if(visiting.has(id))throw Error('真实硬依赖成环：'+id);if(done.has(id))return;visiting.add(id);(map.get(id).node.dependsOn||[]).forEach(visit);visiting.delete(id);done.add(id);}
 map.forEach((_,id)=>visit(id));return map;
}
buildRegistry=function(){registry=validateDataset(data);};
function isAccepted(n){const a=n.acceptance;return !!(a&&a.accepted===true&&['human','tool'].includes(a.origin)&&a.revision&&a.revision===a.targetRevision&&typeof a.evidence==='string'&&a.evidence.trim());}
function descendants(n){return n.children.flatMap(c=>[c,...descendants(c)]);}
function nodeStats(n){const direct=n.children,all=descendants(n);return {direct:direct.length,accepted:direct.filter(isAccepted).length,blocked:all.filter(c=>c.status==='blocked').length};}
function capture(){return {path:[...state.path],selected:state.selected,view:state.view,focus:state.focus,query:state.query,collapsed:[...state.collapsed],scrollY:window.scrollY,treeY:el('tree').parentElement.scrollTop,vizX:el('visualization').querySelector('.viz-scroll,.svg-canvas')?.scrollLeft||0};}
function scopeKey(path=state.path){return path.join('/')||'root';}
function remember(){contextCache.set(scopeKey(),capture());}
function applyContext(c){state.path=[...c.path];state.selected=c.selected;state.view=c.view;state.focus=c.focus;state.query=c.query;state.collapsed=new Set(c.collapsed);pendingScroll=c;}
function pathFor(id){const out=[];let p=ref(id)?.parent;while(p){out.unshift(p);p=ref(p)?.parent;}return out;}
ensureSelected=function(){const arr=visible();if(!arr.some(n=>n.id===state.selected))state.selected=arr[0]?.id||null;};
drill=function(id){const n=ref(id)?.node;if(!canDrill(n))return;remember();const view=state.view;state.path.push(id);const cached=contextCache.get(scopeKey());if(cached){applyContext(cached);state.view=view;}else{state.selected=n.children[0]?.id||null;state.query='';state.focus=false;state.collapsed.delete(id);pendingScroll={scrollY:0,treeY:0,vizX:0};}render();};
up=function(){if(!state.path.length)return;remember();const view=state.view,last=state.path.pop(),cached=contextCache.get(scopeKey());if(cached){applyContext(cached);state.view=view;}else{state.selected=last;state.query='';state.focus=false;}render();};
toLevel=function(target){if(!Number.isInteger(target)||target<1||target>level())return;while(level()>target)up();};
gotoNode=function(id){if(!ref(id))return;remember();returnTrail.push(capture());state.path=pathFor(id);state.selected=id;state.query='';state.focus=false;state.path.forEach(p=>state.collapsed.delete(p));pendingScroll={scrollY:0,treeY:0,vizX:0};render();};
function returnToOrigin(){const c=returnTrail.pop();if(!c)return;remember();applyContext(c);render();}
function rawEdges(){return [...registry.values()].flatMap(({node:n})=>(n.dependsOn||[]).map(from=>({id:from+'>'+n.id,from,to:n.id})));}
function bucket(id,ids){let at=id;while(at){if(ids.has(at))return at;at=ref(at)?.parent;}return null;}
function projectRelations(){
 const ids=new Set(nodes().map(n=>n.id)),groups=new Map(),internal=[],external=[],context=[];
 const ancestry=new Set(state.path);
 for(const edge of rawEdges()){
  const from=bucket(edge.from,ids),to=bucket(edge.to,ids);
  if(from&&to){if(from===to){internal.push({...edge,bucket:from});continue;}const key=from+'>'+to;if(!groups.has(key))groups.set(key,{from,to,edges:[]});groups.get(key).edges.push(edge);}
  else if(from||to)external.push({...edge,bucket:from||to,direction:to?'incoming':'outgoing'});
  else if(ancestry.has(edge.from)||ancestry.has(edge.to))context.push({...edge,direction:ancestry.has(edge.to)?'incoming':'outgoing'});
 }
 const grouped=[...groups.values()],indegree=new Map(nodes().map(n=>[n.id,0])),rank=new Map(nodes().map(n=>[n.id,0]));
 grouped.forEach(e=>indegree.set(e.to,indegree.get(e.to)+1));const queue=[...indegree].filter(([,v])=>v===0).map(([id])=>id);let visited=0;
 while(queue.length){const id=queue.shift();visited++;for(const e of grouped.filter(e=>e.from===id)){rank.set(e.to,Math.max(rank.get(e.to),rank.get(id)+1));indegree.set(e.to,indegree.get(e.to)-1);if(indegree.get(e.to)===0)queue.push(e.to);}}
 const cyclic=visited!==ids.size;if(cyclic)nodes().forEach((n,i)=>rank.set(n.id,i%3));
 return {groups:grouped,internal,external,context,rank,cyclic};
}
function edgeRow(e){return '<p class="edge-row"><button type="button" data-goto="'+esc(e.from)+'">'+esc(e.from)+' '+esc(ref(e.from).node.title)+'</button> → <button type="button" data-goto="'+esc(e.to)+'">'+esc(e.to)+' '+esc(ref(e.to).node.title)+'</button></p>';}
function relationsPanel(){
 const p=projectRelations(),shown=new Set(visible().map(n=>n.id));
 const hidden=p.groups.filter(e=>!shown.has(e.from)||!shown.has(e.to)).reduce((n,g)=>n+g.edges.length,0)+p.external.filter(e=>!shown.has(e.bucket)).length;
 return '<section class="relations"><strong>关系透镜</strong> <span class="mini-note">归属 ≠ 硬依赖 ≠ 验收汇合</span><div class="relation-metrics">本层聚合边 '+p.groups.length+' · 外部前提 '+p.external.filter(e=>e.direction==='incoming').length+' · 影响外部 '+p.external.filter(e=>e.direction==='outgoing').length+' · 父级关系 '+p.context.length+' · 筛选隐藏关系 '+hidden+'</div>'+(p.cyclic?'<p class="warning">分组投影相互关联：保留全部边；下钻看真实端点，本层不是可拓扑排序的叶子DAG。</p>':'')+p.groups.map(g=>'<details><summary>'+esc(g.from)+' → '+esc(g.to)+' · '+g.edges.length+' 条原始依赖（不表示整个目标等待）</summary>'+g.edges.map(edgeRow).join('')+'</details>').join('')+(p.external.length?'<details open><summary>跨出当前焦点的直接依赖 · '+p.external.length+' 条</summary>'+p.external.map(edgeRow).join('')+'</details>':'')+(p.context.length?'<details><summary>父级前提/影响 · '+p.context.length+' 条（不推断每个孩子都受约束）</summary>'+p.context.map(edgeRow).join('')+'</details>':'')+(p.internal.length?'<details><summary>收拢在本层节点内部 · '+p.internal.length+' 条（下钻还原）</summary>'+p.internal.map(edgeRow).join('')+'</details>':'')+'<p class="mini-note">硬依赖仅统计数据中已声明的关系；未声明不等于现实中没有。外部定位后可用“返回原焦点”。</p></section>';
}
const originalNav=renderNav;
renderNav=function(){
 originalNav();const all=nodes(),v=visible(),allBelow=all.flatMap(n=>descendants(n)),hidden=all.length-v.length;
 el('kpis').innerHTML='<div class="kpi"><div class="k-label">CURRENT SCOPE</div><div class="k-value">'+esc(scope()?.title||'全部一级目标')+'</div><div class="k-foot">L'+level()+' · '+v.length+'/'+all.length+' 本层可见</div></div><div class="kpi"><div class="k-label">ACCEPTED / INDEPENDENT GATE</div><div class="k-value">'+all.filter(isAccepted).length+' / '+all.length+'</div><div class="k-foot">本层独立验收，不按子任务平均</div></div><div class="kpi"><div class="k-label">KEY ATTENTION / ALL SCOPE</div><div class="k-value">'+all.filter(n=>n.attention==='focus').length+'</div><div class="k-foot">不因搜索/筛选减少 · 隐藏'+hidden+'项</div></div><div class="kpi"><div class="k-label">BLOCKERS / ALL SCOPE</div><div class="k-value">'+all.filter(n=>n.status==='blocked').length+' <small>+ '+allBelow.filter(n=>n.status==='blocked').length+' 下层</small></div><div class="k-foot">隐藏阻塞仍计数；父/子标记不去重为事故数</div></div>';
 el('scopeNote').innerHTML+='<div class="integration-note">v2样例整合 · 跨目标边是合成压力案例，不连接DSH任务看板/会话日志。阶段站位不是验收证据。</div>';
 if(notice){const n=document.createElement('div');n.className='warning';n.textContent=notice;el('scopeNote').append(n);}
 const back=el('returnOrigin');if(back)back.disabled=!returnTrail.length;
};
const originalTree=renderTree;
renderTree=function(){originalTree();document.querySelectorAll('#tree [data-goto]').forEach(btn=>{const n=ref(btn.dataset.goto).node,s=nodeStats(n),b=document.createElement('small');b.className='tree-count';b.textContent=s.direct?' '+s.accepted+'/'+s.direct+' 验收 · '+s.blocked+' 下层阻塞':'';btn.append(b);});};
renderDag=function(items){
 if(!items.length)return '<div class="empty">本层没有符合条件的节点；全层风险与关系仍在下方保留。</div>';
 const p=projectRelations(),columns=new Map(),pos=new Map();
 nodes().forEach(n=>{const col=p.rank.get(n.id);if(!columns.has(col))columns.set(col,[]);columns.get(col).push(n);});
 columns.forEach((arr,col)=>arr.forEach((n,i)=>pos.set(n.id,{x:30+col*270,y:65+i*128})));
 const w=Math.max(900,columns.size*270+40),h=Math.max(360,...[...columns.values()].map(a=>100+a.length*128)),ids=new Set(items.map(n=>n.id));
 let s='<div class="svg-canvas dag"><svg viewBox="0 0 '+w+' '+h+'" role="img" aria-label="聚合依赖图"><defs><marker id="arrowHead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8" fill="#7192b9"/></marker></defs>';
 for(const e of p.groups){if(!ids.has(e.from)||!ids.has(e.to))continue;const a=pos.get(e.from),b=pos.get(e.to);s+='<path data-projected-edge="'+esc(e.from+'>'+e.to)+'" d="M'+(a.x+225)+' '+(a.y+32)+' C'+(a.x+250)+' '+(a.y+32)+','+(b.x-20)+' '+(b.y+32)+','+(b.x-6)+' '+(b.y+32)+'" fill="none" stroke="#91a9c5" stroke-width="2" marker-end="url(#arrowHead)"/><text class="svg-small" x="'+((a.x+b.x+225)/2)+'" y="'+((a.y+b.y)/2+17)+'">'+e.edges.length+' 条</text>';}
 for(const n of items){const a=pos.get(n.id),st=status(n.status),counts=nodeStats(n),outside=p.external.filter(e=>e.bucket===n.id).length;s+='<g class="svg-node '+(n.id===state.selected?'selected':'')+'" data-select="'+esc(n.id)+'" tabindex="0" role="button" aria-label="选择 '+esc(n.title)+'"><rect class="nodecard" x="'+a.x+'" y="'+a.y+'" width="225" height="88" rx="11"/><circle cx="'+(a.x+16)+'" cy="'+(a.y+21)+'" r="5" fill="'+st[1]+'"/><text class="svg-label" x="'+(a.x+29)+'" y="'+(a.y+26)+'">'+esc(shorten(n.title,17))+'</text><text class="svg-small" x="'+(a.x+13)+'" y="'+(a.y+48)+'">'+esc(n.id)+' · '+esc(st[0])+'</text><text class="svg-small" x="'+(a.x+13)+'" y="'+(a.y+70)+'">'+counts.accepted+'/'+counts.direct+' 子项验收 · '+outside+' 外部边</text></g>';}
 return s+'</svg><div class="diagram-info">聚合边标签是底层原始边数。下方展开可查看端点；上钻不把子任务依赖变成整个父目标等待。</div></div>';
};
renderJourney=function(items){
 const required=scope()?.acceptance?.requires||[],all=nodes(),req=new Set(required),gate=required.length>0;
 if(!items.length&&!gate)return '<div class="empty">没有符合筛选的节点；未声明验收门。</div>';
 const H=Math.max(370,135+items.length*106),gateY=85+Math.max(0,items.length-1)*106/2;
 let s='<div class="svg-canvas"><svg viewBox="0 0 1100 '+H+'" role="img" aria-label="声明式验收汇合"><text x="35" y="32" class="svg-small">本层推进线 / 点击选中后下钻</text><text x="850" y="32" class="svg-small">'+(gate?'显式验收要求':'未声明共同验收门，不强行汇合')+'</text>';
 items.forEach((n,i)=>{const y=89+i*106,c=color(i),x=530+n.stage*52,st=status(n.status);s+='<path class="lane" d="M260 '+y+' H'+x+'" stroke="'+c+'"/>';
  if(gate&&req.has(n.id))s+='<path data-gate-source="'+esc(n.id)+'" class="lane" d="M'+(x+18)+' '+y+' C855 '+y+',885 '+gateY+',995 '+gateY+'" stroke="'+c+'" opacity=".45"/>';
  else s+='<path class="lane" d="M'+(x+20)+' '+(y-9)+' V'+(y+9)+'" stroke="'+c+'"/><text class="svg-small" x="'+(x+39)+'" y="'+(y+5)+'">'+(gate?'非必需项，不自动汇合':'独立推进')+'</text>';
  s+='<g class="svg-node '+(state.selected===n.id?'selected':'')+'" data-select="'+esc(n.id)+'" tabindex="0" role="button" aria-label="选择 '+esc(n.title)+'"><rect class="nodecard" x="35" y="'+(y-30)+'" rx="10" width="225" height="62" fill="white" stroke="#d3dfed"/><text class="svg-label" x="49" y="'+(y-7)+'">'+esc(shorten(n.title,18))+'</text><text class="svg-small" x="49" y="'+(y+15)+'">'+esc(n.id)+' · '+esc(st[0])+'</text><circle cx="'+x+'" cy="'+y+'" r="13" fill="white" stroke="'+c+'" stroke-width="5"/><text class="svg-small" x="'+(x-10)+'" y="'+(y-25)+'">'+esc(stages[n.stage])+'</text></g>';
 });
 if(gate)s+='<circle class="gate" cx="1000" cy="'+gateY+'" r="20"/><circle cx="1000" cy="'+gateY+'" r="5" fill="#395b8c"/><text class="svg-small" x="1000" y="'+(gateY+42)+'" text-anchor="middle">'+esc(scope().id)+' 独立验收门</text>';
 s+='</svg><div class="diagram-info">'+(gate?'门要求 '+required.map(esc).join('、')+'；必需项已验收 '+required.filter(id=>isAccepted(ref(id).node)).length+'/'+required.length+'；隐藏必需项 '+required.filter(id=>!items.some(n=>n.id===id)).length+'。父门仍须独立验收。':'当前父节点没有显式 acceptance.requires，不生成虚构汇合站。')+' 同轨表示推进，非硬依赖；阶段不是验收百分比。</div></div>';return s;
};
const originalDetail=renderDetail;
renderDetail=function(){
 originalDetail();const n=selected();if(!n)return;const p=nodeStats(n),a=n.acceptance,refs=n.references||[];
 el('inspector').insertAdjacentHTML('beforeend','<div class="sect"><h3>层级汇总 / 独立验收</h3><p>'+p.accepted+'/'+p.direct+' 直属子项通过验收 · '+p.blocked+' 下层阻塞标记</p><p>本任务：'+(isAccepted(n)?'有适用版本的验收证据':'未独立验收（阶段与完成声明不能替代）')+'</p>'+(a?'<p>必过项：'+a.requires.map(esc).join('、')+'</p>':'')+'</div>'+(refs.length?'<div class="sect"><h3>共享工作 · 仅引用，不计子项</h3>'+refs.map(id=>'<button class="outline" data-goto="'+esc(id)+'" type="button">↗ '+esc(id)+' '+esc(ref(id).node.title)+'</button>').join('')+'</div>':''));
};
function syncLocation(){const u=new URL(location.href);u.searchParams.set('view',state.view);u.searchParams.set('focus',state.path.at(-1)||'root');if(state.selected)u.searchParams.set('selected',state.selected);else u.searchParams.delete('selected');try{history.replaceState(null,'',u);}catch{}}
const originalRender=render;
render=function(){originalRender();el('visualization').insertAdjacentHTML('beforeend',relationsPanel());syncLocation();if(pendingScroll){const c=pendingScroll;pendingScroll=null;window.scrollTo(0,c.scrollY||0);el('tree').parentElement.scrollTop=c.treeY||0;const v=el('visualization').querySelector('.viz-scroll,.svg-canvas');if(v)v.scrollLeft=c.vizX||0;}};
function switchView(view){if(!viewKeys.includes(view))return;state.view=view;render();}
importData=function(candidate){
 const map=validateDataset(candidate),previous=data,oldRegistry=registry,oldState=capture(),oldNotice=notice,cache=[...contextCache],trail=[...returnTrail];
 try{data=candidate;registry=map;state.path=[];state.selected=data.projects[0].id;state.query='';state.focus=false;state.collapsed=new Set(data.projects.slice(1).map(n=>n.id));contextCache.clear();returnTrail.length=0;notice='已导入 '+registry.size+' 个canonical任务；共享引用不增加任务数。';render();el('sampleBadge').textContent=candidate.meta?.kind==='illustrative'?'已导入演示数据':'已导入数据 · 状态未独立核实';}
 catch(error){data=previous;registry=oldRegistry;notice=oldNotice;applyContext(oldState);contextCache.clear();cache.forEach(([k,v])=>contextCache.set(k,v));returnTrail.splice(0,returnTrail.length,...trail);render();throw error;}
};
el('importInput').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>1024*1024)throw Error('设计稿最多导入1MiB JSON');importData(JSON.parse(await file.text()));}catch(error){notice='导入失败，原数据与焦点未变：'+error.message;render();}e.target.value='';});
const actions=document.createElement('div');actions.className='demo-actions';actions.innerHTML='<span>关系演示：</span><button type="button" class="outline" id="overviewDemo">L1 聚合边</button><button type="button" class="outline" data-goto="W22">下钻 P02 看外部前提</button><button type="button" class="outline" data-goto="W21">共享工作引用</button><button type="button" class="outline" id="returnOrigin" disabled>↶ 返回原焦点</button>';
el('kpis').before(actions);
el('overviewDemo').onclick=()=>{remember();returnTrail.push(capture());state.path=[];state.selected='P01';state.query='';state.focus=false;state.view='dag';render();};
el('returnOrigin').onclick=returnToOrigin;
document.addEventListener('keydown',e=>{if(e.target.closest('input,textarea,select,[contenteditable=true]'))return;if(e.key==='ArrowLeft'||e.key==='ArrowRight'){const delta=e.key==='ArrowRight'?1:-1;switchView(viewKeys[(viewKeys.indexOf(state.view)+delta+viewKeys.length)%viewKeys.length]);}});
// URL recovery requires validated ancestry, never trusts arbitrary paths.
const initialParams=new URLSearchParams(location.search);
const baseBuild=buildRegistry;
buildRegistry=function(){baseBuild();if(!buildRegistry.initialized){buildRegistry.initialized=true;const v=initialParams.get('view');if(viewKeys.includes(v))state.view=v;const f=initialParams.get('focus');if(f&&f!=='root'&&ref(f)&&ref(f).node.children.length){state.path=[...pathFor(f),f];}const id=initialParams.get('selected');if(id&&nodes().some(n=>n.id===id))state.selected=id;}};
window.FocusHubIntegration={getData:()=>copy(data),validate:validateDataset,importData,projection:projectRelations,rawEdges,accepted:isAccepted,switchView,back:returnToOrigin,getContext:capture,getReturnCount:()=>returnTrail.length,getRegistrySize:()=>registry.size};
