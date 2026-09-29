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

// ---------- 首页那一层 ----------

console.log('\n首页：盖住屏幕的一层，两条入口竖着排，宽屏才并排');
{
  const home = at('.home')[0];
  ok('.home 有声明（不是漏了这一块）', !!home);
  ok('它是盖住整块屏幕的一层（fixed + inset 0）', val('.home', 'position') === 'fixed' && val('.home', 'inset') === '0');
  // 身后还立着打完那副牌面：背景透了就会隔着一层看见牌
  ok('背景不透明（认的是 --bg 那道渐变）', /var\(--bg\)/.test(val('.home', 'background') ?? ''), val('.home', 'background') ?? '‹没写›');
  ok('手机横屏装不下时能滚（overflow: auto）', val('.home', 'overflow') === 'auto');
  const zHome = Number(val('.home', 'z-index'));
  const zSheet = Number(val('.sheet', 'z-index'));
  ok('首页压在牌桌之上、任何卡之下', zHome > 0 && zSheet > zHome, `.home ${zHome}／.sheet ${zSheet}`);
  ok('首页自己不加常驻框线（.home 没声明 border）', val('.home', 'border') === undefined);

  const blocks = ['.home-title', '.home-brief', '.home-entries', '.home-foot'];
  for (const sel of blocks)
    ok(`${sel} 的宽度认的是 var(--card-w)`, /var\(--card-w\)/.test(val(sel, 'width') ?? ''), val(sel, 'width') ?? '‹没写›');
  for (const sel of blocks)
    ok(`${sel} 在宽屏那档换成 --card-w-wide`, /var\(--card-w-wide\)/.test(val(sel, 'width', WIDE) ?? ''), val(sel, 'width', WIDE) ?? '‹没写›');

  ok('两条入口默认竖着排', val('.home-entries', 'display') === 'flex' && val('.home-entries', 'flex-direction') === 'column');
  ok('横排只出现在宽屏那条 media 里', val('.home-entries', 'flex-direction', WIDE) === 'row' && val('.home-entries', 'flex-direction', '') === 'column');
  ok('宽屏两条等宽、装不下自己收（flex: 1 1 0 + min-width: 0）', val('.home-entry', 'flex', WIDE) === '1 1 0' && val('.home-entry', 'min-width', WIDE) === '0');

  // 整块就是那颗按钮：热区要明显大过卡片里那些小按钮
  const entryMin = Number.parseInt(val('.home-entry', 'min-height') ?? '0', 10);
  const btnMin = Number.parseInt(val('.btn', 'min-height') ?? '0', 10);
  ok(`入口那块比一般按钮高一大截（${entryMin}px 对 ${btnMin}px）`, entryMin >= 64 && entryMin > btnMin, `entry ${entryMin}／btn ${btnMin}`);
  ok('入口里的字靠左排（不是居中海报）', val('.home-entry', 'text-align') === 'left');
  ok('入口没自己把小手改回默认（cursor 交给 .btn）', val('.home-entry', 'cursor') === undefined);

  ok('提示和版本压到最底（margin-top: auto）', val('.home-foot', 'margin-top') === 'auto');
  // 版本号被省略号吃掉就等于没写，跟顶栏那句同一口径
  ok('版本那一行不截断（white-space: normal，也没写 ellipsis）', val('.home-foot .v', 'white-space') === 'normal' && (val('.home-foot .v', 'text-overflow') ?? 'none') === 'none');
}

// ---------- 同网桌只有列表页那一处（批10） ----------

console.log('\n同网桌只摆一处：候场厅里不留第二份');
{
  // 还是这一套路：app.ts 经 `rules.json?raw` 进不了 node 测试，那就测这份文件自己写了什么
  const app = readFileSync(new URL('../web/app.ts', import.meta.url), 'utf8');
  ok(
    '椅子那一列只收座位表和邀请，不挂同网桌容器',
    !/seatCol\.append\([^)]*peer/.test(app),
    (app.match(/^\s*seatCol\.append\(.*$/m) ?? ['‹找不到那一行›'])[0],
  );
  // 按这颗的人要的是「换张桌看看」，出口就是列表页那一个；候场厅里再摆一份是两处入口同一件事
  ok('整页没有那颗「找同网的桌」（同网桌的入口只剩列表页）', !app.includes('找同网的桌'));
  ok('CSS 里也没留那条没人使的 .peers', !RULES.some((r) => r.sel.includes('.peers')), RULES.filter((r) => r.sel.includes('.peers')).map((r) => r.sel).join('｜'));
  // 「只剩你一个」这一句得是数出来的活人，不是「我坐过椅子」；桌那头同一口径还有一道（见 net 那节的 disband）
  ok('那颗「退出这桌」认的是「只剩一个活人」', /this\.exitTable\(this\.seated && alive <= 1\)/.test(app), '‹没找到那句›');
  // 散桌递的是这一句，不是清账那句：递错了账归零、椅子却一把不动，人还坐在那张要散的桌上
  ok('确认那颗递的是 disband 那句', /send\(\{ t: 'disband' \}\)/.test(app), '‹没找到那句›');
}

console.log(failures ? `\n${failures} 条没过` : '\n全部通过');
process.exit(failures ? 1 : 0);
