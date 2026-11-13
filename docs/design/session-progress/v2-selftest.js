// Runs after initialization; test modes never run in a normal preview.
if(new URLSearchParams(location.search).has('restorecheck')){document.body.dataset.restoreTest=(level()===3&&scopeKey()==='P01/W11'&&state.selected==='T112'&&state.view==='board')?'passed':'failed';}
if(new URLSearchParams(location.search).has('selftest')){
 const testLines=[],initialData=copy(data),initialState=capture();
 const check=(name,ok)=>{if(!ok)throw Error(name);testLines.push('PASS '+name);};
 const setQuery=q=>{el('searchInput').value=q;el('searchInput').dispatchEvent(new Event('input',{bubbles:true}));};
 const find=(d,id)=>{let out=null;function walk(n){if(n.id===id)out=n;n.children.forEach(walk);}d.projects.forEach(walk);return out;};
 const rootView=()=>{state.path=[];state.query='';state.focus=false;state.selected='P01';render();};
 try{
  check('reference topology preserved: 4 projects, 37 canonical tasks',data.projects.length===4&&registry.size===37);
  rootView();let p=projectRelations(),pair=p.groups.find(g=>g.from==='P01'&&g.to==='P02');
  check('L1 aggregate exposes exactly two original cross-goal dependencies',pair&&pair.edges.length===2&&pair.edges.map(e=>e.id).sort().join(',')==='T111>T221,T123>T232');
  gotoNode('W22');p=projectRelations();check('L2 exposes both outside prerequisites',p.external.some(e=>e.id==='T111>T221')&&p.external.some(e=>e.id==='T123>T232'));
  drill('W22');p=projectRelations();check('L3 restores precise outside endpoint',level()===3&&p.external.some(e=>e.from==='T111'&&e.to==='T221'));
  gotoNode('T111');check('leaf cannot drill beyond L3',!canDrill(selected()));
  gotoNode('W11');setQuery('总控');state.focus=true;render();const beforeDrill=capture();drill('W11');up();
  check('up restores query focus selection and parent scope',state.query===beforeDrill.query&&state.focus===beforeDrill.focus&&state.selected===beforeDrill.selected&&scopeKey()===scopeKey(beforeDrill.path));
  const beforeJump=capture();gotoNode('T221');returnToOrigin();
  check('cross-goal return restores the original navigation context',state.query===beforeJump.query&&state.focus===beforeJump.focus&&state.selected===beforeJump.selected&&scopeKey()===scopeKey(beforeJump.path));
  const retained=capture();viewKeys.forEach(v=>{switchView(v);check(v+' switch preserves query and focus',state.query===retained.query&&state.focus===retained.focus&&state.selected===retained.selected);});
  rootView();switchView('metro');const trackColor=el('visualization').querySelector('.track[data-select="P02"]').style.getPropertyValue('--trackcolor');setQuery('RFP');
  check('track color survives filtering',el('visualization').querySelector('.track[data-select="P02"]').style.getPropertyValue('--trackcolor')===trackColor);
  check('filter does not reduce total descendant blocker marks',el('kpis').textContent.includes('+ 2 下层'));
  gotoNode('T112');setQuery('T112');check('filtered-out prerequisites remain in relation disclosure',el('visualization').textContent.includes('T111')&&el('visualization').textContent.includes('筛选隐藏关系 3'));
  gotoNode('W21');const size=registry.size,childCount=selected().children.length;
  check('shared reference is not cloned or counted as child',selected().references[0]==='T111'&&size===37&&childCount===2);
  const sharedButton=el('inspector').querySelector('[data-goto="T111"]');check('shared reference can navigate',!!sharedButton);sharedButton.click();returnToOrigin();
  check('shared reference return restores its consumer',state.selected==='W21'&&scopeKey()==='P02');
  drill('W21');switchView('journey');check('no inferred gate when parent has no requirements',!el('visualization').querySelector('circle.gate'));
  gotoNode('W11');switchView('journey');
  check('only explicitly required lines converge',el('visualization').querySelectorAll('[data-gate-source]').length===3&&!el('visualization').querySelector('[data-gate-source="W14"]'));
  setQuery('no-match-anywhere');check('empty filter does not remove declared gate',!!el('visualization').querySelector('circle.gate')&&el('visualization').textContent.includes('隐藏必需项 3'));
  let a=copy(ref('P01').node);a.children.forEach(c=>c.status='done');check('child completion does not auto-accept parent',!isAccepted(a));
  a.acceptance={accepted:true,origin:'self-report',evidence:'claim',revision:'r1',targetRevision:'r1',requires:[]};check('self report never accepts a task',!isAccepted(a));
  a.acceptance.origin='human';a.acceptance.targetRevision='r2';check('old revision cannot satisfy current acceptance',!isAccepted(a));a.acceptance.targetRevision='r1';check('explicit evidence bound acceptance is recognized',isAccepted(a));
  // Validate and reject malformed imports without changing data, focus, or selection.
  const mutations=[
   ['duplicate ID',d=>find(d,'T112').id='T111'],
   ['unknown dependency',d=>find(d,'T112').dependsOn=['unknown']],
   ['invalid dependency type',d=>find(d,'T112').dependsOn='T111'],
   ['invalid status',d=>find(d,'T112').status='NOT_A_STATUS'],
   ['invalid stage',d=>find(d,'T112').stage=9],
   ['self dependency',d=>find(d,'T112').dependsOn=['T112']],
   ['real dependency cycle',d=>find(d,'T111').dependsOn=['T112']],
   ['missing shared reference',d=>find(d,'W21').references=['unknown']],
   ['missing gate requirement',d=>find(d,'P01').acceptance.requires=['unknown']],
   ['non-child gate requirement',d=>find(d,'P01').acceptance.requires=['T221']],
   ['bad children field',d=>find(d,'W11').children='bad']
  ];
  for(const [name,mutate] of mutations){const candidate=copy(initialData);mutate(candidate);const before=JSON.stringify(data),context=capture();let rejected=false;try{importData(candidate);}catch{rejected=true;}check('transaction rejects '+name,rejected&&JSON.stringify(data)===before&&state.selected===context.selected&&scopeKey()===scopeKey(context.path));}
  // Distinguish projection cycles from genuine task dependency cycles.
  const groupedCycle=copy(initialData);find(groupedCycle,'T112').dependsOn.push('T211');importData(groupedCycle);rootView();switchView('dag');
  check('acyclic raw graph may have cyclic grouped projection',projectRelations().cyclic&&projectRelations().groups.some(g=>g.from==='P02'&&g.to==='P01'));
  check('grouped cycle retains both directions and warns',el('visualization').querySelectorAll('[data-projected-edge]').length===2&&el('visualization').textContent.includes('分组投影相互关联'));
  // Force a post-validation render error to check the full rollback path.
  importData(initialData);gotoNode('T112');const rollbackData=JSON.stringify(data),rollbackContext=capture(),badRender=copy(initialData),savedRender=render;
  badRender.meta.failRender=true;render=function(){if(data.meta.failRender)throw Error('synthetic render failure');savedRender();};
  let rolled=false;try{importData(badRender);}catch{rolled=true;}finally{render=savedRender;}
  check('post-commit render failure restores source and navigation',rolled&&JSON.stringify(data)===rollbackData&&state.selected===rollbackContext.selected&&scopeKey()===scopeKey(rollbackContext.path));
  const injection=copy(initialData);find(injection,'T111').title='<img src=x onerror="window.__unsafe=1">';importData(injection);gotoNode('T111');
  check('imported labels are rendered as text, not HTML',!el('inspector').querySelector('img')&&!window.__unsafe&&el('inspector').textContent.includes('<img'));
  importData(initialData);const parents=[null,...[...registry.values()].filter(r=>r.node.children.length).map(r=>r.node.id)];
  for(const v of viewKeys){switchView(v);for(const id of parents){state.path=id?[...pathFor(id),id]:[];state.query='';state.focus=false;state.selected=nodes()[0]?.id;render();check(v+' branch '+(id||'root'),visible().every(n=>ref(n.id).parent===(id||null))&&!el('visualization').innerHTML.includes('NaN'));}}
  importData(initialData);applyContext(initialState);notice='';render();
  check('URL keeps view focus and selection',new URLSearchParams(location.search).get('view')===state.view&&new URLSearchParams(location.search).get('selected')===state.selected);
  document.body.dataset.integrationTest='passed';
 }catch(error){document.body.dataset.integrationTest='failed';testLines.push('FAIL '+error.stack);}
 const result=document.createElement('pre');result.id='integration-test-result';result.textContent=testLines.join('\n');document.body.append(result);
}
