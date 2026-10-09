/**
 * 布局守卫：style.css 是唯一一处定「手机上这些东西摆成什么样」的地方，而 app.ts 永远进不了 node 测试
 * （它经 rules.ts 拉了 `rules.json?raw`）。所以这里不测浏览器怎么画，测这份文件本身写了什么——
 * 钉底靠的是「滚的是 .sheet-body，不是 .sheet-card」，两栏靠的是那条 820 的 media，
 * 座位行不挤靠的是 .t 落在第二行。这几句一旦被人顺手改回去，这里就红。
 *
 * 只读文件，不碰 DOM，所以住在 src/test（node 那侧才有 @types/node）。
 */
import { readFileSync } from 'node:fs';

/** 读 src/web 下的一份源码：下面几节都是「app.ts／home.ts 里写了什么」的守卫，路径收在这一处 */
const web = (file: string): string => readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8');

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

const raw = web('style.css');
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
  // 宽屏那个 flex 容器里有三个孩子（置顶那句 ＋ 配置 ＋ 椅子）：置顶那句得独占整行，
  // 否则它按内容宽占最左一列、把两栏挤成两条（2026-10-09 宽屏实拍：配置与椅子竖着断行）
  ok('宽屏容器允许换行（置顶那句才能被顶到下一行）', val('.room .sheet-body', 'flex-wrap', WIDE) === 'wrap', val('.room .sheet-body', 'flex-wrap', WIDE) ?? '‹没写›');
  ok('两行靠上码（换行后多出的高度别被均分到行间，把两栏顶到半空）', val('.room .sheet-body', 'align-content', WIDE) === 'flex-start', val('.room .sheet-body', 'align-content', WIDE) ?? '‹没写›');
  ok('「置顶那句」宽屏独占整行（flex: 0 0 100%），不当第三列跟两栏抢宽度', val('.room .guide', 'flex', WIDE) === '0 0 100%', val('.room .guide', 'flex', WIDE) ?? '‹没写›');
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
  const app = web('app.ts');
  ok(
    '椅子那一列只收座位表和邀请，不挂同网桌容器',
    !/seatCol\.append\([^)]*peer/.test(app),
    (app.match(/^\s*seatCol\.append\(.*$/m) ?? ['‹找不到那一行›'])[0],
  );
  // 按这颗的人要的是「换张桌看看」，出口就是列表页那一个；候场厅里再摆一份是两处入口同一件事
  ok('整页没有那颗「找同网的桌」（同网桌的入口只剩列表页）', !app.includes('找同网的桌'));
  ok('CSS 里也没留那条没人使的 .peers', !RULES.some((r) => r.sel.includes('.peers')), RULES.filter((r) => r.sel.includes('.peers')).map((r) => r.sel).join('｜'));
  // 列表那一排是 .sheet-body（overflow: auto）的第一个孩子，而里头那颗地址按钮 40px 高、hover 还要抬起来：
  // 顶部不留空，抬起那一截连同上边框就被滚动区的上边缘切掉（他真机看到的「按钮掉了个顶」）。
  // 这里不写死 6px，量的是「让出的空够不够抬起那一截」——谁把抬起改大，这儿跟着要他补空。
  const lift = Math.abs(
    Number(
      (RULES.find((r) => r.sel === '.btn:not(.dim):not(:disabled):hover')?.decls.get('transform') ?? '').match(
        /translateY\((-?[\d.]+)px\)/,
      )?.[1] ?? '',
    ),
  );
  const padTop = Number((val('.peer-list', 'padding-top') ?? '0').replace('px', ''));
  ok(
    '列表那排让出的顶空，够地址按钮 hover 抬起那一截',
    Number.isFinite(lift) && lift > 0 && padTop > lift,
    `抬起 ${lift}｜让出 ${padTop}`,
  );
  // 一行两列时地址那颗被 auto 推到最右、情况那句缩在最左：一行里两个起点隔着一条空缝，就是「飘」。
  // 这里不写死那一列的写法，数的是列数——谁再添一列（auto 也好、定宽也好）当场红。
  const cols = (val('.peer-row', 'grid-template-columns') ?? '‹没写›').trim();
  const tracks = cols.replace(/\([^)]*\)/g, '').split(/\s+/).filter(Boolean).length;
  ok('同网桌那一行只有一列：地址那颗跟在情况下面，不隔着空缝对着最右', tracks === 1, `${cols}｜${tracks} 列`);
  ok('那一行的两排对齐到左边：共用左边缘那一根锚', val('.peer-row', 'justify-items') === 'start', val('.peer-row', 'justify-items') ?? '‹没写›');
  // 「只剩你一个」这一句得是数出来的活人，不是「我坐过椅子」；桌那头同一口径还有一道（见 net 那节的 disband）
  ok('那颗「返回」认的是「只剩一个活人」', /this\.exitTable\(this\.seated && alive <= 1\)/.test(app), '‹没找到那句›');
  // 散桌递的是这一句，不是清账那句：递错了账归零、椅子却一把不动，人还坐在那张要散的桌上
  ok('确认那颗递的是 disband 那句', /send\(\{ t: 'disband' \}\)/.test(app), '‹没找到那句›');
  // 「什么时候开口」那条判断住在 home.ts（hostJump，见 ui 那节）；这一句只钉调用点把顺序递对了：
  // 递反了就再没有闸——prev 变成这一份，永远 >= 0，头一份快照照样凭空念一句交接
  ok(
    '交接那句递的是「上一份→这一份」',
    /hostJump\(lastHost, l\.hostSeat\)/.test(app),
    (app.match(/^\s*if \(hostJump.*$/m) ?? ['‹没走 hostJump：那句判断又手写回 app.ts 了›'])[0],
  );
}

// ---------- App 外壳那一屏：联机改成手填桌地址，寻呼那条路不跟着进去 ----------

console.log('\nApp 外壳：这一头没有本机宿主，同网寻呼换成手填桌地址');
{
  const app = web('app.ts');
  const home = web('home.ts');
  // WebView 里 location.host 是设备自己（那儿没有同源的一张桌），UDP 也发不出去，所以联机那一屏整个换掉
  ok(
    '联机那一屏第一句就分岔：外壳里走手填地址，浏览器里照旧走同网列表',
    /if \(inAppShell\(\)\) \{\s*this\.showAddr\(\);\s*return;/.test(app),
    (app.match(/^\s*private showList\(\): void \{.*$/m) ?? ['‹找不到那一行›'])[0],
  );
  // 「读不出地址就别去连」这条判断得有闸，所以版面和判断都住在 home.ts；app.ts 只管挂上、连、走
  ok(
    '那一屏的版面和尺子都在 home.ts（没写回 app.ts）',
    /export function fillAddr/.test(home) && /export function normAddr/.test(home) && /fillAddr\(/.test(app) && !/function normAddr/.test(app),
  );
  // 外壳开不了桌（桌是 Node 那张），那颗按钮要是跟着抄进那一屏，人就多看见一颗按了没反应的
  const fillAt = home.indexOf('export function fillAddr');
  ok('手填那一屏没有「在这台机器开一桌」（外壳里开不了桌）', fillAt > 0 && !home.slice(fillAt).includes('在这台机器开一桌'), fillAt > 0 ? `‹那一屏的源码 ${home.length - fillAt} 字›` : '‹home.ts 里没有 fillAddr›');
  const addrAt = app.indexOf('private showAddr()');
  const addrBody = app.slice(addrAt, app.indexOf('private paintList'));
  ok('那一屏自己是一段（showAddr 在 paintList 前面），不是截了个空串就当绿', addrAt > 0 && addrBody.length > 200, `‹截了 ${addrBody.length} 字›`);
  ok('外壳那一屏不发寻呼那一句（没有本机宿主代跑）', !addrBody.includes('findNow()'));
  // 那是拇指要按、又要看得清的一格：矮过 44px 就成了「热区比操作对象小」的那类毛病
  ok(
    '桌地址那一格有拇指的高度（≥44px）',
    Number((val('.addr', 'min-height') ?? '0').replace('px', '')) >= 44,
    val('.addr', 'min-height') ?? '‹没写›',
  );
}

// ---------- 一屏一层：点入口换的是页面，不是盖在首页上的一张卡（批12） ----------

console.log('\n整屏页：三处出口同一份名字，身后不隔着半透黑底露出另一层');
{
  const app = web('app.ts');
  const home = web('home.ts');
  // 候场厅那一屏整屏盖着牌桌，掀开看见的其实是首页——这颗既然撒过谎就整个摘掉，不留第二种名字
  ok('那颗不再按「身后有没有牌桌」分两种名字', !/this\.shell \? '看牌桌'/.test(app) && /leave\.textContent = BACK;/.test(app));
  // 同一件事在一条链上换了三个名字（回首页／退出这桌／看牌桌），人就不知道哪一颗会把他从这桌上摘下来。
  // 后两颗分别住在 home.ts（App 外壳那一屏的版面在那儿）与关于页，所以这条数的是两份文件：漏掉哪一份都会有一屏自己改名字
  const backs = (app.match(/button\(\s*BACK,|textContent = BACK/g) ?? []).length + (home.match(/button\(\s*BACK,/g) ?? []).length;
  // 2026-10-09 关于页是第五屏、设置页是第六屏：出口照旧念同一份「返回」，两颗都在新增的断言里跟着数
  ok('每一屏那颗出口念的是同一份 BACK（app.ts 五屏＋home.ts 那一屏）', backs === 6, `${backs} 处`);
  // 标题从 home.ts 那份 ENTRY 拿：入口写的字和点进去那一屏顶上的字是同一份，改一处不会漂成两个名字
  ok(
    '两屏的标题就是首页那两块的字',
    /page\(this\.root, entryHead\('solo'\)\)/.test(app) &&
      /page\(this\.root, entryHead\('room'\)\)/.test(app) &&
      /head: '单机模式'/.test(home) &&
      /head: '联机模式'/.test(home),
  );
  ok('「摆一桌」那张弹窗卡没了（单机那一屏走整屏）', !/'摆一桌'/.test(app), '‹app.ts 里还写着那张卡›');
  // 单机那一屏不收种子那一排：开桌前它只是一个谁摇都摇得出来的随机数，摆在那儿等于多一道没人看得懂的题。
  // 种子该露脸的地方是打完以后那三处（状态栏／战报抬头／报错那句），这儿一条都不动。
  ok('单机那一屏没有「种子／重掷」那一排', !app.includes('重掷') && !/const dice = /.test(app), (app.match(/^\s*dice\.append\(.*$/m) ?? ['‹那一排已经收掉了›'])[0]);
  // 收掉那一排就得把那条 CSS 规则一起收：留着一条没人使的选择器，下一个人会当那一排还在
  ok(
    'CSS 里也没留那条没人使的 .sheet-row .note',
    !RULES.some((r) => r.sel.includes('.sheet-row .note')),
    RULES.filter((r) => r.sel.includes('.sheet-row .note')).map((r) => r.sel).join('｜'),
  );
  // 底栏只剩那一排：这一屏少了一排，主按钮跟着滚的地盘就更小了，别把它又塞回 body
  ok('单机那一屏的底栏就那一排（开桌加返回）', /foot\.append\(go\);/.test(app), (app.match(/^\s*foot\.append\(.*$/gm) ?? ['‹找不到那一行›']).join('｜'));
  // 六屏全走 page()：裸 card() 是那层半透黑底＋居中卡，也就是「叠在首页上」本身。批12 摘掉的就是它，
  // 所以这里钉的是「没人再拿它搭常驻的那一层」——一次性的是非题走 popup()，不在这条的范围里。
  // 第四屏是 App 外壳里那格手填桌地址（home.ts 的 fillAddr 把它挂在 page 上）；第五屏是关于页；
  // 第六屏是 2026-10-09 从关于里分出来的设置页（声音开关）。
  const pages = (app.match(/page\(this\.root/g) ?? []).length;
  ok('牌桌外那一层的六屏全走 page()，一处也没退回裸 card()', pages === 6 && !/[^.\w]card\(/.test(app), `page ${pages} 处｜裸 card ${/[^.\w]card\(/.test(app) ? '有' : '没'}`);
  // 整屏页的遮罩必须是不透明的：半透黑底是把「还有一层在身后」这件事说出来，而这一屏没有身后
  const bg = val('.sheet.as-page', 'background') ?? '‹没写›';
  ok('整屏页那层不透明（跟首页同一份渐变，不是 rgba）', bg.includes('radial-gradient') && !bg.includes('rgba'), bg);
  ok('整屏页撑满一屏：那道 88dvh 的顶不再掐着它', val('.sheet.as-page .sheet-card', 'max-height') === 'none');
  ok('整屏页跟着宽屏那一档放宽', /var\(--card-w-wide\)/.test(val('.sheet.as-page .sheet-card', 'width', WIDE) ?? ''), val('.sheet.as-page .sheet-card', 'width', WIDE) ?? '‹没写›');
  // 横轴也得自己管：place-items 一条管两个轴，只写 stretch 时水平跟着变成 start，
  // 而卡是定宽（--card-w）——定宽的东西 stretch 不动，浏览器就贴左摆，右边空一条，跟居中的首页对不上。
  const place = val('.sheet.as-page', 'place-items') ?? '‹没写›';
  ok('整屏页那一列横着居中（不贴左）', /\bcenter\b/.test(place), place);
  // 另一头也得居中，不然「两层都居中」这句只量了一半
  ok('首页那一列也居中：一进一出同一根轴，别跳', val('.home', 'align-items') === 'center', val('.home', 'align-items') ?? '‹没写›');
  // 反过来量才挡得住新东西：`.as-page` 只重写它自己写的那几条，基础层上没被重写的一律照旧生效。
  // 于是「整屏那一屏继承了什么」得一条条数得出来——以后谁往 `.sheet`／`.sheet-card` 上添一条描边、模糊、投影，
  // 这儿当场红：那一屏是页面，不是浮在首页上面的一张卡。
  const decl = (sel: string): string[] => [...(at(sel, '')[0]?.decls.keys() ?? [])].sort();
  const kept = (base: string, over: string): string[] => {
    const o = new Set(decl(over));
    return decl(base).filter((k) => !o.has(k));
  };
  const veilKept = kept('.sheet', '.sheet.as-page');
  ok('遮罩那层照旧生效的只有「铺满一屏」那四件（没有半透底、没有内边距）', veilKept.join('｜') === 'display｜inset｜position｜z-index', veilKept.join('｜') ?? '‹没找到那条›');
  const cardKept = kept('.sheet-card', '.sheet.as-page .sheet-card');
  ok('卡那层照旧生效的只有排版三件（边框、圆角、底色、投影都压掉了）', cardKept.join('｜') === 'display｜flex-direction｜overflow', cardKept.join('｜') ?? '‹没找到那条›');
  // 那一屏从此不透明白占满一屏，所以它跟另外两层谁压谁就不再是「看着顺便」：
  // 提示条输给它＝那一句话一个字都看不见；复盘那一格赢过它＝掀不开这一屏还挡在按钮上。
  // 首页夹在中间也是有事做的：它跟复盘那一格以前打平（都写 1900），靠 DOM 顺序才压住。
  const zToast = Number(val('.toast', 'z-index'));
  const zDrawer = Number(val('.drawer', 'z-index'));
  const zHome = Number(val('.home', 'z-index'));
  const zVeil = Number(val('.sheet', 'z-index'));
  ok('卡／整屏页之上只剩提示条那层，首页压在复盘之上（.drawer＜.home＜.sheet＜.toast）',
    zDrawer < zHome && zHome < zVeil && zVeil < zToast,
    `.drawer ${zDrawer}／.home ${zHome}／.sheet ${zVeil}／.toast ${zToast}`);
}

// ---------- 收牌扣着收：翻回背面那一拍排在「收进摞」前面（用户点名） ----------

console.log('\n收牌扣着收：翻回背面那一拍在收之前，不跟挪位挤在同一拍');
{
  // 还是这一套路：app.ts 经 `rules.json?raw` 进不了 node 测试，那就测这份文件自己写了什么
  const app = web('app.ts');
  // 翻开看一眼 → 翻回背面落定 → 再收进摞。少了中间那一拍，翻转就和挪位挤在同一拍里：
  // 牌在往摞里飞的半路变脸，看得清它落在哪一家（他原话：不是扣着收的，是边扣边收）
  const cover = app.indexOf('await this.nap(FLIP_COVER_MS)');
  const collect = app.indexOf('this.view.piles[winner]!.push(...ids)');
  ok(
    '翻回背面那一拍排在「收进摞」前面（不是边翻边收）',
    cover > 0 && collect > 0 && cover < collect && /this\.view\.holdDown = new Set\(ids\);/.test(app),
    `翻回 ${cover}｜收进摞 ${collect}`,
  );
  // 那一拍只该挂在扣棋那一路：明棋出牌即亮，收进摞本来就该亮着，没有「翻回背面」这一回事
  ok(
    '那一拍只挂在扣棋那一路（明棋收牌不翻回背面）',
    /if \(this\.state\.mode === 'kou'\) \{\s*this\.view\.holdDown = new Set\(ids\);/.test(app),
    (app.match(/^\s*if \(this\.state\.mode === 'kou'\) \{$/m) ?? ['‹没找到那句›'])[0],
  );
}

// ---------- 系列战绩：顶栏也念一份（用户点名：不是只有打完那一屏才知道） ----------

console.log('\n系列战绩：顶栏那行跟结算卡同源，一局没打完就整条藏掉');
{
  const app = web('app.ts');
  const local = web('local.ts');
  // 顶栏／结算卡／复盘原文三处念的必须是同一个函数：各抄一遍，改个口径（「冠」改「夺冠」）就漂成三种说法
  ok(
    '顶栏那行走的是 bookLine（不是又抄了一遍「累计 N 局」）',
    /this\.shell\.stand\.textContent = [^;]*bookLine\(/.test(app),
    (app.match(/^\s*this\.shell\.stand\.textContent = .*$/m) ?? ['‹没找到那句›'])[0],
  );
  ok(
    '结算卡那行也走同一个 bookLine（顶栏与结算卡同源）',
    /total\.textContent = bookLine\(/.test(app),
    (app.match(/^\s*total\.textContent = .*$/m) ?? ['‹没找到那句›'])[0],
  );
  ok(
    '那句文案本体只住在 local.ts 一处（app.ts 里没有第二份）',
    /`累计 \$\{book\.games\} 局/.test(local) && !/`累计 /.test(app),
    (app.match(/`累计 [^`]*`/) ?? ['‹app.ts 里没有第二份›'])[0],
  );
  // 一局都没打完时整条藏掉：宁可少一行，也不念一句「累计 0 局」占着顶栏
  ok(
    '一局没打完时整条藏掉（不念「累计 0 局」）',
    /this\.shell\.stand\.hidden = this\.book\.games === 0/.test(app),
    (app.match(/^\s*this\.shell\.stand\.hidden = .*$/m) ?? ['‹没找到那句›'])[0],
  );
  // 独占一行：不逼它换行就会跟右上角那三颗按钮挤同一行，按钮的位置跟着这行字数忽左忽右
  ok(
    '那行在顶栏独占一行（basis 100%，不跟按钮抢那一行）',
    (val('.stand', 'flex') ?? '').includes('100%'),
    val('.stand', 'flex') ?? '‹没写›',
  );
}

console.log(failures ? `\n${failures} 条没过` : '\n全部通过');
process.exit(failures ? 1 : 0);
