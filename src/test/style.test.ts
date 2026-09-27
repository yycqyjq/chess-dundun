/**
 * 布局守卫：style.css 是唯一一处定「手机上这些东西摆成什么样」的地方，而 app.ts 永远进不了 node 测试
 * （它经 rules.ts 拉了 `rules.json?raw`）。所以这里不测浏览器怎么画，测这份文件本身写了什么——
 * 钉底靠的是「滚的是 .sheet-body，不是 .sheet-card」，两栏靠的是那条 820 的 media，
 * 座位行不挤靠的是 .t 落在第二行。这几句一旦被人顺手改回去，这里就红。
 *
 * 只读文件，不碰 DOM，所以住在 src/test（node 那侧才有 @types/node）。
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

interface Rule {
  sel: string;
  decls: Map<string, string>;
  /** 这条规则裹在哪条 @media 条件里；不在任何 media 里就是空串 */
  media: string;
}

const raw = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
// 注释里那些「上一版是 min-width」之类的话是给读的人看的，别让它们混进断言
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

function parseBody(src: string, media: string, out: Rule[]): void {
  let i = 0;
  for (;;) {
    const open = src.indexOf('{', i);
    if (open < 0) return;
    const sel = src.slice(i, open).replace(/\s+/g, ' ').trim();
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    const body = src.slice(open + 1, j - 1);
    if (sel.startsWith('@media')) parseBody(body, sel.slice(6).trim(), out);
    else if (!sel.startsWith('@')) {
      const decls = new Map<string, string>();
      for (const line of body.split(';')) {
        const at = line.indexOf(':');
        if (at < 0) continue;
        const k = line.slice(0, at).trim();
        if (k) decls.set(k, line.slice(at + 1).trim());
      }
      // 一条规则挂着好几个选择器：挨个记，`.room .cfg-col, .room .seat-col` 那种得能单独查到
      for (const one of sel.split(',').map((x) => x.trim())) if (one) out.push({ sel: one, decls, media });
    }
    i = j;
  }
}

const RULES: Rule[] = [];
parseBody(css, '', RULES);
ok('这份 CSS 拆得开：条数对得上花括号', RULES.length > 60, `只有 ${RULES.length} 条`);

/** 某个选择器的那几条规则（可限定 media） */
const at = (sel: string, media?: string): Rule[] =>
  RULES.filter((r) => r.sel === sel && (media === undefined || r.media === media));
/** 这条规则里某个属性写成什么样（找不到就是 undefined） */
const val = (sel: string, prop: string, media?: string): string | undefined => {
  for (const r of at(sel, media)) if (r.decls.has(prop)) return r.decls.get(prop);
  return undefined;
};
// 宽屏那档的条件原文不写死：从文件里找出来，两条 media 万一改了数还能对上
const WIDE = RULES.find((r) => r.media.includes('820px') && r.sel === '.sheet-card')?.media ?? '‹找不到宽屏那条 media›';

// ---------- 常量收口 ----------

console.log('\n常量：卡片宽度和选项那一档只在一处定');
{
  const root = at(':root')[0];
  for (const token of ['--card-w', '--card-w-wide', '--seg-min', '--safe-b'])
    ok(`:root 里有 ${token}`, !!root?.decls.has(token));
  // 数值改了要连着改三处，就是下次布局乱掉的开始
  const outside = css.replace(/:root\s*\{[^}]*\}/, '');
  ok('440px 不在 :root 之外裸着写', !outside.includes('440px'));
  ok('96px 不在 :root 之外裸着写', !outside.includes('96px'));
  ok('.sheet-card 的宽度认的是 var(--card-w)', /var\(--card-w\)/.test(val('.sheet-card', 'width') ?? ''), val('.sheet-card', 'width') ?? '‹没写›');
  ok('宽屏那档认的是 var(--card-w-wide)', /var\(--card-w-wide\)/.test(val('.sheet-card', 'width', WIDE) ?? ''), val('.sheet-card', 'width', WIDE) ?? '‹没写›');
}

// ---------- 主按钮钉底 ----------

console.log('\n钉底：滚的是内容，不是整张卡');
{
  ok('卡片自己不滚（overflow: hidden）', val('.sheet-card', 'overflow') === 'hidden', val('.sheet-card', 'overflow') ?? '‹没写›');
  ok('卡片竖着排（flex-direction: column）', val('.sheet-card', 'display') === 'flex' && val('.sheet-card', 'flex-direction') === 'column');
  ok('内容那块才滚（.sheet-body: overflow: auto）', val('.sheet-body', 'overflow') === 'auto');
  ok('内容那块吃掉剩余高度（flex: 1 + min-height: 0）', val('.sheet-body', 'flex') === '1' && val('.sheet-body', 'min-height') === '0');
  ok('底栏不参与滚动（.sheet-foot 没写 overflow）', val('.sheet-foot', 'overflow') === undefined);
  // 手机上刘海/虚拟键那条缝：主按钮钉在底边，不给这段 padding 就会被系统条压住
  ok('底栏给安全区留了位置（padding-bottom: var(--safe-b)）', val('.sheet-foot', 'padding-bottom') === 'var(--safe-b)');
  ok('空的底栏不占缝（.sheet-foot:empty 收起来）', val('.sheet-foot:empty', 'display') === 'none');
  ok('空的底栏那一排也不占缝（.sheet-foot .sheet-row:empty）', val('.sheet-foot .sheet-row:empty', 'display') === 'none');
  ok('按得动的东西还是至少 40 高', val('.btn', 'min-height') === '40px');
}

// ---------- 手机单列、宽屏两栏 ----------

console.log('\n手机单列，宽屏才两栏');
{
  // 只在 media='' 那一档里查——不带第三个参数会把宽屏那条也读进来
  ok('默认没有把候场厅内容横着排（.room .sheet-body 不带 display）', val('.room .sheet-body', 'display', '') === undefined);
  ok('820 那条 media 里才横排', val('.room .sheet-body', 'display', WIDE) === 'flex');
  for (const col of ['.room .cfg-col', '.room .seat-col'])
    ok(`${col}：宽屏各占一半、且允许收缩`, val(col, 'flex', WIDE) === '1 1 0' && val(col, 'min-width', WIDE) === '0', `flex=${val(col, 'flex', WIDE)} min-width=${val(col, 'min-width', WIDE)}`);
  // 断点跟复盘那条对齐：两处各写一个数字，早晚会分叉
  const drawerWide = RULES.some((r) => r.media.includes('820px') && r.sel === '.drawer');
  ok('宽屏断点跟复盘那条用的是同一个数（820）', drawerWide && WIDE.includes('820px'), WIDE);
}

// ---------- 座位行不再挤压 ----------

console.log('\n座位行：谁＋什么状态两行，按钮独占右格');
{
  ok('.seat-row 是 grid', val('.seat-row', 'display') === 'grid');
  ok('左格能收缩（minmax(0, 1fr)），不被长状态句顶破', /minmax\(0,\s*1fr\)\s+auto/.test(val('.seat-row', 'grid-template-columns') ?? ''), val('.seat-row', 'grid-template-columns') ?? '‹没写›');
  ok('状态那句落在第二行', /^2\s*\/\s*1/.test(val('.seat-row .t', 'grid-area') ?? ''), val('.seat-row .t', 'grid-area') ?? '‹没写›');
  ok('名字落在第一行', /^1\s*\/\s*1/.test(val('.seat-row .who', 'grid-area') ?? ''));
  ok('按钮那一格跨两行（.seat-act）', /1\s*\/\s*2\s*\/\s*3/.test(val('.seat-act', 'grid-area') ?? ''), val('.seat-act', 'grid-area') ?? '‹没写›');
  ok('旧写法没留着：状态那句不再 flex: 1', val('.seat-row .t', 'flex') === undefined);
}

// ---------- 减法：重复声明、硬顶宽度、被裁的字 ----------

console.log('\n减法：同一件事只说一遍');
{
  const margins = RULES.filter((r) => /\.invite$/.test(r.sel) && r.decls.has('margin'));
  ok('.invite 的 margin 只声明一次', margins.length === 1, margins.map((m) => m.sel).join('｜'));
  ok('.seg-btn 认的是 flex-basis（能收缩），不是 min-width 硬顶', val('.seg-btn', 'flex') === '1 1 var(--seg-min)' && val('.seg-btn', 'min-width') === '0', `flex=${val('.seg-btn', 'flex')}`);
  ok('顶栏那行允许折行', val('.bar', 'flex-wrap') === 'wrap');
  // 省略号＝「第几局」「我是 P1」在手机上被吃掉，宁可多一行也别看不见
  ok('.meta 不再用省略号裁字', val('.meta', 'text-overflow') === undefined && val('.meta', 'white-space') !== 'nowrap', `white-space=${val('.meta', 'white-space')}`);
  ok('.meta 会自己折行', val('.meta', 'white-space') === 'normal');
  const hover = RULES.filter((r) => r.sel.includes(':hover') && r.sel.includes('.btn'));
  ok('触屏上不留赖着不散的浮起（.btn:hover 只在 hover: hover 里）', hover.length > 0 && hover.every((r) => r.media.includes('(hover: hover)')), hover.map((r) => `${r.media || '裸'}{${r.sel}}`).join('｜'));
}

// ---------- 牌桌那几条几何契约（别让 CSS 自己改回去） ----------

console.log('\n牌桌：几何还是 board.ts 说了算');
{
  // 名字条的宽度是几何量：CSS 自己改一个数，落点和留白就对不上了
  ok('名字条宽度认的是 --label-w（app.ts 按 LABEL_W 写进来）', /var\(--label-w/.test(val('.chip', 'max-width') ?? ''), val('.chip', 'max-width') ?? '‹没写›');
  ok('操作条还是浮在桌面里（.ctrl position: absolute）', val('.ctrl', 'position') === 'absolute');
  ok('操作条离底边那一档由 --ctrl-lift 定', /var\(--ctrl-lift/.test(val('.ctrl', 'bottom') ?? ''));
}

console.log(failures ? `\n${failures} 条没过` : '\n全部通过');
process.exit(failures ? 1 : 0);
