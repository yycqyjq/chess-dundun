#!/usr/bin/env node
/**
 * 测试链的胶水脚本：不引依赖、不藏逻辑，就是「全跑完，谁红了报谁，汇总退出」。
 *
 * 为什么不用 `a && b && c`：一红就短路，后面几套全跳过，一轮 CI 只能见一个失败；
 * 也不用 `; s=$?; … exit $((s+t+u))` 那种退出码相加：读不出哪份红了，信号退出还会撞上别的语义。
 * 本文件只跑联机三件套（刀谱 suite:test:net 指的就是它）；全套走 test-all.mjs。加套件时两处都要补。
 *
 * 用法：`npm run test:net`（即 `node tools/test-net.mjs`）。
 */
import { spawnSync } from 'node:child_process';

/** 联机三件套：桌生命周期 / 宿主与账 / 形闸·快照·WS 服务端；顺序就是打印顺序 */
const SUITES = [
  ['net:table', 'src/test/net.table.test.ts'],
  ['net:host', 'src/test/net.host.test.ts'],
  ['net:wire', 'src/test/net.wire.test.ts'],
];

console.log(`联机三件套，全跑完再汇总：\n`);

const bad = [];
for (const [name, file] of SUITES) {
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
  console.log(`全过（${SUITES.length} 套）`);
  process.exit(0);
}
for (const [name, why, file] of bad) console.log(`✗ ${name}：${why} —— node --experimental-strip-types ${file}`);
console.log(`\n${bad.length}/${SUITES.length} 套没过`);
process.exit(1);
