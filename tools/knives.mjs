/**
 * 负向验证（动刀）的统一跑法：一处一处把闸拆掉，看那套测试会不会红。
 * 红了才算这条断言真的在守着这处代码——只跑绿测试是量不出「有闸」的。
 *
 *   npm run knives                 # tools/knives/ 下全跑
 *   npm run knives -- spread       # 只跑一个（按文件名，不带 .mjs）
 *   npm run knives -- spread --only=3   # 只跑那把刀（调试用）
 *   npm run knives -- spread --verbose  # 把每一刀红掉的那几句全打出来（量 expect 用）
 *
 * 刀谱格式（`tools/knives/*.mjs` 默认导出一张）：
 *   { id, title, via?: 'smoke', smoke?: 'dev', suite?: 'test:net', knives: [{ rel, from, to, note, expect?, suite?, crash?, belt? }] }
 * 一张谱子里可以混着跑两套闸（某把刀自己写 `suite` 盖掉谱子级的），b8/b12/b13 原本就是这么写的。
 * `crash: true` 给那种「拆了闸整套当场抛、连 ✗ 都打不出来」的刀——这种红法只认退出码，别当成断言钉住了。
 * `belt: true` 反过来：拆的是**冗余保险**（旁边还有别的闸挡着），单拆一道本该谁也看不见，
 * 所以**绿才算合格**；它红了说明那层冗余其实正在挡事，报告里照实写成一条发现，既不冒充成绩也不算没见红。
 *
 * 三条老坑各防一手，都写死在这儿：
 * ① 每把刀前整个回档（`syncSrc`）：只补单个文件会被上一把刀的伤口连坐；
 * ② 起跑先把这套闸里要用的每一套都测一次未变异的绿做基准：基准就红说明崩在刀口之外，下面全不算；
 * ③ 判红要同时看退出码**和**那句专属断言文案（`expect`）——只看退出码，别的断言先摔也算它红。
 *
 * 仓库本体一个字都不碰：全程只在 `makeScratch` 造的临时目录里动刀，量完就删。
 * 刀口（`from`）一律抄源码里现成的那一段，别凭记忆写——凭记忆写的刀全部「刀口没找着」。
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeScratch, dropScratch, run, syncSrc, REPO } from './lib.mjs';
import { smokeOnce } from './smoke.mjs';

const KNIVES_DIR = join(REPO, 'tools', 'knives');

const suiteOf = (spec, k) => k.suite ?? spec.suite;
const isSmoke = (spec, k) => (k.via ?? spec.via) === 'smoke';

/** 这一把刀走哪套闸（冒烟就算一类，不分端口） */
const gateOf = (spec, k) => (isSmoke(spec, k) ? `smoke:${k.smoke ?? spec.smoke ?? 'dev'}` : suiteOf(spec, k));

/** 跑一把刀：返回见没见红、钉住它的那句断言、红了几个字 */
async function tryKnife(spec, k, scratch) {
  syncSrc(scratch);
  const file = join(scratch, k.rel);
  const text = readFileSync(file, 'utf8');
  if (!text.includes(k.from)) return { missing: true, note: `刀口没找着（${k.rel}）：${k.from.slice(0, 46)}` };
  const next = text.replace(k.from, k.to);
  if (next === text) return { missing: true, note: '改完一个字节都没变' };
  writeFileSync(file, next);
  if (!readFileSync(file, 'utf8').includes(k.to)) return { missing: true, note: '写回去没落盘' };

  const r = isSmoke(spec, k)
    ? await smokeOnce({ kind: k.smoke ?? spec.smoke ?? 'dev', dir: scratch })
    : run('npm', ['run', suiteOf(spec, k)], { cwd: scratch, timeout: 300_000 });
  const reds = r.out.match(/✗ [^\n]*/g) ?? [];
  const mine = k.expect ? reds.filter((l) => l.includes(k.expect)) : reds;
  // 判红：整套打出了 ✗ 就照断言文案钉（钉不上不算它红）；一句 ✗ 都没有说明它当场抛了 ——
  // 那种只有明写 crash: true 的刀才算红，它证的是「拆了这闸这套就跑不下去」，不是某句断言守着。
  const threw = reds.length === 0;
  const red = r.code !== 0 && (threw ? !!k.crash : k.expect ? mine.length > 0 : true);
  return {
    code: r.code,
    redCount: reds.length,
    reds: reds.slice(0, 8),
    first: reds[0] ?? '',
    pinned: mine[0] ?? '',
    red,
    crash: threw && !!k.crash,
    belt: !!k.belt,
    // belt 那档反过来判：绿才算这把量对了
    pass: k.belt ? !red : red,
    where: isSmoke(spec, k) ? `${k.smoke ?? spec.smoke ?? 'dev'} 冒烟` : suiteOf(spec, k),
  };
}

async function runSpec(spec, only) {
  const knives = only ? spec.knives.filter((_, i) => String(i + 1) === only) : spec.knives;
  const scratch = makeScratch(`knife-${spec.id}`);
  const rows = [];
  try {
    // 基准：这套谱子里要用的每一套闸，没动过刀都得是绿的，否则后面每一把刀都是白量
    const gates = [...new Set(knives.map((k) => gateOf(spec, k)))];
    for (const g of gates) {
      const base = g.startsWith('smoke:')
        ? await smokeOnce({ kind: g.split(':')[1], dir: scratch })
        : run('npm', ['run', g], { cwd: scratch, timeout: 300_000 });
      if (base.code !== 0) {
        const first = (base.out.match(/✗ [^\n]*/) ?? [''])[0];
        return { abort: `基准（没动刀）就红：${g} 退出码 ${base.code}｜${first || base.err || '没吐出 ✗ 那几句'}——下面全不算` };
      }
      console.log(`\n${spec.title}｜基准（没动刀）绿：${g} ${(base.out.match(/✓ /g) ?? []).length} 条通过，退出码 0`);
    }
    for (let i = 0; i < knives.length; i++) rows.push({ idx: only ? Number(only) : i + 1, ...(await tryKnife(spec, knives[i], scratch)) });
  } finally {
    dropScratch(scratch);
  }
  return { rows };
}

function report(spec, r, verbose = false) {
  const k = spec.knives[r.idx - 1];
  if (r.missing) return `  刀口没了 ✗  ${r.idx} ${k?.note ?? ''}｜${r.note}`;
  if (r.belt) {
    // 冗余保险反过来读：绿＝这道单拆确实没人看得见（合格）；红＝它其实正在挡事，那是一条发现
    const head = r.pass
      ? `  belt 绿 ✓  ${r.idx} ${k?.note ?? ''}｜${r.where} 退出码 ${r.code}｜红了 ${r.redCount} 条｜单拆它确实没人看得见`
      : `  belt 红了 ✗  ${r.idx} ${k?.note ?? ''}｜${r.where} 退出码 ${r.code}｜红了 ${r.redCount} 条｜它其实正在挡事，可以搬回普通刀（补上 expect）`;
    const all = verbose && r.reds?.length ? `\n      红的一共 ${r.redCount} 条：${r.reds.join(' ／ ')}` : '';
    return head + all;
  }
  const pin = r.pinned || (r.crash ? '（这把只认退出码：整套当场抛，没打 ✗）' : r.first ? `（没钉到，只见着 ${r.first}）` : '没有');
  const all = verbose && r.reds?.length ? `\n      红的一共 ${r.redCount} 条：${r.reds.join(' ／ ')}` : '';
  return `  ${r.red ? '红 ✓' : '绿 ✗'}  ${r.idx} ${k?.note ?? ''}｜${r.where} 退出码 ${r.code}｜红了 ${r.redCount} 条｜钉住它的那句：${pin}${all}`;
}

const argv = process.argv.slice(2);
const only = argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? null;
const verbose = argv.includes('--verbose');
const wanted = argv.filter((a) => !a.startsWith('--'));
const files = readdirSync(KNIVES_DIR)
  .filter((f) => f.endsWith('.mjs'))
  .filter((f) => !wanted.length || wanted.includes(f.replace(/\.mjs$/, '')))
  .sort();
if (!files.length) {
  console.error(`没找到刀谱：${KNIVES_DIR}${wanted.length ? `（要 ${wanted.join('、')}）` : ''}`);
  process.exit(2);
}

// 仓库干净不干净先记一笔：跑完一个字节都不该变（副本在临时目录里，动不到他家）
const dirtyBefore = run('git', ['status', '--porcelain'], { cwd: REPO }).out;
let problems = 0;
for (const f of files) {
  const spec = (await import(pathToFileURL(join(KNIVES_DIR, f)).href)).default;
  const { abort, rows } = await runSpec(spec, only);
  if (abort) {
    console.log(`\n${spec.title}：${abort}`);
    problems++;
    continue;
  }
  console.log(`\n${spec.title}：每把刀只拆一处`);
  for (const r of rows) {
    console.log(report(spec, r, verbose));
    // belt 那档不参与「没见红」的账：它绿才是对的，红了另算一条发现
    if (!r.missing && !r.belt && !r.pass) problems++;
  }
  problems += rows.filter((r) => r.missing).length;
}
const dirtyAfter = run('git', ['status', '--porcelain'], { cwd: REPO }).out;
const repoUntouched = dirtyBefore === dirtyAfter;
console.log(`\n${repoUntouched ? '仓库没动 ✓' : '仓库被动过 ✗'}  git status --porcelain 前后${repoUntouched ? '一致' : '不一致'}${repoUntouched ? '' : `\n前：${dirtyBefore}\n后：${dirtyAfter}`}`);
const total = files.length;
console.log(problems ? `\n${total} 张刀谱里 ${problems} 处没见红\n` : `\n${total} 张刀谱的刀都钉在了它要防的那句上，仓库一个字没动\n`);
process.exit(problems || !repoUntouched ? 1 : 0);
