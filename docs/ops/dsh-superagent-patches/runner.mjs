#!/usr/bin/env node
// 在 dsh-superagent 的 node_modules 副本上应用/校验/回滚补丁。
//
//   node runner.mjs --pkg <dsh-superagent 目录> --mode verify|apply|restore
//
// 补丁本体与这里同目录的 *.mjs（每条导出 id/target/summary/applied()/apply()）：
// 单一事实源在仓库里，node_modules 只是被改写的副本，升级后重跑一次即可。
import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const pkg = resolve(arg("pkg", ""));
const mode = arg("mode", "verify");
const only = arg("patch", "");

if (!existsSync(pkg)) {
  console.error("找不到包目录: " + pkg);
  process.exit(2);
}

const modules = readdirSync(here).filter((f) => f.endsWith(".mjs") && f !== "runner.mjs").sort();

let failures = 0;
const rows = [];

for (const file of modules) {
  const mod = await import(pathToFileURL(join(here, file)).href);
  if (only && mod.id !== only) continue;

  const path = join(pkg, mod.target);
  if (!existsSync(path)) {
    rows.push({ id: mod.id, state: "target-missing" });
    failures += 1;
    continue;
  }

  const text = readFileSync(path, "utf8");
  const ok = mod.applied(text);

  if (mode === "verify") {
    rows.push({ id: mod.id, state: ok ? "applied" : "missing" });
    if (!ok) failures += 1;
    continue;
  }

  if (mode === "restore") {
    const bak = path + ".prepatch-backup";
    if (!existsSync(bak)) {
      rows.push({ id: mod.id, state: "no-backup" });
      failures += 1;
      continue;
    }
    copyFileSync(bak, path);
    rows.push({ id: mod.id, state: "restored" });
    continue;
  }

  if (mode === "apply") {
    if (ok) {
      rows.push({ id: mod.id, state: "already-applied" });
      continue;
    }
    const bak = path + ".prepatch-backup";
    if (!existsSync(bak)) copyFileSync(path, bak);
    let out;
    try {
      out = mod.apply(text);
    } catch (error) {
      rows.push({ id: mod.id, state: "apply-failed", detail: String((error && error.message) || error) });
      failures += 1;
      continue;
    }
    writeFileSync(path, out);
    try {
      execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
      rows.push({ id: mod.id, state: "patched" });
    } catch (error) {
      copyFileSync(bak, path);
      rows.push({ id: mod.id, state: "syntax-error-rolled-back" });
      failures += 1;
    }
    continue;
  }

  console.error("未知 mode: " + mode + " (verify|apply|restore)");
  process.exit(2);
}

for (const r of rows) console.log([r.id, r.state, r.detail || ""].join("\t").trimEnd());
process.exit(failures === 0 ? 0 : 1);
