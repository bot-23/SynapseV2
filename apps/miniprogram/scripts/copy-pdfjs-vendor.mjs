/**
 * 把 pdf.js 的 legacy minified 构建复制进资料库分包（apps/miniprogram）。
 *
 * 为什么不直接 `import 'pdfjs-dist'`：
 *   Taro 默认把所有 node_modules 打进主包的 vendors.js，而 pdf.js 压缩后仍有约
 *   1.7MB，会直接顶爆微信 2MB 的主包上限。把这两个文件放到分包源码目录下，
 *   webpack 就会把它们算进分包（分包上限同样是 2MB，1.7MB 放得下），
 *   主包因此回到 1MB 以内。
 *
 * 产物目录已 gitignore —— 与 Web 端 scripts/copy-pdfjs-cmaps.mjs 同一套路：
 * npm install 可再生，不入库。
 *
 * 用法：node scripts/copy-pdfjs-vendor.mjs
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(projectRoot, "..", "..", "node_modules", "pdfjs-dist", "legacy", "build");
const targetDir = path.join(projectRoot, "src", "packageDocuments", "pdf", "vendor");

/** 只需要这两个：主线程那份负责 API，worker 那份负责真正的解析。 */
const FILES = ["pdf.min.mjs", "pdf.worker.min.mjs"];

if (!existsSync(sourceDir)) {
  console.error(`[pdfjs] 找不到 pdf.js 构建产物：${sourceDir}，先跑 npm install`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });

let copied = 0;
let skipped = 0;
for (const name of FILES) {
  const from = path.join(sourceDir, name);
  const to = path.join(targetDir, name);
  if (existsSync(to) && statSync(to).size === statSync(from).size) {
    skipped += 1;
    continue;
  }
  copyFileSync(from, to);
  copied += 1;
}

console.log(`[pdfjs] 分包 vendor 就绪：${targetDir}（复制 ${copied} 个、跳过 ${skipped} 个）`);
