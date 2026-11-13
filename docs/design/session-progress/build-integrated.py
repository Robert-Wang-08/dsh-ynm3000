"""Build a reviewed offline derivative; never executes supplied reference code."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
source = (ROOT / 'reference-v2/task_focus_hub_v2.html').read_text(encoding='utf-8')
data = json.loads((ROOT / 'reference-v2/focus_hub_demo_data.json').read_text(encoding='utf-8'))
seed = re.search(r'<script id="seedData" type="application/json">(.*?)</script>', source, re.S)
assert seed and json.loads(seed.group(1)) == data, 'Reference HTML and JSON disagree'
index = {}
def walk(node):
    index[node['id']] = node
    for child in node['children']:
        walk(child)
for project in data['projects']:
    walk(project)
assert len(index) == 37
# Clearly synthetic relationships: never inferred facts about the represented businesses.
index['T221']['dependsOn'] = list(dict.fromkeys(index['T221'].get('dependsOn', []) + ['T111']))
index['T232']['dependsOn'] = list(dict.fromkeys(index['T232'].get('dependsOn', []) + ['T123']))
index['W21']['references'] = ['T111']
for identity, required in [('P01', ['W11', 'W12', 'W13']), ('W11', ['T111', 'T112'])]:
    index[identity]['acceptance'] = {'requires': required, 'accepted': False, 'origin': 'self-report',
        'revision': 'demo-r1', 'targetRevision': 'demo-r1', 'evidence': '演示：尚无独立验收'}
data['meta']['integration'] = {'source': 'task_focus_hub_v2_package.zip', 'kind': 'illustrative-stress-case',
    'addedDependencies': ['T111>T221', 'T123>T232'], 'sharedReference': 'W21 references T111',
    'note': '新增关系与验收门均为合成压力案例，不是实际业务推断'}
(ROOT / 'integrated-demo-data.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + chr(10), encoding='utf-8')
encoded = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
for char, suffix in [('&', 'u0026'), ('<', 'u003c'), ('>', 'u003e')]:
    encoded = encoded.replace(char, chr(92) + suffix)
source = source[:seed.start(1)] + encoded + source[seed.end(1):]
source = source.replace('<title>Focus Hub · 任务进度总控 v2</title>', '<title>Focus Hub · v2 样例整合参考稿</title>')
source = source.replace('进度总控 · 分层注意力地图', '进度总控 · 关系联动整合稿')
source = source.replace('阶段位置表示验收进度，而非聊天频次', '阶段位置仅为阶段声明；验收需独立证据')
source = source.replace('原型 v2 · 完全离线', 'v2 样例整合参考稿 · 衍生设计，未部署 · 完全离线')
csp = """<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">"""
source = source.replace('<meta charset="UTF-8">', '<meta charset="UTF-8">' + chr(10) + csp)
extra_css = '''
.demo-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 12px;font-size:11px;color:#71819a}
.demo-actions .outline{font-size:11px;padding:6px 9px}.integration-note{margin-top:7px;color:#816d45}
.relations{border-top:1px solid #e2eaf5;margin:17px 2px 0;padding:14px 5px;font-size:12px}
.relation-metrics{font-size:11px;color:#58779c;margin:9px 0}.relations details{padding:7px 3px;border-top:1px solid #eff3f7}
.relations summary{cursor:pointer;color:#47668f}.edge-row{margin:8px 0;line-height:1.8;overflow-wrap:anywhere}
.edge-row button{border:1px solid #d9e4f3;background:#f7faff;color:#3c6193;border-radius:5px;padding:3px 7px;font-size:11px;max-width:100%;text-align:left}
.warning{padding:8px 11px;background:#fff2d9;color:#866226;border-radius:7px;font-size:11px;margin:8px 0}
.tree-count{display:block;font-size:9px;color:#8a9ab0;padding-left:2px}.board{grid-template-columns:repeat(6,minmax(125px,1fr));min-width:835px}
#integration-test-result{white-space:pre-wrap;font-size:11px;padding:12px}.kpi small{font-size:12px;color:#8b9aaf}
'''
source = source.replace('</style>', extra_css + '</style>', 1)
source = chr(10).join(line for line in source.splitlines() if not line.startswith("el('importInput').addEventListener('change'"))
enhancements = (ROOT / 'v2-enhancements.js').read_text(encoding='utf-8')
needle = 'try{buildRegistry();render()}catch(e)'
assert source.count(needle) == 1
source = source.replace(needle, enhancements + chr(10) + needle, 1)
tests = (ROOT / 'v2-selftest.js').read_text(encoding='utf-8')
assert source.count('})();') == 1
source = source.replace('})();', tests + chr(10) + '})();', 1)
(ROOT / 'integrated-prototype.html').write_bytes(source.encode('utf-8'))
print('Built integrated-prototype.html, bytes=', len(source.encode('utf-8')), 'canonical nodes=', len(index))
