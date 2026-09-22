/**
 * 校验小程序壳从 vendor/core 的具名导入是否真实存在。
 *
 * 背景：小程序工程不参与本地 tsc 类型检查（依赖由预览沙箱安装），
 * 因此跨 vendor 边界的「名称漂移」（如 core 导出 snake_case、壳里写 camelCase）
 * 只会在运行时才炸。此脚本在同步 core 之后立即做一次静态校验。
 *
 * 用法：node scripts/check-vendor-imports.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_ENTRY = path.join(ROOT, "apps/miniprogram/src/vendor/core/index.ts");
const APP_SRC = path.join(ROOT, "apps/miniprogram/src");

function listFiles(dir, filter) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") {
      continue;
    }
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listFiles(full, filter));
    } else if (filter(entry)) {
      files.push(full);
    }
  }
  return files;
}

/** 收集某个模块文件对外暴露的名称（含 export * 递归）。 */
function collectExports(file, seen = new Set()) {
  const normalized = path.normalize(file);
  if (seen.has(normalized)) {
    return new Set();
  }
  seen.add(normalized);

  let content;
  try {
    content = readFileSync(normalized, "utf8");
  } catch {
    return new Set();
  }

  const names = new Set();
  const dir = path.dirname(normalized);

  // export * from "./x"
  for (const matched of content.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/g)) {
    namesFor(resolveSpecifier(dir, matched[1]), names, seen);
  }

  // export { a, b as c } from "./x" / export { a, b }
  for (const matched of content.matchAll(/export\s*\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/g)) {
    const source = matched[2];
    const clause = matched[1];
    for (const raw of clause.split(",")) {
      const item = raw.trim();
      if (!item || item.startsWith("type ")) {
        continue;
      }
      const alias = item.split(/\s+as\s+/);
      const local = alias[0].trim();
      const exported = (alias[1] ?? alias[0]).trim();
      if (!exported) {
        continue;
      }
      if (!source) {
        names.add(exported);
        continue;
      }
      // 具名再导出：只信任被导出名（不做深链校验，避免误报）
      names.add(exported);
      void local;
    }
  }

  // 直接声明导出
  const declarationPatterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
    /export\s+const\s+([A-Za-z0-9_$]+)/g,
    /export\s+let\s+([A-Za-z0-9_$]+)/g,
    /export\s+class\s+([A-Za-z0-9_$]+)/g,
    /export\s+interface\s+([A-Za-z0-9_$]+)/g,
    /export\s+type\s+([A-Za-z0-9_$]+)/g,
    /export\s+enum\s+([A-Za-z0-9_$]+)/g,
  ];
  for (const pattern of declarationPatterns) {
    for (const matched of content.matchAll(pattern)) {
      names.add(matched[1]);
    }
  }

  return names;
}

function namesFor(file, target, seen) {
  for (const name of collectExports(file, seen)) {
    target.add(name);
  }
}

function resolveSpecifier(fromDir, specifier) {
  const base = path.resolve(fromDir, specifier.replace(/\.js$/, ""));
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return `${base}.ts`;
}

const available = collectExports(VENDOR_ENTRY);
const shellFiles = listFiles(APP_SRC, (name) => /\.tsx?$/.test(name)).filter(
  (file) => !file.includes(`${path.sep}vendor${path.sep}`),
);

const problems = [];
for (const file of shellFiles) {
  const content = readFileSync(file, "utf8");
  const importPattern = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
  for (const matched of content.matchAll(importPattern)) {
    const specifier = matched[2];
    const resolved = resolveSpecifier(path.dirname(file), specifier);
    if (!resolved.startsWith(path.join(ROOT, "apps/miniprogram/src/vendor/core"))) {
      continue;
    }
    for (const raw of matched[1].split(",")) {
      const item = raw.trim().replace(/^type\s+/, "");
      if (!item) {
        continue;
      }
      const name = item.split(/\s+as\s+/)[0].trim();
      if (!available.has(name)) {
        problems.push(`${path.relative(ROOT, file)}：导入的 ${name} 在 vendor/core 中不存在`);
      }
    }
  }
}

if (problems.length) {
  console.error("vendor 边界校验失败：");
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(`vendor 边界校验通过（core 对外名 ${available.size} 个，检查 ${shellFiles.length} 个壳文件）`);
