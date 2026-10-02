/**
 * 负向验证（动刀）的统一跑法：一处一处把闸拆掉，看那套测试会不会红。
 * 红了才算这条断言真的在守着这处代码——只跑绿测试是量不出「有闸」的。
 *
 *   npm run knives                 # tools/knives/ 下全跑
 *   npm run knives -- spread       # 只跑一个（按文件名，不带 .mjs）
 *   npm run knives -- spread --only=3   # 只跑那把刀（调试用）
 *   npm run knives -- spread --only=4-9 # 连号；也认 4,6,12 这种点名，可混写 4-6,9
 *   npm run knives -- spread --no-baseline  # 跳过基准（同一份源码刚验过绿才许用，省一轮全闸）
 *   npm run knives -- --drop        # 不跑刀：清掉所有缓存的临时副本，一把收干净
 *   npm run knives -- spread --verbose  # 把每一刀红掉的那几句全打出来（量 expect 用）
 *   npm run knives -- --affected    # 只跑可能被当前改动波及的刀谱（git diff HEAD ＋ 未跟踪；见下）
 *   npm run knives -- --affected --list   # 只打印选了哪几张、为什么选，不跑
 *   npm run knives -- --affected --base=origin/main  # 拿 origin/main 三点 diff 当改动源，再加工作区改动
 *   npm run knives -- --affected --changed=src/core/pieces.ts  # 显式注入改动路径（测试用）
 *   npm run knives -- --print-closure=test:net  # 打某套闸入口的传递闭包（抽查闭包实现用，不跑刀）
 *
 * --affected 怎么选（四条规则取并集，宁多勿漏；漏刀比多跑严重）：
 *   A 精确：改的文件 == 某刀 `rel` → 选中那张谱子；
 *   B 套件闭包：改的文件在某个 `test:*` 入口的传递 import 闭包内（含 readFileSync(new URL(...)) 的资源引用）
 *     → 选中 suite 命中该套件的全部谱子。入口文件本身改动也算。
 *     没有它，那 7 个「被闸门依赖却不在任何 rel 里」的源文件（pieces/rng/trick/view/agent/load_rules/qr）会全漏；
 *   C 全局：package.json／tsconfig*／vite.config.ts／rules.json／tools/**／非入口的 *.test.ts → 全跑；
 *   D 兜底：改动在 src/** 或 desktop/** 但 A/B 都没认领 → 全跑并打告警（闭包可能没覆盖到，人工看一眼）。
 * 工作区干净 → 选 0 张、exit 0。--affected 与 --only/--verbose/--no-baseline 取交集（先选谱子再套 only 过滤）。
 *
 * 刀谱格式（`tools/knives/*.mjs` 默认导出一张）：
 *   { id, title, via?: 'smoke', smoke?: 'dev', suite?: 'test:net', knives: [{ rel, from, to, note, expect?, suite?, crash?, belt? }] }
 * 一张谱子里可以混着跑两套闸（某把刀自己写 `suite` 盖掉谱子级的），b8/b12/b13 原本就是这么写的。
 * `crash: true` 给那种「拆了闸整套当场抛、连 ✗ 都打不出来」的刀——这种红法只认退出码，别当成断言钉住了。
 * `belt: true` 反过来：拆的是**冗余保险**（旁边还有别的闸挡着），单拆一道本该谁也看不见，
 * 所以**绿才算合格**；它红了说明那层冗余其实正在挡事——报告里单列一句「belt 红了 ✗」，不混进「几把刀全红」那句成绩，
 * 但整架退出码算它没过（2026-09-29 在一份临时副本里实测过这条分支：把某把 belt 的刀口改成有真后果，
 * 那一句照打、末尾另点一行、退出码 1；红了就搬回普通刀补 `expect`）。
 *
 * 三条老坑各防一手，都写死在这儿：
 * ① 每把刀前整个回档（`syncSrc`）：只补单个文件会被上一把刀的伤口连坐；
 * ② 起跑先把这套闸里要用的每一套都测一次未变异的绿做基准：基准就红说明崩在刀口之外，下面全不算；
 * ③ 判红要同时看退出码**和**那句专属断言文案（`expect`）——只看退出码，别的断言先摔也算它红。
 *
 * 仓库本体一个字都不碰：全程只在 `makeScratch` 造的临时目录里动刀；副本常驻复用不自动删，
 * 分批跑不再每调用一次就建删一整份（2026-10-02 前每把 --only 都全仓建删一次，弹窗全是它）——想清用 `--drop`。
 * 刀口（`from`）一律抄源码里现成的那一段，别凭记忆写——凭记忆写的刀全部「刀口没找着」。
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeScratch, dropAllScratch, run, syncSrc, REPO } from './lib.mjs';
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

async function runSpec(spec, only, noBaseline) {
  // 号码集合筛刀；idx 一律用谱子里的原号（report 靠 r.idx 回查 spec.knives[idx-1]）
  const knives = spec.knives.map((k, i) => ({ k, idx: i + 1 })).filter((x) => !only || only.has(x.idx));
  const scratch = makeScratch(`knife-${spec.id}`);
  const rows = [];
  try {
    if (noBaseline) {
      // 只在「同一份源码刚验过绿」时用：基准红的话下面每把刀都会「没见红」，别拿它当常态
      console.log(`\n${spec.title}｜基准跳过（--no-baseline）`);
    } else {
      // 基准：这套谱子里要用的每一套闸，没动过刀都得是绿的，否则后面每一把刀都是白量
      const gates = [...new Set(knives.map((x) => gateOf(spec, x.k)))];
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
    }
    for (const x of knives) rows.push({ idx: x.idx, ...(await tryKnife(spec, x.k, scratch)) });
  } finally {
    // 副本留着复用（下一场开头 rsync --delete 盖平），不删——清理是 --drop 的活
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

/** --only 认三种写法：3 ／ 4,6 ／ 4-9（可混：4-6,9）→ 号码集合 */
function parseOnly(raw) {
  if (!raw) return null;
  const set = new Set();
  for (const part of raw.split(',')) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= b; i++) set.add(i);
    } else set.add(Number(part));
  }
  if (!set.size || [...set].some((n) => !Number.isInteger(n) || n < 1)) {
    console.error(`--only 认 3 ／ 4,6 ／ 4-9 这几种写法，收到的是：${raw}`);
    process.exit(2);
  }
  return set;
}

// ---------------- --affected：按当前改动挑刀谱（宁多勿漏） ----------------

/**
 * `package.json` 里每条 `test:*` 脚本的入口文件（套件名 → 仓库相对路径）。
 * 陷阱：别按文件名猜——`test:link` 走的是 `src/web/net.test.ts`、`test:ui` 走的是 `src/web/ui.test.ts`，
 * 两条都不在 `src/test/`。所以从脚本命令里抽末尾那个入口，而不是拼 `src/test/<name>.test.ts`。
 */
function suiteEntries() {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const map = new Map();
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    if (!name.startsWith('test:')) continue;
    const m = String(cmd).match(/(\S+\.(?:ts|mts|cts|js|mjs|cjs))\s*$/);
    if (m) map.set(name, m[1]);
  }
  return map;
}

/**
 * 从一份源码里抠出它引到的所有路径：`import`/`export ... from '...'`、裸 `import '...'`、
 * 动态 `import('...')`，以及 `readFileSync(new URL('...', import.meta.url))` 那种资源引用
 * （style.test.ts 读 style.css／app.ts／home.ts、desktop.test.ts 读 room.ts／launch.ts／main.ts／host.ts 全靠它）。
 */
function refsOf(text) {
  const out = [];
  for (const re of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  ])
    for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
}

/** 一条说明符落到仓库内的哪个文件（省后缀时逐个试）；`node:` 前缀与裸包名不进仓库闭包，返回 null */
function resolveRef(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const clean = spec.replace(/[?#].*$/, '');
  const p = posix.normalize(posix.join(posix.dirname(fromFile), clean));
  const tries = /\.[A-Za-z0-9]+$/.test(p) ? [p] : [p, `${p}.ts`, `${p}.mjs`, `${p}.js`, `${p}/index.ts`];
  for (const t of tries) if (existsSync(join(REPO, t))) return t;
  return null;
}

/** 一个入口文件的传递引用闭包（含入口自身）：递归展开 import，并把资源引用一并纳入 */
function closureOf(entryRel) {
  const seen = new Set();
  const stack = [entryRel];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let text;
    try {
      text = readFileSync(join(REPO, f), 'utf8');
    } catch {
      continue;
    }
    for (const spec of refsOf(text)) {
      const r = resolveRef(f, spec);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
  return seen;
}

/** `git --name-status` 两种列式：普通 M/A/D 是一列路径；R/C 是「旧 新」两列，两个都算 */
function nameStatus(args) {
  const set = new Set();
  for (const line of run('git', args, { cwd: REPO }).out.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if ((cols[0].startsWith('R') || cols[0].startsWith('C')) && cols.length >= 3) {
      set.add(cols[1]);
      set.add(cols[2]);
    } else if (cols[1]) set.add(cols[1]);
  }
  return set;
}

/** 当前改动：暂存＋未暂存＋未跟踪；`--changed` 直接给清单（测试用），`--base` 用三点 diff 再加工作区改动 */
function changedFiles(base, explicit) {
  if (explicit != null) return [...new Set(explicit.split(',').map((s) => s.trim()).filter(Boolean))];
  const set = new Set();
  if (base) for (const f of nameStatus(['diff', '--name-status', '-M', `${base}...HEAD`])) set.add(f);
  for (const f of nameStatus(['diff', 'HEAD', '--name-status', '-M'])) set.add(f);
  for (const line of run('git', ['ls-files', '--others', '--exclude-standard'], { cwd: REPO }).out.split('\n'))
    if (line.trim()) set.add(line.trim());
  return [...set];
}

/** 全局触发：构建/配置/工具链一改谁都可能受影响，一律全跑（tools/** 已含刀架自身） */
function isGlobal(f, entrySet) {
  if (/^(package\.json|tsconfig[^/]*\.json|vite\.config\.[cm]?ts|rules\.json)$/.test(f)) return true;
  if (f.startsWith('tools/')) return true;
  // 套件入口之外的测试文件：没有别的闭包认领它，只好全跑（入口本身由规则 B 认领）
  if (f.endsWith('.test.ts') && !entrySet.has(f)) return true;
  return false;
}

/**
 * 选刀并给每张谱子记命中理由：
 * A 精确（改的文件 == 某刀 rel）；B 套件闭包（改的文件在某个 test:* 入口的传递闭包内）；
 * C 全局（package.json／tsconfig／vite.config／rules.json／tools/**／非入口测试文件）；D 兜底（src/ desktop/ 下但 A/B 都没认领）。
 * 全部取并集，宁多勿漏。
 */
function selectAffected(specs, changed, entries) {
  const entrySet = new Set(entries.values());
  const suiteClosure = new Map();
  for (const [suite, entry] of entries) suiteClosure.set(suite, closureOf(entry));

  const byRel = new Map();
  const specSuites = new Map();
  for (const spec of specs) {
    const suites = new Set();
    if (spec.suite) suites.add(spec.suite);
    for (const k of spec.knives) {
      if (!byRel.has(k.rel)) byRel.set(k.rel, new Set());
      byRel.get(k.rel).add(spec);
      if (k.suite) suites.add(k.suite);
    }
    specSuites.set(spec, suites);
  }

  const reasons = new Map();
  const add = (spec, r) => {
    if (!reasons.has(spec)) reasons.set(spec, new Set());
    reasons.get(spec).add(r);
  };

  let global = false;
  const fallback = [];
  for (const f of changed) {
    if (isGlobal(f, entrySet)) {
      global = true;
      continue;
    }
    const relHit = byRel.get(f);
    const suitesWith = [...suiteClosure].filter(([, cl]) => cl.has(f)).map(([s]) => s);
    if (relHit) for (const spec of relHit) add(spec, `[rel:${f}]`);
    for (const suite of suitesWith)
      for (const spec of specs) if (specSuites.get(spec).has(suite)) add(spec, `[suite:${suite}]`);
    if (!relHit && !suitesWith.length && (f.startsWith('src/') || f.startsWith('desktop/'))) fallback.push(f);
  }

  // 全局或兜底都退到「全跑」；兜底另打告警让人工看一眼闭包是不是漏了
  if (global || fallback.length) for (const spec of specs) add(spec, global ? '[global]' : '[fallback]');
  return { selected: new Set(reasons.keys()), reasons, global, fallback, suiteClosure };
}

const only = parseOnly(argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? null);
const noBaseline = argv.includes('--no-baseline');
const verbose = argv.includes('--verbose');
// --affected 主开关；--changed/--base 是注入改动的入口，--list 只选不跑——三者都进这一档
const listOnly = argv.includes('--list');
const base = argv.find((a) => a.startsWith('--base='))?.slice('--base='.length) ?? null;
const changedArg = argv.find((a) => a.startsWith('--changed='))?.slice('--changed='.length) ?? null;
const affected = argv.includes('--affected') || listOnly || changedArg != null || base != null;

// --drop 是维护动作：不跑刀，把缓存的副本（含老版本 mkdtemp 留下的随机名残骸）一把清掉
if (argv.includes('--drop')) {
  const gone = dropAllScratch();
  console.log(gone.length ? `清了 ${gone.length} 份缓存副本：${gone.join('、')}` : '没有缓存的副本，不用清');
  process.exit(0);
}

// --print-closure=test:net：把某套闸入口的传递闭包打出来（抽查闭包实现用，不跑刀）
const closureArg = argv.find((a) => a.startsWith('--print-closure='))?.slice('--print-closure='.length);
if (closureArg) {
  const entries = suiteEntries();
  if (!entries.has(closureArg)) {
    console.error(`--print-closure 认的套件名来自 package.json 的 test:*，没有：${closureArg}`);
    process.exit(2);
  }
  const cl = [...closureOf(entries.get(closureArg))].sort();
  console.log(`${closureArg} 入口 ${entries.get(closureArg)} 的传递闭包（${cl.length} 个文件）：`);
  for (const f of cl) console.log(`  ${f}`);
  process.exit(0);
}

const wanted = argv.filter((a) => !a.startsWith('--'));
let files = readdirSync(KNIVES_DIR)
  .filter((f) => f.endsWith('.mjs'))
  .filter((f) => !wanted.length || wanted.includes(f.replace(/\.mjs$/, '')))
  .sort();
if (!files.length) {
  console.error(`没找到刀谱：${KNIVES_DIR}${wanted.length ? `（要 ${wanted.join('、')}）` : ''}`);
  process.exit(2);
}

// 先把刀谱读进来：--affected 要按每张谱子的 rel/suite 选，选完再决定跑哪几张
const loaded = [];
for (const f of files) loaded.push({ file: f, spec: (await import(pathToFileURL(join(KNIVES_DIR, f)).href)).default });
const allSpecs = loaded.map((x) => x.spec);
const totalKnives = allSpecs.reduce((n, s) => n + s.knives.length, 0);

// --affected：按当前改动挑出受影响的谱子（--changed/--base/--list 也进这一档）
if (affected) {
  const changed = changedFiles(base, changedArg);
  if (!changed.length) {
    console.log('工作区干净：没有改动，不用跑刀');
    process.exit(0);
  }
  const pick = selectAffected(allSpecs, changed, suiteEntries());
  console.log(`改动文件（${changed.length}）：\n  ${changed.join('\n  ')}`);
  if (pick.fallback.length)
    console.log(
      `\n⚠ 兜底：这些改动在 src/ desktop/ 下，但精确（rel）和套件闭包都没认领——闭包分析可能没覆盖到，人工看一眼：\n  ${pick.fallback.join('\n  ')}`,
    );
  // 只留被选中的谱子，并按 --only 数出真正会跑的刀数
  loaded.splice(0, loaded.length, ...loaded.filter((x) => pick.selected.has(x.spec)));
  files = loaded.map((x) => x.file);
  let knifeCount = 0;
  for (const { spec } of loaded) knifeCount += spec.knives.filter((_, i) => !only || only.has(i + 1)).length;
  if (pick.selected.size) {
    console.log('\n选中的刀谱：');
    for (const { file, spec } of loaded)
      console.log(`  ${file.replace(/\.mjs$/, '')}  ${[...(pick.reasons.get(spec) ?? [])].sort().join(' ')}`);
  } else {
    console.log('\n没有刀谱被这次改动波及——rel 和套件闭包都没命中，不用跑');
  }
  console.log(`\n选中 ${pick.selected.size}/${allSpecs.length} 张、${knifeCount}/${totalKnives} 把`);
  if (listOnly || !pick.selected.size) process.exit(0);
}

// 仓库干净不干净先记一笔：跑完一个字节都不该变（副本在临时目录里，动不到他家）
const dirtyBefore = run('git', ['status', '--porcelain'], { cwd: REPO }).out;
let problems = 0;
let beltReds = 0;
for (const { spec } of loaded) {
  const { abort, rows } = await runSpec(spec, only, noBaseline);
  if (abort) {
    console.log(`\n${spec.title}：${abort}`);
    problems++;
    continue;
  }
  console.log(`\n${spec.title}：每把刀只拆一处`);
  for (const r of rows) {
    console.log(report(spec, r, verbose));
    // belt 那档不参与「没见红」的账：它绿才是对的
    if (r.belt && !r.pass) beltReds++;
    // 红了的那几把另算：它说明那层冗余其实正在挡事，得搬回普通刀补 expect——不是成绩，也不能悄悄过去
    if (!r.missing && !r.belt && !r.pass) problems++;
  }
  problems += rows.filter((r) => r.missing).length;
}
const dirtyAfter = run('git', ['status', '--porcelain'], { cwd: REPO }).out;
const repoUntouched = dirtyBefore === dirtyAfter;
console.log(`\n${repoUntouched ? '仓库没动 ✓' : '仓库被动过 ✗'}  git status --porcelain 前后${repoUntouched ? '一致' : '不一致'}${repoUntouched ? '' : `\n前：${dirtyBefore}\n后：${dirtyAfter}`}`);
const total = files.length;
if (beltReds) console.log(`\n${beltReds} 把 belt 红了：那几层冗余其实正在挡事——照报告那句搬回普通刀补上 expect，别留在 belt 那一档`);
console.log(problems ? `\n${total} 张刀谱里 ${problems} 处没见红\n` : `\n${total} 张刀谱的刀都钉在了它要防的那句上${beltReds ? `（另有 ${beltReds} 把 belt 红了，见上）` : ''}，仓库一个字没动\n`);
process.exit(problems || beltReds || !repoUntouched ? 1 : 0);
