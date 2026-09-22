/**
 * 边界规则测试（architecture.md §3 硬性规则）：
 * core src 任何文件不得 import Node 内置模块、DOM、wx、Tauri API。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, "../src");

const FORBIDDEN = [
  /from\s+["']node:/,
  /from\s+["'](fs|path|os|http|https|crypto|util|stream|url|child_process)["']/,
  /require\s*\(/,
  /\bwindow\b/,
  /\bdocument\s*(?:\.|\[|\()/,
  /\bwx\./,
  /@tauri-apps/,
  /\bfetch\s*\(/,
  /\bprocess\.(env|cwd|exit)/,
];

function collectTsFiles(dir: string): string[] {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("core 边界规则", () => {
  it("src 无 Node/DOM/wx/Tauri/fetch/process 引用", () => {
    const files = collectTsFiles(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      // 剥离注释，避免注释中的 wx.request / document 等字样误报
      const content = readFileSync(file, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(content)) {
          violations.push(`${path.relative(SRC_DIR, file)}: ${pattern}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
