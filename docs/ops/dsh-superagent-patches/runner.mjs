#!/usr/bin/env node
// 在 dsh-superagent 副本（profile 的 node_modules 软链或子模块检出）上应用/校验/回滚补丁。
//
//   node runner.mjs --pkg <dsh-superagent 目录> --mode verify|apply|restore
//
// 补丁本体与这里同目录的 *.mjs（每条导出 id/target/summary/applied()/apply()）：
// 单一事实源在仓库里，被改写的副本只是产物，升级/重新构建后重跑一次即可。
//
// 2026-11-10：target 支持 `*` 通配（例如 `lib/poll-*.js`）。tsdown 会把共享 chunk
// 打成带内容哈希的文件名，逐个版本改名（poll-xx3wdCx6.js → poll-Dh7J1cdM.js），
// 写死文件名会让补丁在每次升级后报 target-missing。
import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
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

/** target 里的通配片段展开成实际文件；没有 `*` 就按单文件处理（保持旧补丁可用）。 */
function expand(target) {
  if (!target.includes("*")) {
    const single = join(pkg, target);
    return existsSync(single) ? [single] : [];
  }
  const dir = join(pkg, dirname(target));
  const base = target.slice(target.lastIndexOf("/") + 1);
  const pattern = new RegExp("^" + base.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => pattern.test(f)).sort().map((f) => join(dir, f));
}

const label = (p) => relative(pkg, p).split("\\").join("/");

const modules = readdirSync(here).filter((f) => f.endsWith(".mjs") && f !== "runner.mjs").sort();

let failures = 0;
const rows = [];

for (const file of modules) {
  const mod = await import(pathToFileURL(join(here, file)).href);
  if (only && mod.id !== only) continue;

  const paths = expand(mod.target);
  if (paths.length === 0) {
    rows.push({ id: mod.id, state: "target-missing", detail: mod.target });
    failures += 1;
    continue;
  }

  if (mode === "verify") {
    const missing = paths.filter((p) => !mod.applied(readFileSync(p, "utf8")));
    rows.push({
      id: mod.id,
      state: missing.length === 0 ? "applied" : "missing",
      detail: paths.map(label).join(","),
    });
    if (missing.length > 0) failures += 1;
    continue;
  }

  if (mode === "restore") {
    let restored = 0;
    for (const path of paths) {
      const bak = path + ".prepatch-backup";
      if (existsSync(bak)) {
        copyFileSync(bak, path);
        restored += 1;
      }
    }
    if (restored === 0) {
      rows.push({ id: mod.id, state: "no-backup", detail: paths.map(label).join(",") });
      failures += 1;
    } else {
      rows.push({ id: mod.id, state: "restored", detail: paths.map(label).join(",") });
    }
    continue;
  }

  if (mode === "apply") {
    const done = [];
    for (const path of paths) {
      const text = readFileSync(path, "utf8");
      if (mod.applied(text)) {
        done.push(label(path) + ":already");
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
        break;
      }
      writeFileSync(path, out);
      try {
        execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
        done.push(label(path) + ":patched");
      } catch (error) {
        copyFileSync(bak, path);
        done.push(label(path) + ":syntax-error-rolled-back");
        failures += 1;
        break;
      }
    }
    if (!rows.some((r) => r.id === mod.id)) rows.push({ id: mod.id, state: "ok", detail: done.join(",") });
    continue;
  }

  console.error("未知 mode: " + mode + " (verify|apply|restore)");
  process.exit(2);
}

for (const r of rows) console.log([r.id, r.state, r.detail || ""].join("\t").trimEnd());
process.exit(failures === 0 ? 0 : 1);
