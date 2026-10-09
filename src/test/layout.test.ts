/**
 * 布局守恒测试：layout() 是纯函数，牌落哪儿在 Node 里就能算清楚，
 * 不用等浏览器、也不会被后台标签页的定时器节流骗到。
 * 每次改锚点、间距、按钮条位置都跑一遍。
 */
import { apply, createGame, rulesFor, type GameState } from '../core/game.ts';
import { buildPieceSet } from '../core/pieces.ts';
import { loadRules } from '../node/load_rules.ts';
import { bottomBand, ctrlLift, draftShape, fanStep, handBand, handCramped, handSpread, labelBand, labelBands, LABEL_X, layout, maxStacks, PILE_SIZE, pieceSize, stackSpots, type Board, type TableView } from '../web/board.ts';

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
 * 手工摆一个出牌阶段的空桌。hands/piles 各家张数之和必须正好这一档的整副牌——
 * 只测真打得出来的分布（起手每人 32/家 枚，手里的只会变少、收进来的只会变多）。
 */
function midGame(players: number, seed: number, hands: number[], piles: number[]): { state: GameState; view: TableView } {
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const deck = deckOf(players);
  if (sum(hands) + sum(piles) !== deck) throw new Error(`这副局面不守恒：手 ${sum(hands)} + 摞 ${sum(piles)}，应为 ${deck}`);
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
  if (new Set([...state.hands.flat(), ...view.piles.flat()]).size !== deck) throw new Error('这副局面有重复牌');
  return { state, view };
}

const BOARDS: { name: string; board: Board }[] = [
  { name: '手机竖屏 390×844', board: { w: 374, h: 520, stacks: 8, layers: 4 } },
  // 16 张摊开在这块尺寸上最容易出事：竖着只塞得下 1.3 张牌，原来只看横向够不够，最上那排就爬到按钮条上了
  { name: '大屏手机竖屏 598×844', board: { w: 580, h: 707, stacks: 8, layers: 4 } },
  { name: '窄窗 558×668', board: { w: 542, h: 517, stacks: 8, layers: 4 } },
  { name: '平板横屏 844×390', board: { w: 812, h: 325, stacks: 8, layers: 4 } },
  { name: '桌面 1280×800', board: { w: 1264, h: 700, stacks: 8, layers: 4 } },
  { name: '极窄 320×568', board: { w: 304, h: 430, stacks: 8, layers: 4 } },
];

/**
 * 这一档摆几摞、一摞几张：从规则表自己算，不读 board.ts 那份 `draftShape`——
 * 拿被测代码当尺子就量不出差别（这条口径在 band 那组里已经踩过一次）。
 */
function shapeOf(players: number): { stacks: number; layers: number } {
  const r = rulesFor(rules, players);
  const layers = r.draft.stackSize;
  return { stacks: Math.ceil(buildPieceSet(r.ranks).length / layers), layers };
}

/** 整副牌在这一档有几枚：3 人档减了两枚兵卒，是 30，不是基础档那份 32 */
const deckOf = (players: number) => buildPieceSet(rulesFor(rules, players).ranks).length;

/** 同一块桌面换个档位：牌径随摞数变（10 摞比 8 摞挤），所以几何要按这一档自己那份量 */
const deskOf = (rect: { w: number; h: number }, players: number): Board => ({ ...rect, ...shapeOf(players) });

console.log('\n摞的形：摆摞那一排的块数和层数由规则表给，2、4 人 8 摞 × 4，3 人 10 摞 × 3');
for (const players of [2, 3, 4]) {
  const { stacks, layers } = shapeOf(players);
  ok(
    `${players} 人档：${deckOf(players)} 枚正好摆满 ${stacks} 摞 × ${layers} 张，一张不落`,
    stacks * layers === deckOf(players) && deckOf(players) % players === 0,
    `${stacks} × ${layers} = ${stacks * layers}，牌堆 ${deckOf(players)}`,
  );
  ok(
    `board.ts 自己算的那份形和规则表一致（${players} 人 ${stacks} 摞）`,
    draftShape(createGame({ rules, players, mode: 'ming', seed: 3 })).stacks === stacks &&
      draftShape(createGame({ rules, players, mode: 'ming', seed: 3 })).layers === layers,
  );
}
ok('壳子按最坏那一排搭：maxStacks 量出来就是 3 人档那 10 块', maxStacks(rules) === 10, String(maxStacks(rules)));

/** 真打得出来的分布：各家手牌 + 收牌摞 = 这一档的整副牌 */
const CASES: Record<number, [number[], number[]][]> = {
  // 起手（谁都没收到）、中盘、你独吞一大摞、你出空了但别人还在打
  2: [
    [[16, 16], [0, 0]],
    [[8, 8], [8, 8]],
    [[4, 10], [12, 6]],
    [[0, 6], [26, 0]],
    // 一家独吞整副：八组摞，每组都得各占一格
    [[0, 0], [32, 0]],
  ],
  3: [
    [[10, 10, 10], [0, 0, 0]],
    [[8, 8, 8], [2, 2, 2]],
    [[4, 6, 8], [4, 4, 4]],
    [[0, 10, 10], [10, 0, 0]],
    // 第三家被塞了一大摞（12 张＝4 组）：它的摞只能在对面那条边里排，不许爬到别人或我头上来
    [[2, 2, 6], [4, 4, 12]],
    // 整副都在我这条边：10 组摞，每组都得各占一格
    [[0, 0, 0], [30, 0, 0]],
    // 左边那家（相对座位 1）独吞 18 张（6 组）：一排得排在自己那半截地盘里
    [[4, 4, 4], [0, 18, 0]],
  ],
  4: [
    [[8, 8, 8, 8], [0, 0, 0, 0]],
    [[6, 6, 6, 6], [2, 2, 2, 2]],
    [[2, 4, 6, 6], [8, 2, 2, 2]],
    [[0, 8, 8, 8], [8, 0, 0, 0]],
    // P2 一家被处置人塞了一大摞：它的摞只能在左边那块地盘里挤，不许爬到 P3 或我头上来
    [[4, 4, 4, 0], [4, 12, 4, 0]],
    // 对面独吞 20 张：五组起地盘里原本的格子就不够分，得缩牌加排而不是叠罗汉
    [[2, 2, 0, 0], [4, 4, 20, 0]],
    // 你独吞 28 张（七组）、P2 独吞 28 张（沿左边那条边排）
    [[0, 0, 4, 0], [28, 0, 0, 0]],
    [[4, 0, 0, 0], [0, 28, 0, 0]],
  ],
};

console.log('\n收牌摞：各家贴自己那条边，互不压、也不压手牌和桌面');
for (const { name, board: rect } of BOARDS) {
  for (const players of [2, 3, 4]) {
    // 牌径跟着档位那份摞数走（3 人 10 摞比 8 摞挤），同一块桌面得换成这一档自己的那张
    const board = deskOf(rect, players);
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

console.log('\n收牌扣着收：扣棋的摞一律背面——翻开的牌收进去也不许亮着（用户点名）');
for (const { name, board: rect } of BOARDS) {
  for (const players of [2, 3, 4]) {
    const board = deskOf(rect, players);
    for (const [hands, piles] of CASES[players]!) {
      if (!piles.some((n) => n > 0)) continue;
      const { state, view } = midGame(players, 24, hands, piles);
      // 一墩打完引擎把整墩塞进 revealed（就是翻开那一下）；收进摞的正是这一批，
      // 所以这里必须把摞里的牌全标成「翻开过」——不标的话这条断言量的是空集，绿得没意义
      for (const id of view.piles.flat()) state.revealed.add(id);
      const plan = layout(state, view, board);
      const ids = view.piles.flat();
      const up = ids.filter((id) => !plan.get(id)!.down);
      ok(`${name}｜${players} 人 摞 ${piles.join('/')} 全扣着`, up.length === 0, `摞里 ${ids.length} 张、亮着 ${up.length}`);
    }
  }
}

// 反过来量一手：明棋出牌即亮，收进摞本来就该亮着——「扣着收」只该管扣棋那一路，别顺手把明棋也扣了
{
  const { state, view } = midGame(2, 24, [2, 2], [14, 14]);
  state.mode = 'ming';
  for (const id of view.piles[0]!) state.revealed.add(id);
  const plan = layout(state, view, deskOf(BOARDS[0]!.board, 2));
  const dark = view.piles[0]!.filter((id) => plan.get(id)!.down);
  ok('明棋收牌不跟着翻回背面：翻开过的牌收进摞还是亮着', dark.length === 0, `${dark.length} 张被扣了`);
}

console.log('\n同一家的组与组：四张一墩算一格（这是显示用的码法，三家四家都一样），超过地盘里那四格就缩牌加排，一张都不许叠在另一组上');
for (const { name, board: rect } of BOARDS) {
  for (const players of [2, 3, 4]) {
    const board = deskOf(rect, players);
    for (const [hands, piles] of CASES[players]!) {
      const { state, view } = midGame(players, 11, hands, piles);
      const box = boxes(state, view, board);
      let stacked = 0;
      let groups = 0;
      for (const ids of view.piles) {
        groups = Math.max(groups, Math.ceil(ids.length / PILE_SIZE));
        // 同组内四张本来就互相压着（那就是一摞），要守的是组与组的边界
        for (let a = 0; a < ids.length; a++) {
          for (let b = a + 1; b < ids.length; b++) {
            if (Math.floor(a / PILE_SIZE) === Math.floor(b / PILE_SIZE)) continue;
            if (hits(box.get(ids[a]!)!, box.get(ids[b]!)!)) stacked++;
          }
        }
      }
      ok(`${name}｜${players} 人 摞 ${piles.join('/')} 组组分开（最多 ${groups} 组）`, stacked === 0, `${stacked} 对压在一起`);
    }
  }
}

console.log('\n名字条：谁的摞挨着谁的名字，pill 底下不许压着任何一张牌');
for (const { name, board: rect } of BOARDS) {
  for (const players of [2, 3, 4]) {
    const board = deskOf(rect, players);
    for (const [hands, piles] of CASES[players]!) {
      const { state, view } = midGame(players, 11, hands, piles);
      const box = boxes(state, view, board);
      let covered = 0;
      // 不看「谁的牌」，看「桌上所有牌」：别家的摞爬过来压住名字条，一样是读不出归属
      for (const band of labelBands(players, board, view.mine)) covered += [...box.values()].filter((r) => hits(r, band)).length;
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
for (const { name, board: rect } of BOARDS) {
  for (const players of [4, 3]) {
    // 这一档摆几摞、一摞几张都从规则表来：3 人是 10 摞 × 3，写死 8／4 就永远量不到那一档
    const board = deskOf(rect, players);
    const { stacks, layers } = shapeOf(players);
    const state = createGame({ rules, players, mode: 'kou', seed: 14 });
    const view = blankView(players);
    const cw = pieceSize(board);
    const spots = stackSpots(board);
    let worst = Infinity;
    let out = 0;
    let escaped = 0;
    for (let i = 0; i < stacks; i++) {
      view.hover = i;
      const box = boxes(state, view, board);
      const ids = state.draft!.stacks[i]!;
      const ys = ids.map((id) => box.get(id)!).sort((a, b) => a.y - b.y);
      for (let k = 1; k < ys.length; k++) worst = Math.min(worst, ys[k]!.y - ys[k - 1]!.y - cw);
      out += ys.filter((r) => r.x < -1 || r.y < -1 || r.x + r.w > board.w + 1 || r.y + r.h > board.h + 1).length;
      escaped += ys.filter((r) => !inside(r, spots[i]!)).length;
    }
    ok(
      `${name}｜${players} 人 ${stacks} 摞 × ${layers} 逐个摊开：最小间距余量 ${worst.toFixed(1)}px，出界 ${out}，脱离领地 ${escaped}`,
      worst >= 0 && out === 0 && escaped === 0,
    );
  }
}

console.log('\n抽出展示：点的那张就在自己那一格里放大——中心不飘、整桌只有它在放大、还在界内');
for (const { name, board: rect } of BOARDS) {
  for (const players of [4, 3]) {
    const board = deskOf(rect, players);
    const { stacks, layers } = shapeOf(players);
    for (let i = 0; i < stacks; i++) {
      // 摊开之后摞里每一张都是点击目标，几张都得各自演一遍「抽出」——只量摞口那张测不出「点的和亮的不是同一张」
      for (const slot of Array.from({ length: layers }, (_, k) => k)) {
        const state = createGame({ rules, players, mode: 'kou', seed: 21 });
        const view = blankView(players);
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
        const mouthY = col.get(ids[layers - 1])!.y;
        const lowestY = Math.max(...ids.map((id) => col.get(id)!.y));
        ok(
          `${name}｜${players} 人 第 ${i + 1} 摞第 ${slot + 1} 张抽出 y=${r.y.toFixed(0)}：原地=${still} 只它放大=${only} 摞口朝下=${Math.abs(mouthY - lowestY) < 0.5}`,
          !out && still && only && top && shown && covered && under && Math.abs(mouthY - lowestY) < 0.5,
          `出界 ${out} 飘位 dx=${dx.toFixed(1)}/dy=${dy.toFixed(1)} 只有它大 ${only} 最上 ${top} 亮 ${shown} 扣 ${covered} 在本摞横坐标 ${under} 摞口 y=${mouthY.toFixed(0)}/最下 ${lowestY.toFixed(0)}`,
        );
      }
    }
  }
}

console.log('\n强调类：选中那张挂 pick、别家其余几摞每张挂 dim，摊开的这一摞自己不压暗（CSS 只认这几个名字）');
for (const { name, board: rect } of BOARDS) {
  for (const players of [4, 3]) {
    const board = deskOf(rect, players);
    const { stacks } = shapeOf(players);
    for (const [stage, setView] of [
      ['选中', (v: TableView, id: number, pile: number) => ((v.hover = pile), (v.pick = id))],
      ['抽出', (v: TableView, id: number, pile: number) => ((v.hover = pile), (v.lift = id))],
    ] as [string, (v: TableView, id: number, pile: number) => void][]) {
      for (let i = 0; i < stacks; i += 3) {
        const state = createGame({ rules, players, mode: 'kou', seed: 22 });
        const view = blankView(players);
        apply(state, state.draft!.drawer, { kind: 'draw', stackIdx: i });
        const drawn = state.draft!.drawn;
        setView(view, drawn, i);
        const plan = layout(state, view, board);
        const has = (c: string) => [...plan.values()].filter((p) => p.cls.split(' ').includes(c)).length;
        const self = plan.get(drawn)!;
        const thisPile = state.draft!.stacks[i]!;
        const dimmedOnes = thisPile.filter((id) => plan.get(id)!.cls.includes('dim')).length;
        // 别家那几摞全都得压暗，摊开的这一摞一张都不压；pick 只有「选中」那一拍才有
        const wantDim = plan.size - thisPile.length;
        const wantPick = stage === '选中' ? 1 : 0;
        ok(
          `${name}｜${players} 人 ${stage} 第 ${i + 1} 摞：pick ${has('pick')}/dim ${has('dim')}`,
          has('pick') === wantPick && has('dim') === wantDim && dimmedOnes === 0 && !self.cls.includes('dim') && self.cls.includes('drawn'),
          `pick=${has('pick')} dim=${has('dim')}/${wantDim} 本摞被压=${dimmedOnes} 抽的那张=${self.cls}`,
        );
      }
    }
  }
}

console.log('\n小手挂在牌上：没抽之前摞里每张都带 stack（CSS 靠它给 cursor），抽完这一签就摘掉');
for (const { name, board: rect } of BOARDS) {
  for (const players of [4, 3]) {
    const board = deskOf(rect, players);
    const state = createGame({ rules, players, mode: 'kou', seed: 23 });
    const view = blankView(players);
    const count = (plan: { cls: string }[]) => plan.filter((p) => p.cls.split(' ').includes('stack')).length;
    const before = count([...layout(state, view, board).values()]);
    apply(state, state.draft!.drawer, { kind: 'draw', stackIdx: 2 });
    const after = count([...layout(state, view, board).values()]);
    ok(`${name}｜${players} 人 stack：抽前 ${before}/${deckOf(players)} 张，抽完 ${after} 张`, before === deckOf(players) && after === 0);
  }
}

console.log('\n认角：收牌摞和别家的手牌坨都落在自己那半边，别家的摞一张都不许进我底边那条带');
const CORNERS: [number, [number[], number[]][]][] = [
  [2, [[[8, 8], [8, 8]], [[4, 10], [12, 6]], [[0, 6], [26, 0]]]],
  [3, [[[8, 8, 8], [2, 2, 2]], [[2, 2, 6], [4, 4, 12]], [[0, 0, 0], [30, 0, 0]], [[4, 4, 4], [0, 18, 0]]]],
  [4, [[[6, 6, 6, 6], [2, 2, 2, 2]], [[2, 4, 6, 6], [8, 2, 2, 2]], [[0, 8, 8, 8], [8, 0, 0, 0]], [[4, 4, 4, 0], [4, 12, 4, 0]], [[2, 2, 0, 0], [4, 4, 20, 0]]]],
];
for (const { name, board: rect } of BOARDS) {
  for (const [players, cases] of CORNERS) {
    const board = deskOf(rect, players);
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
for (const { name, board: rect } of BOARDS) {
  for (const players of [2, 3, 4]) {
    const board = deskOf(rect, players);
    for (const [hands, piles] of CASES[players]!) {
      const { state, view } = midGame(players, 20, hands, piles);
      const box = boxes(state, view, board);
      const cw = pieceSize(board);
      let far = 0;
      let none = 0;
      for (const band of labelBands(players, board, view.mine)) {
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

console.log('\n名字条钉哪一头：跟着自家那摞在同一侧，钉的那一头还得贴到桌边那条内缩上');
{
  // app.ts 那句内联样式（left/right 照 band.edge 写）进不了 node 测试，这儿钉两份等价的：
  // ① edge 说的半边＝自家那摞真的所在那半边；② 钉的那一头离桌边正好 LABEL_X。
  // 任一被改回去，条就会飘在桌心那一侧（截图里「对面的条跑我这儿来了」有一半是这个）
  const FULL: Record<number, [number[], number[]]> = {
    2: [[8, 8], [8, 8]],
    3: [[6, 6, 6], [4, 4, 4]],
    4: [[4, 4, 4, 4], [4, 4, 4, 4]],
  };
  for (const { name, board: rect } of BOARDS) {
    for (const players of [2, 3, 4]) {
      const board = deskOf(rect, players);
      const [hands, piles] = FULL[players]!;
      for (let mine = 0; mine < players; mine++) {
        const { state, view } = midGame(players, 20, hands, piles);
        view.mine = mine;
        const box = boxes(state, view, board);
        let side = 0;
        let inset = 0;
        for (const band of labelBands(players, board, mine)) {
          const ids = view.piles[band.seat] ?? [];
          const cx = ids.reduce((s, id) => {
            const r = box.get(id)!;
            return s + r.x + r.w / 2;
          }, 0) / ids.length;
          if ((cx > board.w / 2) !== (band.edge === 'right')) side++;
          const at = band.edge === 'left' ? band.x : board.w - band.x - band.w;
          if (Math.abs(at - LABEL_X) > 0.01) inset++;
        }
        ok(
          `${name}｜${players} 人 我坐 P${mine + 1} 每条名字条和自家那摞同侧`,
          side === 0,
          `${side} 条钉反了半边`,
        );
        ok(
          `${name}｜${players} 人 我坐 P${mine + 1} 钉的那头离桌边 ${LABEL_X} 像素`,
          inset === 0,
          `${inset} 条没贴角`,
        );
      }
    }
  }
}

console.log('\n手牌摊开：每张各占一格、互不遮挡，还在自己那块地盘里（按钮条以下、名字条以上）');
for (const { name, board: rect } of BOARDS) {
  for (const players of [2, 3, 4]) {
    const board = deskOf(rect, players);
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
      // 按钮条那块矩形自己量一遍：band 算错了（把条的底边当成顶边）只有这条会红
      const ctrl = [1, 2].map((rows) => {
        const w = Math.min(320, board.w - 20);
        const h = rows * 40 + (rows - 1) * 6;
        return { x: board.w / 2 - w / 2, y: board.h - ctrlLift(board) - h, w, h } as Rect;
      });
      const onCtrl = rs.reduce((n, r) => n + ctrl.filter((b) => hits(r, b)).length, 0);
      const onLabel = rs.reduce((n, r) => n + labelBands(players, board, view.mine).filter((b) => hits(r, b)).length, 0);
      const onPile = rs.reduce((n, r) => n + view.piles.flat().filter((q) => hits(r, box.get(q)!)).length, 0);
      const scaled = [...layout(state, view, board).values()].filter((p) => p.cls.includes('spread')).length;
      ok(
        `${name}｜${players} 人 手 ${hands.join('/')} 摊开 ${ids.length} 张`,
        overlap === 0 && out === 0 && escape === 0 && onCtrl === 0 && onLabel === 0 && onPile === 0 && scaled === ids.length,
        `互压 ${overlap}｜出界 ${out}｜越界带 ${escape}｜压按钮条 ${onCtrl}｜压名字条 ${onLabel}｜压摞 ${onPile}｜spread 标记 ${scaled}/${ids.length}`,
      );
    }
  }
}

console.log('\n摊开是宽度优先：先挑「排数少、每张原样大」那一档，再按各排实际空地让位');
{
  /** 摊开这一排给我看：几张、排几排、每张铺多大 */
  const spreadOf = (state: GameState, view: TableView, board: Board, ids: number[]) => {
    const cw = pieceSize(board);
    const box = boxes(state, view, board);
    const rs = ids.map((id) => box.get(id)!);
    return {
      rows: new Set(rs.map((r) => r.y.toFixed(1))).size,
      // 每张的视觉宽 ÷ 原尺寸＝1 就是没缩小过
      size: rs.reduce((m, r) => Math.min(m, r.w / cw), 1),
    };
  };
  // ① 没人挡路时 8 张就该一排铺完：让位只让给**真的摆了摞**的那一段，不该为角上那两块空地盘先缩
  for (const { name, board } of BOARDS) {
    const { state, view } = midGame(4, 25, [8, 8, 8, 8], [0, 0, 0, 0]);
    view.spread = true;
    const { rows, size } = spreadOf(state, view, board, state.hands[0]!);
    ok(`${name}｜8 张桌上没摞 一排铺完且每张原样大`, rows === 1 && size === 1, `排 ${rows}｜每张 ${size.toFixed(2)}`);
  }
  // ② 16 张是最挤的那一档（2 人局起手）：竖屏挑得到两排原样大，挤成三排小牌就是 bug
  for (const { name, board } of BOARDS) {
    const { state, view } = midGame(2, 26, [16, 16], [0, 0]);
    view.spread = true;
    const { rows, size } = spreadOf(state, view, board, state.hands[0]!);
    ok(`${name}｜16 张桌上没摞 不超过两排、每张原样大`, rows <= 2 && size === 1, `排 ${rows}｜每张 ${size.toFixed(2)}`);
  }
  // ③ 有摞挡着也一样不许缩：让的是摞实际占的那一段，不是整桌一律让出 CORNER_KEEP
  for (const { name, board: rect } of BOARDS) {
    for (const players of [2, 3, 4] as const) {
      const board = deskOf(rect, players);
      for (const [hands, piles] of CASES[players]!.slice(1, 3)) {
        const { state, view } = midGame(players, 27, hands, piles);
        view.spread = true;
        const ids = state.hands[0]!;
        const { rows, size } = spreadOf(state, view, board, ids);
        ok(`${name}｜${players} 人 手 ${ids.length} 摞 ${piles.join('/')} 摊开不缩牌`, size === 1, `排 ${rows}｜每张 ${size.toFixed(2)}`);
      }
    }
  }
}

console.log('\n摊开地盘自己那两条边：上界是按钮条底边那条缝（不许爬进条里、也不许多让一块地），下界是名字条上沿');
for (const { name, board } of BOARDS) {
  const band = handBand(board);
  // 按钮条的底边自己再算一遍（和上面那组同一口径），别拿被测代码的 band 当尺子——那样它自己错就量不出
  const barBottom = board.h - ctrlLift(board);
  const climb = barBottom - band.top; // 正数＝上界爬进按钮条的地里
  const waste = band.top - barBottom; // 让过头＝白留一条比缝还宽的空地，牌摊不开
  const offBottom = band.bottom - (board.h - labelBand());
  ok(
    `${name}｜摊开地盘上界只让一条缝、下界正落在名字条上沿`,
    climb <= 0.5 && waste <= 12 && Math.abs(offBottom) <= 0.5,
    `爬进条里 ${climb.toFixed(1)}｜多让 ${waste.toFixed(1)}｜下界偏出 ${offBottom.toFixed(1)}`,
  );
}

console.log('\n摊开挤紧那一档：空地被吃掉一大半时，每张仍各占一格、不许压到挡路的、不许出带');
{
  // 真桌面不会有这么大一块摞，但「挤紧」那一档只有这种极端才走得到——走不到的分支等于没闸，
  // 所以这里造一面墙直接把它逼出来（墙占掉左边多宽，两种都得走一遍）
  // 这块极端桌面量的是「摊开」那套排格算法本身，跟档位无关——16 张只有 2 人档发得出来，
  // 所以桌面按 2 人档那份形摆（8 摞 × 4 张），牌径才和真桌上一致
  const board: Board = deskOf({ w: 304, h: 430 }, 2);
  const full = pieceSize(board);
  const band = handBand(board);
  for (const wallW of [150, 210]) {
    const wall = { x: 0, y: band.top - 40, w: wallW, h: band.bottom - band.top + 80 };
    const spots = handSpread(16, board, [wall]);
    const rs = spots.map((s) => {
      const w = full * s.scale;
      return { x: s.x + (full - w) / 2, y: s.y + (full - w) / 2, w, h: w };
    });
    let overlap = 0;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (hits(rs[i]!, rs[j]!)) overlap++;
    const onWall = rs.filter((r) => hits(r, wall)).length;
    const escape = rs.filter((r) => r.y < band.top - 0.5 || r.y + r.h > band.bottom + 0.5).length;
    const out = rs.filter((r) => r.x < -1 || r.x + r.w > board.w + 1).length;
    const slots = new Set(rs.map((r) => `${r.x.toFixed(1)}#${r.y.toFixed(1)}`)).size;
    ok(
      `极窄 304×430｜左边占掉 ${wallW} 摊开 16 张`,
      rs.length === 16 && overlap === 0 && onWall === 0 && escape === 0 && out === 0 && slots === 16,
      `张数 ${rs.length}｜互压 ${overlap}｜压墙 ${onWall}｜越带 ${escape}｜出界 ${out}｜各自一格 ${slots}/16`,
    );
  }
  // 空地窄到连一张牌都塞不下的那种桌面（墙占到只剩 24 像素）：这时候**没有**不压墙的摆法，
  // 只能保证一张都不少、一张都不重叠——少一张就是界面上少了个元素，比压住一角的摞严重得多
  {
    const wall = { x: 0, y: band.top - 40, w: 280, h: band.bottom - band.top + 80 };
    const spots = handSpread(16, board, [wall]);
    const rs = spots.map((s) => {
      const w = full * s.scale;
      return { x: s.x + (full - w) / 2, y: s.y + (full - w) / 2, w, h: w };
    });
    let overlap = 0;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (hits(rs[i]!, rs[j]!)) overlap++;
    const slots = new Set(rs.map((r) => `${r.x.toFixed(2)}#${r.y.toFixed(2)}`)).size;
    ok(
      '极窄 304×430｜只剩 24 像素空地 摊开 16 张一张不少',
      rs.length === 16 && overlap === 0 && slots === 16,
      `张数 ${rs.length}｜互压 ${overlap}｜各自一格 ${slots}/16`,
    );
  }
}

console.log('\n扇形最低点：坠到最低的那张牌不许压进底边那条名字条（收牌摞靠横向让位隔开，见上面那组）');
for (const { name, board: rect } of BOARDS) {
  for (const [players, hands, piles] of [
    [2, [8, 8], [8, 8]],
    [2, [4, 10], [12, 6]],
    [3, [10, 10, 10], [0, 0, 0]],
    [3, [4, 6, 8], [4, 4, 4]],
    [4, [6, 6, 6, 6], [2, 2, 2, 2]],
    [4, [2, 4, 6, 6], [8, 2, 2, 2]],
  ] as [number, number[], number[]][]) {
    const board = deskOf(rect, players);
    const { state, view } = midGame(players, 18, hands, piles);
    const box = boxes(state, view, board);
    const low = Math.max(...state.hands[0]!.map((id) => box.get(id)!.y + box.get(id)!.h));
    // 几何上这两条边是刻意对齐的（LABEL_GAP 就是那条缝），所以容半个像素的浮点噪声
    const limit = board.h - labelBand();
    ok(`${name}｜${players} 人 扇形最低 y=${low.toFixed(1)} ≤ ${limit.toFixed(1)}`, low <= limit + 0.5, `低了 ${(low - limit).toFixed(1)}px`);
  }
}

console.log('\n别家的手牌坨不压我的扇形（挪锚点最容易撞的就是这条）');
for (const { name, board: rect } of BOARDS) {
  for (const [players, hands, piles] of [
    [2, [8, 8], [8, 8]],
    [2, [4, 10], [12, 6]],
    [3, [8, 8, 8], [2, 2, 2]],
    [3, [0, 10, 10], [10, 0, 0]],
    [4, [6, 6, 6, 6], [2, 2, 2, 2]],
    [4, [2, 4, 6, 6], [8, 2, 2, 2]],
    [4, [0, 8, 8, 8], [8, 0, 0, 0]],
  ] as [number, number[], number[]][]) {
    const board = deskOf(rect, players);
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

console.log('\n谁坐哪号都只是转个角度：联机坐到 P2/P3/P4 那几把椅子上，整张桌要按我这条边重排');
{
  /** 各家张数摆成一样多，旋转之后每一家的落点框才互相比得出来；再顺手给每家一墩在桌面上 */
  const seatTable = (board: Board, players: number, mine: number) => {
    const each = players === 2 ? 8 : 6;
    const hands = Array.from({ length: players }, () => each);
    // 剩下的那点量摊成每家一样的摞：三家四家都是整副减掉手里的，写成 32 就把 3 人档那份 30 漏了
    const piles = Array.from({ length: players }, () => (deckOf(players) - each * players) / players);
    const { state, view } = midGame(players, 31, hands, piles);
    view.mine = mine;
    view.freeze = state.hands.map((h, seat) => ({ seat, ids: h.slice(0, 2), pledge: false, best: false }));
    for (const p of view.freeze) state.hands[p.seat] = state.hands[p.seat]!.slice(2);
    return { state, view, b: boxes(state, view, board) };
  };
  /** 一家在这一桌上的全部落点（手里＋收进来的＋桌面上那一墩）的外框 */
  const spanOf = (t: { state: GameState; view: TableView; b: Map<number, Rect> }, seat: number) => {
    const ids = [
      ...t.state.hands[seat]!,
      ...(t.view.piles[seat] ?? []),
      ...(t.view.freeze?.find((p) => p.seat === seat)?.ids ?? []),
    ];
    const rs = ids.map((id) => t.b.get(id)!);
    return {
      x: Math.min(...rs.map((r) => r.x)),
      y: Math.min(...rs.map((r) => r.y)),
      x2: Math.max(...rs.map((r) => r.x + r.w)),
      y2: Math.max(...rs.map((r) => r.y + r.h)),
    };
  };
  for (const { name, board: rect } of BOARDS) {
    for (const players of [2, 3, 4]) {
      const board = deskOf(rect, players);
      const home = seatTable(board, players, 0);
      for (const mine of Array.from({ length: players }, (_, i) => i)) {
        const here = seatTable(board, players, mine);
        let off = 0;
        for (let seat = 0; seat < players; seat++) {
          // P(座) 在「我坐 P(mine+1)」时该站的位置＝P1 视角下 P((座-mine) mod 家数) 站的位置
          const was = spanOf(home, (seat - mine + players) % players);
          const now = spanOf(here, seat);
          if (Math.abs(was.x - now.x) > 0.01 || Math.abs(was.y - now.y) > 0.01 || Math.abs(was.x2 - now.x2) > 0.01 || Math.abs(was.y2 - now.y2) > 0.01) off++;
        }
        ok(
          `${name}｜${players} 人 我坐 P${mine + 1} 每一家都转到该站的那格`,
          off === 0,
          `${off} 家还留在绝对座位的老位置上`,
        );
        const low = labelBands(players, board, mine).filter((x) => x.y > board.h / 2);
        ok(
          `${name}｜${players} 人 我坐 P${mine + 1} 底边只有我那条名字条`,
          low.length === 1 && low[0]!.seat === mine,
          `底边站着 ${low.map((x) => `P${x.seat + 1}`).join('/') || '没人'}`,
        );
      }
    }
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
    '大屏手机竖屏 598×844': { 8: true, 16: true },
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
  // 3 人档自己那一遍：桌面矩形一样，但那份形是 10 摞 × 3 层，牌径跟着档位涨（横屏上 43.3 而不是 32.5），
  // 扇形摊得的步长和「挤不挤」都换个数——这张表也是探针实测的：起手 10 张只有竖屏/窄窗要摊开，6 张往下一律直接点
  const want3: Record<string, Record<number, boolean>> = {
    '手机竖屏 390×844': { 10: true, 6: false },
    '大屏手机竖屏 598×844': { 10: true, 6: false },
    '窄窗 558×668': { 10: true, 6: false },
    '平板横屏 844×390': { 10: false, 6: false },
    '桌面 1280×800': { 10: false, 6: false },
    '极窄 320×568': { 10: true, 6: false },
  };
  for (const { name, board: rect } of BOARDS) {
    const board = deskOf(rect, 3);
    for (const n of [10, 6]) {
      const step = fanStep(n, board);
      const cramped = handCramped(n, board);
      ok(
        `${name}｜3 人档 ${n} 张 露 ${(step / pieceSize(board)).toFixed(2)}cw → ${cramped ? '先摊开' : '直接点'}`,
        cramped === want3[name]![n],
        `期望 ${want3[name]![n] ? '先摊开' : '直接点'}`,
      );
    }
    for (let n = 3; n < 10; n++) {
      ok(`${name}｜3 人档 ${n}→${n + 1} 张不会变松`, !handCramped(n, board) || handCramped(n + 1, board), `${n + 1} 张成了直接点`);
    }
  }
}

console.log(failures ? `\n${failures} 条不过` : '\n全部通过');
if (failures) process.exitCode = 1;
