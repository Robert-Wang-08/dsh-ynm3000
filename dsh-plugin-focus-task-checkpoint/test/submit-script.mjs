/**
 * dsh-plugin-focus-task-checkpoint：提交脚本解析顺序测试（不启动 DSH、不访问网络）。
 *
 * 覆盖：配置 > 环境变量 > `~/.dsh/skills/focus-task` > 旧版相邻 `../scripts` 的优先级、
 * 去重、以及全部缺失时返回 null。
 *
 * 运行：node test/submit-script.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSubmitScript, submitScriptCandidates } from '../index.js';

const root = await mkdtemp(join(tmpdir(), 'focus-task-resolve-'));

let passed = 0;
/** Run one named assertion group. */
async function check(label, body) {
  await body();
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

/** Create an empty submit.mjs stand-in and return its path. */
async function makeScript(relative) {
  const file = join(root, relative);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, '// stub\n', 'utf8');
  return file;
}

try {
  const configScript = await makeScript('config/submit.mjs');
  const envScript = await makeScript('env/submit.mjs');
  const homeScript = await makeScript('home/.dsh/skills/focus-task/scripts/submit.mjs');
  const legacyScript = await makeScript('legacy/scripts/submit.mjs');

  await check('candidates keep config > env > ~/.dsh/skills > legacy order', async () => {
    const candidates = submitScriptCandidates({
      config: { submitScript: configScript },
      env: { FOCUS_HUB_SUBMIT_SCRIPT: envScript },
      home: join(root, 'home'),
      pluginRoot: join(root, 'legacy', 'app'),
    });
    assert.deepEqual(candidates, [configScript, envScript, homeScript, legacyScript]);
  });

  await check('blank config/env values are ignored', async () => {
    const candidates = submitScriptCandidates({
      config: { submitScript: '  ' },
      env: { FOCUS_HUB_SUBMIT_SCRIPT: '' },
      home: join(root, 'home'),
      pluginRoot: join(root, 'legacy', 'app'),
    });
    assert.deepEqual(candidates, [homeScript, legacyScript]);
  });

  await check('duplicate paths are collapsed', async () => {
    const candidates = submitScriptCandidates({
      config: { submitScript: homeScript },
      env: { FOCUS_HUB_SUBMIT_SCRIPT: homeScript },
      home: join(root, 'home'),
      pluginRoot: join(root, 'legacy', 'app'),
    });
    assert.deepEqual(candidates, [homeScript, legacyScript]);
  });

  await check('config path wins when it exists', async () => {
    const found = await resolveSubmitScript({
      config: { submitScript: configScript },
      env: { FOCUS_HUB_SUBMIT_SCRIPT: envScript },
      home: join(root, 'home'),
      pluginRoot: join(root, 'legacy', 'app'),
    });
    assert.equal(found, configScript);
  });

  await check('env path is used when no config is set', async () => {
    const found = await resolveSubmitScript({
      config: {},
      env: { FOCUS_HUB_SUBMIT_SCRIPT: envScript },
      home: join(root, 'home'),
      pluginRoot: join(root, 'legacy', 'app'),
    });
    assert.equal(found, envScript);
  });

  await check('deployed skill root is the default location', async () => {
    const found = await resolveSubmitScript({
      config: {},
      env: {},
      home: join(root, 'home'),
      pluginRoot: join(root, 'legacy', 'app'),
    });
    assert.equal(found, homeScript);
  });

  await check('legacy sibling scripts still resolve', async () => {
    const found = await resolveSubmitScript({
      config: {},
      env: {},
      home: join(root, 'empty-home'),
      pluginRoot: join(root, 'legacy', 'app'),
    });
    assert.equal(found, legacyScript);
  });

  await check('missing scripts resolve to null', async () => {
    const found = await resolveSubmitScript({
      config: {},
      env: {},
      home: join(root, 'empty-home'),
      pluginRoot: join(root, 'missing', 'app'),
    });
    assert.equal(found, null);
  });

  console.log(`\nall ${passed} checks passed`);
} finally {
  await rm(root, { recursive: true, force: true });
}
