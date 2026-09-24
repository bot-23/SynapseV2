/**
 * 用 miniprogram-ci 把 dist/ 上传成体验版。
 *
 * 用法（在 apps/miniprogram 下）：
 *   node scripts/ci-upload.mjs 1.0.0 "版本描述"
 *
 * appid 与私钥路径读自 .auth/auth.json（该目录已 gitignore，不入库）。
 * 上传的是 project.config.json 里 miniprogramRoot 指向的 dist/，
 * 所以跑之前必须先 npm run build:weapp。
 */
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ci = require('miniprogram-ci');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authPath = path.join(projectRoot, '.auth', 'auth.json');

const version = process.argv[2];
const desc = process.argv[3] ?? 'Synapse 学习陪伴';
const robot = Number(process.env.CI_ROBOT ?? 1);

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法：node scripts/ci-upload.mjs <x.y.z> "<版本描述>"');
  process.exit(1);
}

const { weapp } = JSON.parse(readFileSync(authPath, 'utf8'));
const privateKeyPath = path.resolve(projectRoot, weapp.privateKeyPath);

const distDir = path.join(projectRoot, 'dist');
if (!statSync(distDir).isDirectory()) {
  console.error(`没找到构建产物：${distDir}，先跑 npm run build:weapp`);
  process.exit(1);
}
console.log(`产物目录：${distDir}`);
console.log(`上传版本：${version}（机器人 ${robot}）`);

const project = new ci.Project({
  appid: weapp.appid,
  type: 'miniProgram',
  projectPath: projectRoot,
  privateKeyPath,
  ignores: ['node_modules/**/*', '.auth/**/*', 'src/**/*', 'scripts/**/*'],
});

const result = await ci.upload({
  project,
  version,
  desc,
  // 与 project.config.json 的 setting 保持一致：Taro 已经编译过，这里不再二次加工。
  setting: {
    es6: false,
    es7: false,
    minify: false,
    autoPrefixWXSS: false,
  },
  robot,
  onProgressUpdate: (task) => {
    if (typeof task === 'string') {
      console.log(task);
    } else if (task && task._msg) {
      console.log(task._msg);
    }
  },
});

console.log('上传完成');
console.log(JSON.stringify(result, null, 2));
