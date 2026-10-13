#!/usr/bin/env node
/**
 * 测试链的两个胶水脚本：不引依赖、不藏逻辑，就是「全跑完，谁红了报谁，汇总退出」。
 *
 * 为什么不用 `a && b && c`：一红就短路，后面那几套全跳过，一轮 CI 只能见一个失败；
 * 也不用 `; s=$?; … exit $((s+t+u))` 那种退出码相加：读不出哪份红了，信号退出还会撞上别的语义。
 * 两份文件只是范围不同：test-net 是联机三件套（刀谱 suite:test:net 指的就是它），
 * test-all 是全套十五件。加新套件时在这儿补一行就行。
 *
 * 用法：`node tools/test-net.mjs`（也可 `npm run test:net`）；
 *       `node tools/test-all.mjs [file ...]`——带文件名只跑那几套（写完整路径或其中一段都行）。
 */
import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';

/** [脚本名, 文件相对路径]；顺序就是打印顺序 */
const SUITES = [
  ['rules', 'src/test/rules.test.ts'],
  ['guards', 'src/test/guards.test.ts'],
  ['layout', 'src/test/layout.test.ts'],
  ['style', 'src/test/style.test.ts'],
  ['net:table', 'src/test/net.table.test.ts'],
  ['net:host', 'src/test/net.host.test.ts'],
  ['net:wire', 'src/test/net.wire.test.ts'],
  ['link', 'src/web/net.test.ts'],
  ['discover', 'src/test/discover.test.ts'],
  ['native', 'src/web/nativeDiscover.test.ts'],
  ['scan', 'src/web/nativeScan.test.ts'],
  ['local', 'src/web/local.test.ts'],
  ['ui', 'src/web/ui.test.ts'],
  ['qr', 'src/test/qr.test.ts'],
  ['desktop', 'src/test/desktop.test.ts'],
];

const ALL = (process.argv[1] ?? '').endsWith('test-all.mjs');
const asked = process.argv.slice(2);
const chosen = ALL && asked.length ? SUITES.filter(([, f]) => asked.some((a) => f.includes(a.replace(/^\.\//, '')))) : SUITES;
if (ALL && asked.length && chosen.length === 0) {
  console.error(`没认出要跑哪几套：${asked.join(' ')}。可用的：\n${SUITES.map(([, f]) => `  ${f}`).join('\n')}`);
  process.exit(2);
}

console.log(ALL ? `全套 ${chosen.length} 件，全跑完再汇总：\n` : `联机三件套，全跑完再汇总：\n`);

const bad = [];
for (const [name, file] of chosen) {
  const t0 = Date.now();
  // inherit：测试自己的 ✓/✗ 直接往前滚；不合流，哪套红了在汇总里一眼认得出
  // 每个套件经这层薄壳跑：顶层同步掣、定时器回调掣、没接住的许诺都接得住，把话说完再退出；
  // ESM 顶层 await 拒走模块求值错、进程上的钩子接不住——用 import().catch 兑住（探针量过的四档全覆盖）。
  // 没这层壳的话，一声炸就只剩半截栈：挂在哪、还有几套没跑，全不可知。
const HARNESS = [
  "import { pathToFileURL } from 'node:url';",
  "process.on('uncaughtException', (e) => { console.error(`\\n✗ 半路掣了，后面的用例没跑完：${e && e.stack ? e.stack : e}`); process.exit(1); });",
  "process.on('unhandledRejection', (e) => { console.error(`\\n✗ 半路掣了（一句没接住的许诺）：${e && e.stack ? e.stack : e}`); process.exit(1); });",
  "try {",
  "  await import(pathToFileURL(process.argv.at(-1)));",
  "} catch (e) {",
  "  console.error(`\\n✗ 半路掣了，后面的用例没跑完：${e && e.stack ? e.stack : e}`);",
  "  console.error('（最后一个 ✓ 之前都算跑过了的；掣的那一声之后那一批没跑）');",
  "  process.exit(1);",
  "}",
].join('\n');
  const r = spawnSync('node', ['--experimental-strip-types', '--input-type=module', '-e', HARNESS, file], { stdio: 'inherit' });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 0) console.log(`〔${name}〕通过（${dt}s）`);
  else {
    const why = r.signal ? `被信号 ${r.signal} 带走` : `退出码 ${r.status}`;
    bad.push([name, why, file]);
    console.log(`〔${name}〕没过（${why}，${dt}s）`);
  }
}

console.log('');
if (bad.length === 0) {
  console.log(`全过（${chosen.length} 套）`);
  process.exit(0);
}
for (const [name, why, file] of bad) console.log(`✗ ${name}：${why} —— node --experimental-strip-types ${relative(process.cwd(), file)}`);
console.log(`\n${bad.length}/${chosen.length} 套没过`);
process.exit(1);
