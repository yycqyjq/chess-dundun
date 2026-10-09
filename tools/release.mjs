#!/usr/bin/env node
/**
 * 发布一条龙：工作区必须干净 → 改版本号 → verify → build → 三端出包 → 提交版本号那一笔（打 tag）。
 * 不自动推送：git push --follow-tags 手动来。不带参数就是用法说明，别让它误跑。
 *
 *   npm run release -- --patch             # 0.3.2 → 0.3.3（修与调优）
 *   npm run release -- --minor             # 加一档玩法那种
 *   npm run release -- --major             # 大版本
 *   npm run release -- --version=0.4.0     # 直接指定
 *   npm run release -- --patch --skip=apk  # 跳过某一端（mac,win,apk 逗号分隔）
 *   npm run release -- --patch --dry-run   # 只打印每一步要干什么，什么都不动
 *   npm run release -- --patch --no-tag    # 不打 v 对应的 tag（默认打）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};
const die = (msg) => {
  console.error(`发布停在这里：${msg}`);
  process.exit(1);
};
const run = (cmd) => {
  console.log(`\n→ ${cmd}`);
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit' });
  if (r.status !== 0) die(`上一条命令退出码 ${r.status}（exit ${r.status}）`);
};

if (args.length === 0 || has('help')) {
  console.log(
    '用法：npm run release -- --patch|--minor|--major|--version=x.y.z [--skip=mac,win,apk] [--dry-run] [--no-tag]\n' +
      '  脚本做的事：工作区必须干净 → 改 package.json 版本号 → npm run verify → npm run build →\n' +
      '  desktop:mac / desktop:win / apk:release 三端出包 → 提交「版本号 A → B」并打 v 对应的 tag。\n' +
      '  不自动推送：git push --follow-tags 手动来。',
  );
  process.exit(0);
}

const dry = has('dry-run');
const step = (msg) => console.log(`\n== ${msg}${dry ? '（dry-run：只说不做）' : ''}`);

// 1. 工作区干净：版本号那一笔要落在干净历史上
step('检查工作区');
const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim();
if (dirty && !dry) die('工作区有未提交的改动：先提交（或收起来）再发布');
if (dirty) console.log(`  dry-run 忽略：\n${dirty}`);

// 2. 版本号：x.y.z，按档位升或直接指定
const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const current = pkg.version;
const next =
  value('version') ??
  (() => {
    const [maj, min, pat] = current.split('.').map(Number);
    if (has('major')) return `${maj + 1}.0.0`;
    if (has('minor')) return `${maj}.${min + 1}.0`;
    if (has('patch')) return `${maj}.${min}.${pat + 1}`;
    return undefined;
  })();
if (!next || !/^\d+\.\d+\.\d+$/.test(next)) die('版本号得是 x.y.z：--patch / --minor / --major / --version=x.y.z 挑一个');
if (next === current) die(`版本号没变（还是 ${current}）：升一格再发`);
console.log(`版本号 ${current} → ${next}`);

const skip = (value('skip') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const want = (name) => !skip.includes(name);

// 3. 版本号只写 package.json 一处：vite 的 define、安卓的 versionName/versionCode 都从这儿读
step('改 package.json 版本号');
if (!dry) {
  pkg.version = next;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

// 4. verify：发布前最后一道全绿
step('npm run verify');
if (!dry) run('npm run verify');

// 5. 构建 + 三端出包
step('npm run build');
if (!dry) run('npm run build');
if (want('mac')) {
  step('npm run desktop:mac');
  if (!dry) run('npm run desktop:mac');
}
if (want('win')) {
  step('npm run desktop:win');
  if (!dry) run('npm run desktop:win');
}
if (want('apk')) {
  step('npm run apk:release');
  if (!dry) run('npm run apk:release');
}

// 6. 提交版本号那一笔 + tag（恢复了 v0.1.0~v0.3.0 的老习惯）
step('提交版本号那一笔');
if (!dry) {
  run('git add package.json');
  run(`git commit -m "版本号 ${current} → ${next}"`);
  if (!has('no-tag')) run(`git tag v${next}`);
}

console.log(
  `\n发布完成${dry ? '（dry-run，什么都没动）' : ''}：三端产物在 release/。` +
    `${dry ? '' : '\n收尾：git push --follow-tags（脚本不替你推）。'}`,
);
