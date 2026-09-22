/**
 * 将 packages/core/src 同步（vendor）到 apps/miniprogram/src/vendor/core。
 *
 * 设计要点：
 * - core 是唯一事实来源；小程序壳内不手改 vendor 产物
 * - 内容相同的文件不重写（避免开发服务器监听到大批文件变动，构建出不一致的产物清单）
 * - 源端已删除的文件才在目标端删除；ambient.d.ts 不拷贝（Taro 工程自带 DOM 类型声明）
 * - 将 ESM 风格的 `./x.js` 引用改写为 `./x`（Taro/webpack 只能解析真实存在的 .ts 文件）
 *
 * 用法：node scripts/sync-core-to-miniprogram.mjs
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "packages/core/src");
const DEST = path.join(ROOT, "apps/miniprogram/src/vendor/core");

/** 目标端不需要的文件（相对路径） */
const EXCLUDED = new Set(["ambient.d.ts"]);

function relativeFiles(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...relativeFiles(full, base));
    } else {
      files.push(path.relative(base, full));
    }
  }
  return files;
}

function rewriteImports(content) {
  return content.replace(/(from\s+["'])(\.{1,2}\/[^"']+)\.js(["'])/g, "$1$2$3");
}

const sourceFiles = relativeFiles(SRC).filter((rel) => !EXCLUDED.has(rel));
mkdirSync(DEST, { recursive: true });

let written = 0;
let unchanged = 0;
for (const rel of sourceFiles) {
  const sourcePath = path.join(SRC, rel);
  const targetPath = path.join(DEST, rel);
  mkdirSync(path.dirname(targetPath), { recursive: true });

  const next = rel.endsWith(".ts")
    ? rewriteImports(readFileSync(sourcePath, "utf-8"))
    : readFileSync(sourcePath);

  const sameAsSource =
    typeof next === "string" &&
    existsSync(targetPath) &&
    readFileSync(targetPath, "utf-8") === next;
  if (sameAsSource) {
    unchanged += 1;
    continue;
  }
  writeFileSync(targetPath, next);
  written += 1;
}

// 清理源端已删除 / 已排除的目标文件
let removed = 0;
for (const rel of relativeFiles(DEST)) {
  if (sourceFiles.includes(rel)) {
    continue;
  }
  rmSync(path.join(DEST, rel), { force: true });
  removed += 1;
}

console.log(
  `core vendored: ${SRC} -> ${DEST}（更新 ${written} 个、跳过 ${unchanged} 个、清理 ${removed} 个）`,
);
