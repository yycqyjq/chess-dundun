/**
 * 布局守恒测试：layout() 是纯函数，牌落哪儿在 Node 里就能算清楚，
 * 不用等浏览器、也不会被后台标签页的定时器节流骗到。
 * 每次改锚点、间距、按钮条位置都跑一遍。
 */
import { apply, createGame, type GameState } from '../core/game.ts';
import { loadRules } from '../node/load_rules.ts';
import { bottomBand, ctrlLift, fanStep, handBand, handCramped, labelBand, labelBands, layout, pieceSize, stackSpots, type Board, type TableView } from '../web/board.ts';

let failures = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const rules = loadRules();

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Placed 的 x/y 是 cw 方框左上角，scale 绕中心缩，所以视觉框要往里收一圈 */
function boxes(state: GameState, view: TableView, board: Board): Map<number, Rect> {
  const cw = pieceSize(board);
  const out = new Map<number, Rect>();
  for (const [id, p] of layout(state, view, board)) {
    const w = cw * p.scale;
    out.set(id, { x: p.x + (cw - w) / 2, y: p.y + (cw - w) / 2, w, h: w });
  }
  return out;
}

const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 完全落在里面：领地要罩住整张牌，压一角不算 */
const inside = (a: Rect, b: Rect) => a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.w <= b.x + b.w + 1 && a.y + a.h <= b.y + b.h + 1;

function blankView(players: number): TableView {
  return {
    mine: 0,
    piles: Array.from({ length: players }, () => [] as number[]),
    sel: new Set(),
    hint: new Set(),
    justWon: new Set(),
    freeze: null,
    deal: false,
    holdDown: new Set(),
    peek: new Set(),
    hover: null,
    pick: null,
    lift: null,
    spread: false,
  };
}

/**
 * 手工摆一个出牌阶段的空桌。hands/piles 各家张数之和必须正好 32——
 * 只测真打得出来的分布（4 人局起手每人 8 枚，手里的只会变少、收进来的只会变多）。
 */
function midGame(players: number, seed: number, hands: number[], piles: number[]): { state: GameState; view: TableView } {
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  if (sum(hands) + sum(piles) !== 32) throw new Error(`这副局面不守恒：手 ${sum(hands)} + 摞 ${sum(piles)}`);
  const state = createGame({ rules, players, mode: 'kou', seed });
  const all = state.pieces.map((p) => p.id);
  state.draft = null;
  state.phase = 'kou';
  state.trick = null;
  let at = 0;
  const cut = (sizes: number[]): number[][] => sizes.map((n) => all.slice(at, (at += n)));
  state.hands = cut(hands);
  const view = blankView(players);
  view.piles = cut(piles);
  // 夹具自己先自检：同一张牌不该同时在手里和摞里，否则下面所有断言都在量同一个东西
  if (new Set([...state.hands.flat(), ...view.piles.flat()]).size !== 32) throw new Error('这副局面有重复牌');
  return { state, view };
}

const BOARDS: { name: string; board: Board }[] = [
  { name: '手机竖屏 390×844', board: { w: 374, h: 520 } },
  { name: '窄窗 558×668', board: { w: 542, h: 517 } },
  { name: '平板横屏 844×390', board: { w: 812, h: 325 } },
  { name: '桌面 1280×800', board: { w: 1264, h: 700 } },
  { name: '极窄 320×568', board: { w: 304, h: 430 } },
];

/** 真打得出来的分布：各家手牌 + 收牌摞 = 32 */
const CASES: Record<number, [number[], number[]][]> = {
  // 起手（谁都没收到）、中盘、你独吞一大摞、你出空了但别人还在打
  2: [
    [[16, 16], [0, 0]],
    [[8, 8], [8, 8]],
    [[4, 10], [12, 6]],
    [[0, 6], [26, 0]],
  ],
  4: [
    [[8, 8, 8, 8], [0, 0, 0, 0]],
    [[6, 6, 6, 6], [2, 2, 2, 2]],
    [[2, 4, 6, 6], [8, 2, 2, 2]],
    [[0, 8, 8, 8], [8, 0, 0, 0]],
    // P2 一家被处置人塞了一大摞：它的摞只能在左边那块地盘里挤，不许爬到 P3 或我头上来
    [[4, 4, 4, 0], [4, 12, 4, 0]],
    // 对面独吞 20 张：五组摞叠到第三排也封顶在自家那条边带里，剩下的原地挤边缝
    [[2, 2, 0, 0], [4, 4, 20, 0]],
  ],
};

console.log('\n收牌摞：各家贴自己那条边，互不压、也不压手牌和桌面');
for (const { name, board } of BOARDS) {
  for (const players of [2, 4]) {
    for (const [hands, piles] of CASES[players]!) {
      const { state, view } = midGame(players, 11, hands, piles);
      const box = boxes(state, view, board);
      const cw = pieceSize(board);
      const out = [...box.values()].filter((r) => r.x < -1 || r.y < -1 || r.x + r.w > board.w + 1 || r.y + r.h > board.h + 1);
      const seats = [...view.piles.keys()];
      let pileVsPile = 0;
      for (let i = 0; i < seats.length; i++) {
        for (let j = i + 1; j < seats.length; j++) {
          for (const a of view.piles[seats[i]!]!) for (const b of view.piles[seats[j]!]!) if (hits(box.get(a)!, box.get(b)!)) pileVsPile++;
        }
      }
      const held = state.hands.flat();
      const pileVsHand = view.piles.flat().reduce((n, id) => n + held.filter((h) => hits(box.get(id)!, box.get(h)!)).length, 0);
      ok(
        `${name}｜${players} 人 手 ${hands.join('/')} 摞 ${piles.join('/')}`,
        out.length === 0 && pileVsPile === 0 && pileVsHand === 0 && cw >= 20,
        `出界 ${out.length}｜摞压摞 ${pileVsPile}｜摞压手牌 ${pileVsHand}｜cw ${cw.toFixed(1)}`,
      );
    }
  }
}

console.log('\n名字条：谁的摞挨着谁的名字，pill 底下不许压着任何一张牌');
for (const { name, board } of BOARDS) {
  for (const players of [2, 4]) {
    for (const [hands, piles] of CASES[players]!) {
      const { state, view } = midGame(players, 11, hands, piles);
      const box = boxes(state, view, board);
      let covered = 0;
      // 不看「谁的牌」，看「桌上所有牌」：别家的摞爬过来压住名字条，一样是读不出归属
      for (const band of labelBands(players, board)) covered += [...box.values()].filter((r) => hits(r, band)).length;
      ok(
        `${name}｜${players} 人 手 ${hands.join('/')} 摞 ${piles.join('/')} 名字条下无牌`,
        covered === 0,
        `压住 ${covered} 张`,
      );
    }
  }
}

console.log('\n桌面那一墩不落在任何人的收牌摞上');
for (const { name, board } of BOARDS) {
  const { state, view } = midGame(4, 12, [6, 6, 6, 6], [2, 2, 2, 2]);
  const box = boxes(state, view, board);
  view.freeze = [0, 1, 2, 3].map((seat) => ({ seat, ids: state.hands[seat]!.slice(0, 2), pledge: false, best: false }));
  for (const p of view.freeze) state.hands[p.seat] = state.hands[p.seat]!.slice(p.ids.length);
  const on = boxes(state, view, board);
  const clash = view.freeze.reduce(
    (n, p) => n + p.ids.filter((id) => view.piles.flat().some((q) => hits(on.get(id)!, box.get(q)!))).length,
    0,
  );
  ok(`${name}｜四家各出两张，桌面和四摞互不重叠`, clash === 0, `压到 ${clash} 张`);
}

console.log('\n按钮条：浮在手牌扇形上方，不压牌也不出界');
for (const { name, board } of BOARDS) {
  const { state, view } = midGame(4, 13, [4, 4, 4, 4], [8, 4, 2, 2]);
  const box = boxes(state, view, board);
  // CSS 里 .ctrl{bottom: var(--ctrl-lift)}，那个变量就是 app.ts 从 ctrlLift() 写进去的同一个数
  // 窄屏三个分牌按钮必然折行，按两行量——它是贴底长的，往上顶的就是手牌
  for (const rows of [1, 2]) {
    const w = Math.min(320, board.w - 20);
    const h = rows * 40 + (rows - 1) * 6;
    const strip: Rect = { x: board.w / 2 - w / 2, y: board.h - ctrlLift(board) - h, w, h };
    const fanIds = state.hands[0]!;
    const overH = fanIds.filter((id) => hits(box.get(id)!, strip)).length;
    const overP = view.piles[0]!.filter((id) => hits(box.get(id)!, strip)).length;
    ok(
      `${name}｜按钮条 ${rows} 行 y=${strip.y.toFixed(0)} 不压手牌、不压你的摞`,
      overH === 0 && overP === 0 && strip.y > 0 && strip.x >= 0,
      `压手牌 ${overH}｜压摞 ${overP}`,
    );
  }
}

console.log('\n摸签：hover 那一摞必须整列摊开，牌与牌之间不遮挡、且全在自己那一摞的领地里');
for (const { name, board } of BOARDS) {
  const state = createGame({ rules, players: 4, mode: 'kou', seed: 14 });
  const view = blankView(4);
  const cw = pieceSize(board);
  const spots = stackSpots(board);
  let worst = Infinity;
  let out = 0;
  let escaped = 0;
  for (let i = 0; i < 8; i++) {
    view.hover = i;
    const box = boxes(state, view, board);
    const ids = state.draft!.stacks[i]!;
    const ys = ids.map((id) => box.get(id)!).sort((a, b) => a.y - b.y);
    for (let k = 1; k < ys.length; k++) worst = Math.min(worst, ys[k]!.y - ys[k - 1]!.y - cw);
    out += ys.filter((r) => r.x < -1 || r.y < -1 || r.x + r.w > board.w + 1 || r.y + r.h > board.h + 1).length;
    escaped += ys.filter((r) => !inside(r, spots[i]!)).length;
  }
  ok(
    `${name}｜8 摞逐个摊开：最小间距余量 ${worst.toFixed(1)}px，出界 ${out}，脱离领地 ${escaped}`,
    worst >= 0 && out === 0 && escaped === 0,
  );
}

console.log('\n抽出展示：点的那张就在自己那一格里放大——中心不飘、整桌只有它在放大、还在界内');
for (const { name, board } of BOARDS) {
  for (let i = 0; i < 8; i++) {
    // 摊开之后摞里每一张都是点击目标，四张都得各自演一遍「抽出」——只量摞口那张测不出「点的和亮的不是同一张」
    for (const slot of [0, 1, 2, 3]) {
      const state = createGame({ rules, players: 4, mode: 'kou', seed: 21 });
      const view = blankView(4);
      const target = state.draft!.stacks[i]![slot]!;
      apply(state, state.draft!.drawer, { kind: 'draw', stackIdx: i, pieceId: target });
      const drawn = state.draft!.drawn;
      view.hover = i;
      // 比的是「格子」而不是视觉框：放大绕中心长，视觉框本来就会往外涨一圈，那不是飘位
      const rest = layout(state, view, board);
      view.lift = drawn;
      const plan = layout(state, view, board);
      const box = boxes(state, view, board);
      const r = box.get(drawn)!;
      const was = rest.get(drawn)!;
      const out = r.x < -1 || r.y < -1 || r.x + r.w > board.w + 1 || r.y + r.h > board.h + 1;
      // 原地：竖向一格都不许动，横向最多为桌沿让 4px（最窄那档量出来 2.8px）。
      // 飘走就又回到老毛病——「我点的那张和翻过来展示的那张不是一个位置」
      const dx = Math.abs(was.x - plan.get(drawn)!.x);
      const dy = Math.abs(was.y - plan.get(drawn)!.y);
      const still = dy < 0.5 && dx <= 4;
      const only = plan.get(target)!.scale > 1 && [...plan.values()].filter((p) => p.scale > 1).length === 1;
      const top = [...plan.values()].every((p) => p.z <= plan.get(drawn)!.z);
      // 展示位上必须亮着（数点就靠这张），送回扣下时才翻回背面
      const shown = !plan.get(drawn)!.down;
      view.holdDown = new Set([drawn]);
      const covered = layout(state, view, board).get(drawn)!.down;
      // 放大这张还得留在自己那一摞的横坐标里，别爬到邻居家那摞上去
      const own = stackSpots(board)[i]!;
      const cx = r.x + r.w / 2;
      const under = cx >= own.x && cx <= own.x + own.w;
      // 摞口朝下：数组末尾那张必须停在整列最下面那格。
      // 整列上下是对称的，方向翻回去别的断言一条都不会红，所以这条必须单独守
      view.lift = null;
      view.holdDown = new Set();
      const col = boxes(state, view, board);
      const ids = state.draft!.stacks[i]!;
      const mouthY = col.get(ids[3])!.y;
      const lowestY = Math.max(...ids.map((id) => col.get(id)!.y));
      ok(
        `${name}｜第 ${i + 1} 摞第 ${slot + 1} 张抽出 y=${r.y.toFixed(0)}：原地=${still} 只它放大=${only} 摞口朝下=${Math.abs(mouthY - lowestY) < 0.5}`,
        !out && still && only && top && shown && covered && under && Math.abs(mouthY - lowestY) < 0.5,
        `出界 ${out} 飘位 dx=${dx.toFixed(1)}/dy=${dy.toFixed(1)} 只有它大 ${only} 最上 ${top} 亮 ${shown} 扣 ${covered} 在本摞横坐标 ${under} 摞口 y=${mouthY.toFixed(0)}/最下 ${lowestY.toFixed(0)}`,
      );
    }
  }
}

console.log('\n强调类：选中那张挂 pick、别家七摞每张挂 dim，摊开的这一摞自己不压暗（CSS 只认这几个名字）');
for (const { name, board } of BOARDS) {
  for (const [stage, setView] of [
    ['选中', (v: TableView, id: number, pile: number) => ((v.hover = pile), (v.pick = id))],
    ['抽出', (v: TableView, id: number, pile: number) => ((v.hover = pile), (v.lift = id))],
  ] as [string, (v: TableView, id: number, pile: number) => void][]) {
    for (let i = 0; i < 8; i += 3) {
      const state = createGame({ rules, players: 4, mode: 'kou', seed: 22 });
      const view = blankView(4);
      apply(state, state.draft!.drawer, { kind: 'draw', stackIdx: i });
      const drawn = state.draft!.drawn;
      setView(view, drawn, i);
      const plan = layout(state, view, board);
      const has = (c: string) => [...plan.values()].filter((p) => p.cls.split(' ').includes(c)).length;
      const self = plan.get(drawn)!;
      const thisPile = state.draft!.stacks[i]!;
      const dimmedOnes = thisPile.filter((id) => plan.get(id)!.cls.includes('dim')).length;
      // 别家那七摞全都得压暗，摊开的这一摞一张都不压；pick 只有「选中」那一拍才有
      const wantDim = plan.size - thisPile.length;
      const wantPick = stage === '选中' ? 1 : 0;
      ok(
        `${name}｜${stage} 第 ${i + 1} 摞：pick ${has('pick')}/dim ${has('dim')}`,
        has('pick') === wantPick && has('dim') === wantDim && dimmedOnes === 0 && !self.cls.includes('dim') && self.cls.includes('drawn'),
        `pick=${has('pick')} dim=${has('dim')}/${wantDim} 本摞被压=${dimmedOnes} 抽的那张=${self.cls}`,
      );
    }
  }
}

console.log('\n小手挂在牌上：没抽之前摞里每张都带 stack（CSS 靠它给 cursor），抽完这一签就摘掉');
for (const { name, board } of BOARDS) {
  const state = createGame({ rules, players: 4, mode: 'kou', seed: 23 });
  const view = blankView(4);
  const count = (plan: { cls: string }[]) => plan.filter((p) => p.cls.split(' ').includes('stack')).length;
  const before = count([...layout(state, view, board).values()]);
  apply(state, state.draft!.drawer, { kind: 'draw', stackIdx: 2 });
  const after = count([...layout(state, view, board).values()]);
  ok(`${name}｜stack：抽前 ${before}/32 张，抽完 ${after} 张`, before === 32 && after === 0);
}

console.log('\n认角：收牌摞和别家的手牌坨都落在自己那半边，别家的摞一张都不许进我底边那条带');
const CORNERS: [number, [number[], number[]][]][] = [
  [2, [[[8, 8], [8, 8]], [[4, 10], [12, 6]], [[0, 6], [26, 0]]]],
  [4, [[[6, 6, 6, 6], [2, 2, 2, 2]], [[2, 4, 6, 6], [8, 2, 2, 2]], [[0, 8, 8, 8], [8, 0, 0, 0]], [[4, 4, 4, 0], [4, 12, 4, 0]], [[2, 2, 0, 0], [4, 4, 20, 0]]]],
];
for (const { name, board } of BOARDS) {
  for (const [players, cases] of CORNERS) {
    for (const [hands, piles] of cases) {
      const { state, view } = midGame(players, 17, hands, piles);
      const box = boxes(state, view, board);
      let strayed = 0;
      view.piles.forEach((ids, seat) => {
        // 各家摞该在哪半边：你右下、P2 左边、P3 左上、P4 右上；2 人局只有右下和左上两角
        const right = seat === 0 || (players === 4 && seat === 3);
        for (const id of ids) {
          const r = box.get(id)!;
          if (right !== r.x + r.w / 2 > board.w / 2) strayed++;
          // 底边那一长条（名字条 + 一排摞）整个是你的地盘：别人家的摞爬进来就会被当成你的牌
          // （用户原话「这棋不能放在这个角上……看着还以为是我的呢」）。量的是整条带，不是只量名字条下面那一小截
          if (seat !== 0 && r.y + r.h > board.h - bottomBand(board) + 0.5) strayed++;
        }
      });
      // 4 人局里别家的手牌坨也一样：朝自己那半边偏，三家都压在中轴上就等于挤在桌心
      if (players === 4) {
        for (let seat = 1; seat < 4; seat++) {
          const right = seat === 3;
          const bottom = seat === 1;
          for (const id of state.hands[seat]!) {
            const r = box.get(id)!;
            const cx = r.x + r.w / 2;
            const cy = r.y + r.h / 2;
            if (right !== cx > board.w / 2 || bottom !== cy > board.h / 2) strayed++;
          }
        }
      }
      ok(`${name}｜${players} 人 摞 ${piles.join('/')} 全在自己那半边`, strayed === 0, `跨边 ${strayed} 张`);
    }
  }
}

console.log('\n归属：每家的摞紧贴自家名字条，谁收了这几张一眼读得出来');
for (const { name, board } of BOARDS) {
  for (const players of [2, 4]) {
    for (const [hands, piles] of CASES[players]!) {
      const { state, view } = midGame(players, 20, hands, piles);
      const box = boxes(state, view, board);
      const cw = pieceSize(board);
      let far = 0;
      let none = 0;
      for (const band of labelBands(players, board)) {
        const ids = view.piles[band.seat] ?? [];
        if (!ids.length) continue;
        // 挨着 = 这张牌到名字条矩形的空隙；超出一个牌宽就是爬到别家那边去了
        const nearest = Math.min(
          ...ids.map((id) => {
            const r = box.get(id)!;
            const dx = Math.max(band.x - (r.x + r.w), r.x - (band.x + band.w), 0);
            const dy = Math.max(band.y - (r.y + r.h), r.y - (band.y + band.h), 0);
            return Math.hypot(dx, dy);
          }),
        );
        if (nearest > cw) far++;
        none++;
      }
      ok(`${name}｜${players} 人 摞 ${piles.join('/')} 贴着名字条（${none} 家有名有牌）`, far === 0, `${far} 家的摞离名字超过一个牌宽`);
    }
  }
}

console.log('\n手牌摊开：每张各占一格、互不遮挡，还在自己那块地盘里（按钮条以上、名字条以上）');
for (const { name, board } of BOARDS) {
  for (const players of [2, 4]) {
    for (const [hands, piles] of CASES[players]!) {
      const { state, view } = midGame(players, 24, hands, piles);
      view.spread = true;
      const box = boxes(state, view, board);
      const ids = state.hands[0]!;
      const rs = ids.map((id) => box.get(id)!);
      // 每张都得点得着：摊开了还互相压着，就又回到「点的位置说不清是哪张」
      let overlap = 0;
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (hits(rs[i]!, rs[j]!)) overlap++;
      const out = rs.filter((r) => r.x < -1 || r.y < -1 || r.x + r.w > board.w + 1 || r.y + r.h > board.h + 1).length;
      const band = handBand(board);
      const escape = rs.filter((r) => r.y < band.top - 0.5 || r.y + r.h > band.bottom + 0.5).length;
      const onLabel = rs.reduce((n, r) => n + labelBands(players, board).filter((b) => hits(r, b)).length, 0);
      const onPile = rs.reduce((n, r) => n + view.piles.flat().filter((q) => hits(r, box.get(q)!)).length, 0);
      const scaled = [...layout(state, view, board).values()].filter((p) => p.cls.includes('spread')).length;
      ok(
        `${name}｜${players} 人 手 ${hands.join('/')} 摊开 ${ids.length} 张`,
        overlap === 0 && out === 0 && escape === 0 && onLabel === 0 && onPile === 0 && scaled === ids.length,
        `互压 ${overlap}｜出界 ${out}｜越界带 ${escape}｜压名字条 ${onLabel}｜压摞 ${onPile}｜spread 标记 ${scaled}/${ids.length}`,
      );
    }
  }
}

console.log('\n扇形最低点：坠到最低的那张牌不许压进底边那条名字条（收牌摞靠横向让位隔开，见上面那组）');
for (const { name, board } of BOARDS) {
  for (const [players, hands, piles] of [
    [2, [8, 8], [8, 8]],
    [2, [4, 10], [12, 6]],
    [4, [6, 6, 6, 6], [2, 2, 2, 2]],
    [4, [2, 4, 6, 6], [8, 2, 2, 2]],
  ] as [number, number[], number[]][]) {
    const { state, view } = midGame(players, 18, hands, piles);
    const box = boxes(state, view, board);
    const low = Math.max(...state.hands[0]!.map((id) => box.get(id)!.y + box.get(id)!.h));
    // 几何上这两条边是刻意对齐的（LABEL_GAP 就是那条缝），所以容半个像素的浮点噪声
    const limit = board.h - labelBand();
    ok(`${name}｜${players} 人 扇形最低 y=${low.toFixed(1)} ≤ ${limit.toFixed(1)}`, low <= limit + 0.5, `低了 ${(low - limit).toFixed(1)}px`);
  }
}

console.log('\n别家的手牌坨不压我的扇形（挪锚点最容易撞的就是这条）');
for (const { name, board } of BOARDS) {
  for (const [players, hands, piles] of [
    [2, [8, 8], [8, 8]],
    [2, [4, 10], [12, 6]],
    [4, [6, 6, 6, 6], [2, 2, 2, 2]],
    [4, [2, 4, 6, 6], [8, 2, 2, 2]],
    [4, [0, 8, 8, 8], [8, 0, 0, 0]],
  ] as [number, number[], number[]][]) {
    const { state, view } = midGame(players, 19, hands, piles);
    const box = boxes(state, view, board);
    const fan = state.hands[0]!.map((id) => box.get(id)!);
    let over = 0;
    for (let seat = 1; seat < players; seat++) {
      over += state.hands[seat]!.filter((id) => fan.some((r) => hits(box.get(id)!, r))).length;
    }
    ok(`${name}｜${players} 人 手 ${hands.join('/')} 别家的坨不压扇形`, over === 0, `压住 ${over} 张`);
  }
}

console.log('\n摊开不摊开：扇形本来就张得开的就别多要一下点击，挤成一条边的才要（用户口径：这种没必要点一下展开再选）');
{
  // 期望值写死成一张表，不重抄判定式（探针实测出来的依赖关系）：
  // 窄屏 8 张那三格跟着 CORNER_KEEP 走——让量从 2.4cw 砍到 1.2cw 就全翻成「直接点」；
  // 16 张怎么让都还是挤，钉在「先摊开」那头；桌面/横屏钉在扇形 0.84cw 的上限上，改让量也不动。
  // 两头各守一条不同的几何，改哪头这张表都会红。
  const want: Record<string, Record<number, boolean>> = {
    '手机竖屏 390×844': { 8: true, 16: true },
    '窄窗 558×668': { 8: true, 16: true },
    '平板横屏 844×390': { 8: false, 16: false },
    '桌面 1280×800': { 8: false, 16: false },
    '极窄 320×568': { 8: true, 16: true },
  };
  for (const { name, board } of BOARDS) {
    for (const n of [8, 16]) {
      const step = fanStep(n, board);
      const cramped = handCramped(n, board);
      ok(
        `${name}｜${n} 张 露 ${(step / pieceSize(board)).toFixed(2)}cw → ${cramped ? '先摊开' : '直接点'}`,
        cramped === want[name]![n],
        `期望 ${want[name]![n] ? '先摊开' : '直接点'}`,
      );
    }
    // 同一种屏上张数只会越叠越挤，不许 8 张要摊开、16 张反倒不用
    for (let n = 8; n < 16; n++) {
      ok(`${name}｜${n}→${n + 1} 张不会变松`, !handCramped(n, board) || handCramped(n + 1, board), `${n + 1} 张成了直接点`);
    }
  }
}

console.log(failures ? `\n${failures} 条不过` : '\n全部通过');
if (failures) process.exitCode = 1;
