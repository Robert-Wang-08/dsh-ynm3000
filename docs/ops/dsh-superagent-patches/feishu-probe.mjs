// 补丁 1：让飞书部署检查不再经 MSYS env 执行 lark-cli。
//
// 症状：面板保存时报「机器人的 lark-cli 不可用」+ {"ok":false,...,404 page not found}。
// 根因：检查把命令拼成  env PATH=... env VAR=1 <cli> api GET /open-apis/... ，
//       Git 自带的 MSYS env 会把 /open-apis/... 当 POSIX 路径改写成 C:\Program Files\Git\open-apis\...
//       → 飞书收到乱路径，返回 404。用 cmd 直接跑同一条命令则正常。
// 修法：去掉外层 env 前缀（PATH 交给子进程环境），并让 feishu 检查的 run() 不再拼 env。
export const id = "feishu-probe-no-msys-env";
// 2026-11-10：tsdown 共享 chunk 带内容哈希、逐版本改名，改用通配（runner 支持 *）。
export const target = "lib/poll-*.js";
export const summary = "飞书部署检查去掉 MSYS env 前缀（修 404 page not found）";

export const applied = (text) =>
  text.includes("probe([cli, ...args]).catch(fail)") &&
  text.includes("{ ...process.env, PATH: path }");

export function apply(text) {
  let out = text;

  // (a) feishu 检查的 run()：probe(["env", "VAR=1", ..., cli, ...args]) → probe([cli, ...args])
  out = out.replace(
    /const run = \(\.\.\.args\) => probe\(\[[\s\S]{0,400}?\]\)\.catch\(fail\);/,
    "const run = (...args) => probe([cli, ...args]).catch(fail);",
  );

  // (b) workerProbe：不再把 PATH 作为 env 的第一段参数，改由子进程 env 传递
  out = out.replace(
    /return \(argv\) => runAsWorker\(subprocess, \[\s*"env",[\s\S]{0,120}?\.\.\.argv\s*\], cwd, (AbortSignal\.any\(\[signal, AbortSignal\.timeout\(6e4\)\]\))\);/,
    "return (argv) => runAsWorker(subprocess, argv, cwd, $1, { ...process.env, PATH: path });",
  );

  if (out === text) throw new Error("feishu-probe: 没有匹配到任何一处，补丁可能需要更新");
  return out;
}
