import { isFaceDown, rulesFor, type GameState, type Rules } from '../core/game.ts';
import { buildPieceSet } from '../core/pieces.ts';

/** 一张棋子在这一帧的样子：左上角坐标、旋转、缩放、扣不扣、堆叠次序、补间延迟、附加类 */
export interface Placed {
  x: number;
  y: number;
  rot: number;
  scale: number;
  down: boolean;
  z: number;
  delay: number;
  cls: string;
}

/** 桌面像素尺寸：可落牌的那块矩形，底部按钮条不在里面。
 *  `stacks`/`layers` 是这一档摆摞的形（2、4 人 8 摞 × 4 张，3 人 10 摞 × 3 张）：一张牌多大是从
 *  「那一排横着塞得下几张」反推出来的，所以它得跟桌面一起传——整桌只有一套牌径，发完牌也不能变。 */
export interface Board {
  w: number;
  h: number;
  stacks: number;
  layers: number;
}

/** 表现层自己攒的状态：引擎不记「哪张牌进了谁的摞」，也不管选中态和动画阶段 */
export interface TableView {
  mine: number;
  /** 各家收牌顺序，按收下的先后往摞上码 */
  piles: number[][];
  sel: Set<number>;
  hint: Set<number>;
  /** 刚收进牌摞的那几张，亮一下 */
  justWon: Set<number>;
  /** 摊在桌面的这一墩（结算动画期间也靠它留着）；null 表示桌面空着 */
  freeze: { seat: number; ids: number[]; pledge: boolean; best: boolean }[] | null;
  /** 发牌那几帧：按落位序号错开，看着像一张张码出去 */
  deal: boolean;
  /** 这一帧强制扣着的牌：抽签翻牌（先扣着画一帧再放开）、扣棋结算前那两秒的停顿（全扣着等翻） */
  holdDown: Set<number>;
  /** 鼠标指着我自己在桌面上的那套牌：扣棋里也只有这时亮给我看，别家和日志都看不见 */
  peek: Set<number>;
  /** 鼠标正指着第几摞（摸签阶段把那摞摊开给人看清），null 表示没指 */
  hover: number | null;
  /** 摸签「选中」那一拍：点中这张抬起描边，没点中的那些摞降透明。只做位移以外的强调 */
  pick: number | null;
  /** 摸签「抽出」那一拍：这张签牌就在自己那一格里放大翻面，null 表示已经送回扣下 */
  lift: number | null;
  /** 自己的手牌摊开了没：收起时是握着的扇形（互相压着），摊开后每张各占一格、互不遮挡 */
  spread: boolean;
}

/** 一摞几张：收来的牌按这个数码，四张一墩看得清 */
export const PILE_SIZE = 4;

/** 摸签时鼠标压着的那摞彻底摊开，摞里每张互不遮挡、每张都能单独点——间距按牌面直径算，`stackSpots` 跟着它。
 *  几格看这一摞实际几张（`Board.layers`），不是写死四张 */
const SPREAD = 1.04;

/**
 * 名字条（.chip）在桌面上占的边带。宽高是 CSS 里那条 pill 的实际尺寸，
 * **落点由 app.ts 从 `labelBands()` 写进内联样式**，CSS 只管长相——两边不会各自漂移。
 * 152→168：加了「本墩第几手」的圆角标，它是按最宽那条文字量的（角标 + P2 + 已出 + 16 张 + 收 12）。
 * 这条只能按最坏情况留，浏览器里真量才算得准，我这儿是估的——他在真机上一眼能看出来有没有被裁。
 */
export const LABEL_W = 168;
export const LABEL_H = 26;
export const LABEL_X = 8;
const LABEL_TOP = 6;
const LABEL_BOTTOM = 3;
/** 牌让开名字条的缝（桌面像素），摞和扇形都按它算，别靠肉眼估 */
const LABEL_GAP = 5;

/** 收牌摞上那张小牌的缩放：一摞四张码起来就这么大 */
const PILE_SCALE = 0.55;

/** 一排放两组摞，排满往桌心叠下一排——贴着角那一小块地盘就这么宽 */
const PILE_ROW = 2;

/** 一组（四张码一摞）自己占多宽多深：同摞逐张错开会把外轮廓撑出去这一截 */
const GROUP_A = 1 + 0.16 * (PILE_SIZE - 1);
const GROUP_I = 1 + 0.24 * (PILE_SIZE - 1);

/** 相邻两组之间沿边／往桌心的圆心距（乘小牌半径） */
const GROUP_STEP_A = 1.7;
const GROUP_STEP_I = 1.85;

/**
 * 一块收牌地盘有多大：**固定**，按「两排两组、每组四张」在 `PILE_SCALE` 下量出来的那个方框。
 * 固定是关键——名字条贴边、别家让位全按它算，牌多起来时地盘不能跟着长，
 * 只能框里的格变密、小牌变小（见 `pileUnit`）。
 */
function pileBox(cw: number): { a: number; i: number } {
  const u = cw * PILE_SCALE;
  return { a: u * (GROUP_STEP_A * (PILE_ROW - 1) + GROUP_A), i: u * (GROUP_STEP_I * (PILE_ROW - 1) + GROUP_I) };
}

/**
 * 收 32 张（一家独吞＝八组）也不许叠罗汉：组数一多就重新分格数、把每张小牌整体缩一点，
 * 让它们仍在同一个方框里排成整齐的网格。四组以内用原尺寸，看不出缩过。
 * 沿边固定 `PILE_ROW` 组：横向让量 `CORNER_KEEP` 就够两组，多塞一列反而要把牌缩得更狠。
 * `alongRoom` 是**沿边那个方向**实际还剩多长（竖边那两家要排到自己那坨手牌的上沿为止）：
 * 牌径跟着档位涨（3 人档一摞三层，同样高的桌面牌更大），那条边可能不够排，
 * 这时候也按同一档缩——缩是往自己那个角落缩的，只会更松，不会挤到别人。
 */
function pileUnit(groups: number, cw: number, alongRoom = Infinity): number {
  const rows = Math.max(1, Math.ceil(groups / PILE_ROW));
  const span = (Math.min(PILE_ROW, Math.max(1, groups)) - 1) * GROUP_STEP_A + 0.16 * (PILE_SIZE - 1) + 1;
  return Math.min(cw * PILE_SCALE, pileBox(cw).i / (GROUP_STEP_I * (rows - 1) + GROUP_I), alongRoom / span);
}

/** 手牌扇形左右各让出这么多个 cw：四角那块地盘归收牌摞，扇形不许压进去 */
const CORNER_KEEP = 2.4;

/** 扇形两边往下坠的幅度（乘 cw）：中间最高、两边最低，握在手里的那个弧度 */
const FAN_DIP = 0.34;

/**
 * 每张露出来的宽度占牌径到这个比例，就直接点那张；再叠就得先点一下摊开。
 * 扇形铺得开时是 0.84cw（桌面/横屏 8～16 张全在这一档），窄屏 8 张只剩 0.5～0.67cw 一条边。
 * 按「露出的比例」判而不是按像素判：牌本来就跟着桌面缩放，缩到哪儿手感都按同一张脸的比例算。
 */
const FAN_LEGIBLE = 0.7;

/** 一块桌面矩形（左上角 + 宽高，像素）：摊开用它记「这一排还剩多长空地」和「哪块被牌摞占了」 */
export interface SpreadBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 摊开后一张牌的落点：**未缩放方框**的左上角 + 该用的缩放（和 `Placed` 同一口径） */
export interface SpreadSpot {
  x: number;
  y: number;
  scale: number;
}

/** 摊开最多排几排：排数由 `handSpread` 按「哪一档把每张铺得最大」挑，这条只是上限 */
const HS_ROWS = 3;

/** 摊开时两张牌的圆心距（乘牌径），大于 1 才互不遮挡、每张各自点得着 */
const HS_GAP = 1.06;

/** 摊开最上那排牌离按钮条留这条缝：贴边了看着就像盖住，白摊 */
const SPREAD_PAD = 8;

/**
 * 摊开手牌能吃的那块地：底边名字条以上、按钮条以下。
 * `.ctrl` 是 `bottom: var(--ctrl-lift)`，从桌底往上长，所以 `ctrlLift` 量的就是它**底边**离桌底多远
 * ——这块地的上界直接取那条底边，不能再减一次按钮高度，减了等于放行让牌爬到按钮条上。
 */
export function handBand(board: Board): { top: number; bottom: number } {
  return {
    top: board.h - ctrlLift(board) + SPREAD_PAD,
    bottom: board.h - labelBand(),
  };
}

/** 手牌横向能铺多宽：左右各让出 CORNER_KEEP 个 cw，那两块归角上的收牌摞 */
function handRoom(cw: number, board: Board): number {
  return Math.max(cw, board.w - cw * CORNER_KEEP * 2);
}

/** 扇形里相邻两张的圆心距：铺得开就按 0.84cw 摆，铺不开就整体挤紧 */
export function fanStep(n: number, board: Board): number {
  const cw = pieceSize(board);
  return n > 1 ? Math.min(cw * 0.84, (handRoom(cw, board) - cw) / (n - 1)) : cw;
}

/**
 * 手牌叠到看不清边了没。宽桌面上 8～16 张各露 0.84cw，点哪张就是哪张，不必先摊开；
 * 窄屏上同样的 8 张只剩半张脸的边（手机竖屏 20px），才要「点一下摊开、再点那张」那第一下。
 */
export function handCramped(n: number, board: Board): boolean {
  return fanStep(n, board) < pieceSize(board) * FAN_LEGIBLE;
}

/**
 * 摊开手牌后的格子：每张各占一格、互不遮挡，从底边名字条上方往上排。
 * **宽度优先**：一排放得下几张，按「这一排实际还剩多长空地」算——上面那几排根本不在角上收牌摞的
 * 地盘里，就不该再为它们让出 `CORNER_KEEP` 那两个 cw（那口径是给扇形用的，扇形会往两边坠到角上）。
 * 原来横向一律让位，于是手机竖屏 16 张被挤成三排小牌（每张大 0.70）；现在挑得到「两排、每张原样大」。
 * 排数在 1..HS_ROWS 里挑「装得下又不必缩小的最少那档」；三排都按各自空地还装不下，才整体挤紧，
 * 挤的时候各排照**自己那段空地**解间距（见 `tightFit`），每张仍各占一格，谁也不许盖住按钮条、名字条和别家的牌。
 * `blocks` 是此刻摆在桌上的收牌摞视觉矩形（`layout` 里现成有），不传就当作没人挡路。
 * 返回的是**未缩放方框的左上角**（和 `layout` 的 Placed 同一口径）和该用的 `scale`。
 */
export function handSpread(n: number, board: Board, blocks: readonly SpreadBox[] = []): SpreadSpot[] {
  if (n <= 0) return [];
  const full = pieceSize(board);
  const band = handBand(board);
  const bandH = band.bottom - band.top;
  const stepFull = full * HS_GAP;
  for (let rows = 1; rows <= HS_ROWS; rows++) {
    const step = Math.min(stepFull, bandH / rows);
    const lanes = rowLanes(rows, step, full, band, board, blocks);
    if (lanes.reduce((a, l) => a + laneCards(l.w, step, full), 0) >= n) return place(lanes, n, step, full);
  }
  // 三排都按各自空地装不下，才整体挤紧：每档排数各解一次「这个间距塞得下 n 张」，挑把每张铺得最大的那档
  let bestStep = 0;
  let lanes: SpreadBox[] = [];
  for (let r = 1; r <= HS_ROWS; r++) {
    const tight = tightFit(r, n, full, band, board, blocks, stepFull);
    if (tight.step > bestStep) {
      bestStep = tight.step;
      lanes = tight.lanes;
    }
  }
  return place(lanes, n, bestStep, full);
}

/**
 * 挤紧一档：`r` 排要塞下 `n` 张，间距最大能到多少。
 * 先按线性式解（各排空地总长 ÷ 每张要占的那一格），再按**整数**格数往回收一步——
 * `laneCards` 会向下取整，某一排可能就因为这一点少塞一张。收到 1 像素还塞不下就收在 1 像素：
 * 每张照样各占一格，只是小得没法看，那种桌面本来就装不下这副牌。
 */
function tightFit(
  r: number,
  n: number,
  full: number,
  band: { top: number; bottom: number },
  board: Board,
  blocks: readonly SpreadBox[],
  stepFull: number,
): { step: number; lanes: SpreadBox[] } {
  let step = Math.min(stepFull, (band.bottom - band.top) / r);
  let lanes = rowLanes(r, step, full, band, board, blocks);
  for (let g = 0; g < 40 && lanes.reduce((a, l) => a + laneCards(l.w, step, full), 0) < n; g++) {
    const room = lanes.reduce((a, l) => a + Math.max(0, l.w - full), 0);
    // 按缺口解一次，解不动就逐像素退，保证这一轮一定在变小
    const next = n > r ? Math.min(step - 1, room / (n - r)) : step - 1;
    step = Math.max(1, next);
    lanes = rowLanes(r, step, full, band, board, blocks);
  }
  return { step, lanes };
}

/** 一排（r 排里的第 i 排）从底往上排，占多高、剩下多长空地 */
function rowLanes(
  rows: number,
  step: number,
  full: number,
  band: { top: number; bottom: number },
  board: Board,
  blocks: readonly SpreadBox[],
): SpreadBox[] {
  const out: SpreadBox[] = [];
  for (let i = 0; i < rows; i++) {
    const y = band.bottom - step / 2 - i * step - full / 2;
    const lane = freeLane(board, { x: 0, y, w: board.w, h: full }, blocks);
    // 空地窄到一张牌都放不下也得留一格，不然上面算排数时会以为这排是白送的
    out.push(lane.w < full ? { x: board.w / 2 - full / 2, y: lane.y, w: full, h: lane.h } : lane);
  }
  return out;
}

/** 这一排里最长的一段没被牌摞占住的横条（裁在桌面内） */
function freeLane(board: Board, row: SpreadBox, blocks: readonly SpreadBox[]): SpreadBox {
  const hit = blocks
    .filter((b) => b.y < row.y + row.h && row.y < b.y + b.h)
    .map((b) => ({ x: Math.max(0, Math.min(board.w, b.x)), w: Math.max(0, Math.min(board.w, b.x + b.w) - Math.max(0, b.x)) }))
    .sort((a, c) => a.x - c.x);
  // 起点是「还没量到任何空地」＝0 宽，不是整桌宽：拿整桌宽当起点，后面每一段空隙都比不过它，
  // 结果这一条永远返回整桌——牌摞白让位，摊开的牌照样压在摞上
  let at = 0;
  let best = { x: 0, w: 0 };
  for (const b of hit) {
    if (b.x - at > best.w) best = { x: at, w: b.x - at };
    at = Math.max(at, b.x + b.w);
  }
  if (board.w - at > best.w) best = { x: at, w: board.w - at };
  return { x: best.x, y: row.y, w: best.w, h: row.h };
}

/** 一段宽 `room` 的空地按 `step` 的心距塞得下几张牌 */
function laneCards(room: number, step: number, full: number): number {
  return room < full ? 0 : Math.floor((room - full) / step) + 1;
}

/** 从最底那排往上填，每排最多塞它自己那段空地；最上面那排兜住剩下的，保证每张都有一格 */
function place(lanes: SpreadBox[], n: number, step: number, full: number): SpreadSpot[] {
  const scale = Math.min(1, step / HS_GAP / full);
  const counts: number[] = [];
  let left = n;
  for (let i = 0; i < lanes.length; i++) {
    const c = i === lanes.length - 1 ? left : Math.min(left, laneCards(lanes[i]!.w, step, full));
    counts.push(c);
    left -= c;
  }
  const out: SpreadSpot[] = [];
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]!;
    const spanW = (counts[i]! - 1) * step;
    const cx = lane.x + lane.w / 2;
    for (let col = 0; col < counts[i]!; col++) out.push({ x: cx - spanW / 2 + col * step - full / 2, y: lane.y, scale });
  }
  return out;
}

/**
 * 摆在桌上的收牌摞各占哪块视觉矩形：`Placed` 的 x/y 是**未缩放**方框的左上角，牌按 `scale` 绕中心缩，
 * 所以真正占地的矩形要在四周各收进 `(cw - cw*scale)/2`。摊开让位按这块实的算，不按虚的方框。
 * 只认摞（含刚收下、还在亮的那张）——桌面那一墩在桌心，够不着底边这条带。
 */
function pileBoxes(placed: Iterable<Placed>, cw: number): SpreadBox[] {
  const out: SpreadBox[] = [];
  for (const p of placed) {
    if (p.cls !== 'pile' && p.cls !== 'won') continue;
    const w = cw * p.scale;
    out.push({ x: p.x + (cw - w) / 2, y: p.y + (cw - w) / 2, w, h: w });
  }
  return out;
}

/** 按钮条从扇形顶边再往上抬这么多像素。`.ctrl` 的 bottom 就是它，见 app.ts 写的 --ctrl-lift */
export const CTRL_GAP = 52;

/** 贴在顶/底边那条名字条占多深（含一条缝）：扇形坠到最低的牌不许压进它 */
export function labelBand(): number {
  return LABEL_H + LABEL_BOTTOM + LABEL_GAP;
}

/**
 * 一块收牌地盘能吃多深：沿边那一长条和往桌心那一长条取大。
 * 名字条贴边、别家让位都按这个数算，别靠肉眼估。
 */
export function pileDepth(cw: number): number {
  const box = pileBox(cw);
  return Math.max(box.a, box.i);
}

/** 顶边那一长条有多深：P3 的名字条 + 一条缝 + 它贴边那排收牌摞 */
export function topBand(board: Board): number {
  return LABEL_TOP + LABEL_H + LABEL_GAP + pileDepth(pieceSize(board));
}

/**
 * 桌面底边（和顶边）那一长条有多深：名字条 + 一条缝 + 一排收牌摞。
 * 底边的摞从这条线开始往下排。
 */
export function bottomBand(board: Board): number {
  return labelBand() + pieceSize(board) * PILE_SCALE;
}

/** 扇形最中间那张的顶边到桌底的距离：整张牌 + 两边坠下去的那截，再压过底边那条名字条和一条缝 */
export function fanLift(board: Board): number {
  return pieceSize(board) * (1 + FAN_DIP) + labelBand();
}

/** 按钮条底边离桌底多远（桌面像素）：CSS 用它，布局守恒测试也用它，两边不会各自漂移 */
export function ctrlLift(board: Board): number {
  return fanLift(board) + CTRL_GAP;
}

/**
 * 各家名字条的矩形（桌面像素坐标）：贴在自家那摞收牌摞旁边，和 `pileGeom` 一一对应。
 * 4 人局里坐左手边那家不贴左下角（那条边整个归你，摆在那儿只会被当成你的牌），改成挂在
 * 上边那排摞底下、顺着左边往下数第一个空位。
 * `mine` 是看桌的人坐哪号：**四个位置按「离我多远」转过来发**，不然联机坐 P2 时，
 * 自己那条名字条会挂到对面那角上（截图里「你 16 张」跑到左上角就是这么来的）。
 * 矩形是 168 宽的最坏预留（收牌摞照它让位），条里的字通常不到一半，所以还得说清**从哪一头长**：
 * `edge` 住右半场就是 'right'，app.ts 据此把条钉在矩形右边——左对齐会把它留在框的左头，
 * 看着就是飘在桌心那一侧。
 */
export interface LabelBand {
  seat: number;
  x: number;
  y: number;
  w: number;
  h: number;
  edge: 'left' | 'right';
}

export function labelBands(players: number, board: Board, mine: number): LabelBand[] {
  // edge 挨着位置一起给，不是算出来的：桌窄到两个 168 的框在中间搭界时，
  // 「这条属于哪一边的地盘」仍然得说得住——它跟的是 `pileGeom` 那半边，不是谁过半
  const band = (rel: number, x: number, y: number, edge: 'left' | 'right'): LabelBand => ({
    seat: (rel + mine) % players,
    x,
    y,
    w: LABEL_W,
    h: LABEL_H,
    edge,
  });
  const top = LABEL_TOP;
  const bottom = board.h - LABEL_H - LABEL_BOTTOM;
  const left = LABEL_X;
  const right = board.w - LABEL_W - LABEL_X;
  if (players === 2) return [band(0, right, bottom, 'right'), band(1, left, top, 'left')];
  const seats = [
    band(0, right, bottom, 'right'),
    band(1, left, topBand(board) + LABEL_GAP, 'left'),
    band(2, left, top, 'left'),
    band(3, right, top, 'right'),
  ];
  // 3 人局就是这套地盘少一家：坐左手边和对面那两条照旧，右手边那条（rel 3）空着没人坐
  return players === 3 ? seats.slice(0, 3) : seats;
}

/** 这一档摆几摞、一摞几张：枚数和摞大小都在落过定的 `state.rules` 里，发完牌也不会变。
 *  牌径是从「那一排放得下几张」反推的，整桌只有一套，所以摆摞之外也得带着这个形——别让哪儿自己写死 8。 */
export function draftShape(state: GameState): { stacks: number; layers: number } {
  const layers = state.rules.draft.stackSize;
  return { stacks: Math.ceil(state.pieces.length / layers), layers };
}

/** 壳子搭一次就得够最坏那一排：2、4 人 8 摞，3 人 10 摞。改人数不重搭壳子，多出来的标签先藏起来 */
export function maxStacks(rules: Rules): number {
  return Math.max(
    ...rules.playerCounts.map((n) => {
      const r = rulesFor(rules, n);
      return Math.ceil(buildPieceSet(r.ranks).length / r.draft.stackSize);
    }),
  );
}

/** 摆摞阶段的几何：这一排几摞、间距多大，摆牌的和那一排的领地用同一套常数（摞数照 `Board.stacks`） */
function draftGeom(board: Board) {
  const cw = pieceSize(board);
  const gap = cw * 1.16;
  return { cw, gap, x0: board.w / 2 - (gap * (board.stacks - 1)) / 2, y0: board.h * 0.42 };
}

/** 抽出来展示这张放大这么多：整桌就它一张在讲点数，得比摞里的牌明显大一圈 */
const LIFT_SCALE = 1.3;

/** 每摞的领地（桌面像素坐标）：按摊开后的整列算。鼠标进这一块就把那摞摊开，「第 N 摞」标签也挂在这儿。
 *  点击目标不是它——摊开之后摞里每一张各是一个目标，点哪张抽哪张。 */
export function stackSpots(board: Board): { x: number; y: number; w: number; h: number }[] {
  const { cw, gap, x0, y0 } = draftGeom(board);
  // 一列摊开是 layers-1 个间隔：4 张三格、3 张两格，写死 3 就给 3 人局多留一格空
  const col = cw * SPREAD * (board.layers - 1);
  return Array.from({ length: board.stacks }, (_, i) => ({
    x: x0 + i * gap - cw * 0.56,
    y: y0 - col - cw * 0.16,
    w: cw * 1.12,
    h: col + cw * 1.32,
  }));
}

/** 棋子直径：摆摞那一排横着要塞得下（几摞由规则表给），短边还得留出手牌和出牌区 */
export function pieceSize(board: Board): number {
  return Math.max(20, Math.min(board.w / (board.stacks * 1.16), (board.h * 0.4) / board.layers, 56));
}

interface Point {
  x: number;
  y: number;
}

/**
 * 从桌子中心指向这个座位的单位向量，出牌区和牌摞都靠它外推。
 * 传进来的都是**相对座位**：0＝看桌的人自己（永远在下方），往后顺时针一家。
 */
function dir(rel: number, players: number): Point {
  if (players === 2) return rel === 0 ? { x: 0, y: 1 } : { x: 0, y: -1 };
  return [{ x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }][rel]!;
}

/**
 * 座位锚点：0 号永远在下方正中（他的牌摊成扇形），其余三家贴自己那条边。
 * 另一头也不再居中——各朝自己右手边那个角偏过去（左边那家偏下、对面偏左、右边那家偏上），
 * 三家都压在中轴上就等于挤在桌心，出的牌反而没地方摆。
 */
function seatAnchor(rel: number, players: number, board: Board, cw: number): Point {
  const inset = cw * 1.6;
  if (rel === 0) return { x: board.w / 2, y: board.h - inset };
  if (players === 2) return { x: board.w / 2, y: inset };
  if (rel === 1) return { x: inset, y: board.h * 0.62 };
  if (rel === 3) return { x: board.w - inset, y: board.h * 0.38 };
  return { x: board.w * 0.34, y: inset };
}

/** 坐左手边那家（相对座位 1）名字条的 y：挂在顶边那条带底下，收牌摞紧贴着它往下排 */
function sideLabelY(board: Board): number {
  return topBand(board) + LABEL_GAP;
}

/**
 * 收牌摞长在哪（按**相对座位**：0＝看桌的人自己）：各家的**右手边那个角**（下方那家的右手在屏幕右、
 * 左边那家在下、对面在左、右边那家在上），从那个角沿边排开、排满了往桌心叠第二排。
 * 名字条就贴在同一个角下面。
 * 4 人局的左手边那家是唯一的例外：底边那一条整个是你的地盘（扇形铺满），摞摆左下角会被读成你的牌，
 * 所以它挂到左边那条边的上半段——还是自己那一边，只是不再贴角。
 * `alongX` 为真沿横边排、为假沿竖边排，`sa` 是排开方向，`si` 是朝桌心叠排的方向。
 */
interface PileGeom {
  x: number;
  y: number;
  alongX: boolean;
  sa: number;
  si: number;
}

function pileGeom(rel: number, players: number, board: Board, cw: number): PileGeom {
  const s = cw * 0.62;
  // 锚点就是这块地盘的边角线：`layout` 里按小牌实际尺寸摆可见框，缩多少都同一条边，不会往桌心漂
  const below = LABEL_TOP + LABEL_H + LABEL_GAP;
  const above = board.h - bottomBand(board);
  // 2 人局对面坐北，右手边＝左上角
  if (players === 2) {
    return rel === 0
      ? { x: board.w - s, y: above, alongX: true, sa: -1, si: -1 }
      : { x: s, y: below, alongX: true, sa: 1, si: 1 };
  }
  if (rel === 0) return { x: board.w - s, y: above, alongX: true, sa: -1, si: -1 };
  if (rel === 1) return { x: s, y: sideLabelY(board) + LABEL_H + LABEL_GAP, alongX: false, sa: 1, si: 1 };
  if (rel === 2) return { x: s, y: below, alongX: true, sa: 1, si: 1 };
  return { x: board.w - s, y: below, alongX: false, sa: 1, si: -1 };
}

/** 手牌扇形：按强度排好，横向均摊，越靠边翘得越高、转得越多 */
function fan(ids: number[], order: (id: number) => number): { id: number; dx: number; dy: number; rot: number }[] {
  const sorted = [...ids].sort((a, b) => order(a) - order(b));
  const mid = (sorted.length - 1) / 2;
  return sorted.map((id, k) => {
    const t = sorted.length > 1 ? (k - mid) / mid : 0;
    return { id, dx: k - mid, dy: t * t, rot: t };
  });
}

/**
 * 一帧的完整摆位，坐标全在桌面像素空间里；resize 时整表重算一次（不补间）。
 * 引擎管逻辑、牌在哪纯属表现层，所以这里只读 draft/trick 的内部结构，绝不改。
 */
export function layout(state: GameState, view: TableView, board: Board): Map<number, Placed> {
  const cw = pieceSize(board);
  const out = new Map<number, Placed>();
  const claimed = new Set<number>();
  let seq = 0;

  const put = (id: number, p: Partial<Placed>): void => {
    if (claimed.has(id)) return;
    claimed.add(id);
    out.set(id, { x: 0, y: 0, rot: 0, scale: 1, down: false, z: seq++, delay: 0, cls: '', ...p });
  };

  /** 亮不亮：我自己的牌永远亮，别人手里/桌上的牌只有公开过的才亮——公开口径统一问引擎的 isFaceDown */
  const faceUp = (id: number, mine: boolean): boolean => {
    if (view.holdDown.has(id)) return false;
    return mine || !isFaceDown(state, id);
  };

  /**
   * 绝对座位 → 相对座位（0＝看桌的人自己，永远在下方）。
   * 手牌那一支本来就按 `view.mine` 画在底下，可收牌摞、出牌区、名字条以前全按绝对座位摆——
   * 于是联机坐 P2 时整套地盘反了 180°：对面赢的旗落在我这条边，我的名字条挂到对面那角。
   * 几何一律过这一道，谁坐哪号都只是转个角度。
   */
  const rel = (seat: number) => (seat - view.mine + state.players) % state.players;

  if (state.phase === 'draft' && state.draft) {
    const draft = state.draft;
    const { gap, x0, y0 } = draftGeom(board);
    // 「选中/抽出」这两拍要把没点中的那些摞压到后面去，正在演的那一摞不参与
    const focus = view.pick !== null || view.lift !== null;
    draft.stacks.forEach((stack, i) => {
      const hot = view.hover === i;
      // 一列的中间那格：4 张是 1.5、3 张是 1，倾斜和偏移都围着它算
      const midSlot = (stack.length - 1) / 2;
      stack.forEach((id, depth) => {
        // 摞口朝下数：数组末尾那张是摞口（不指定时引擎抽的就是它），所以它落在最下面那格、紧挨那一排，
        // 摊开和抽牌都是「从摞口揭走一张」的视角，而不是从整列最高点飞下来
        const slot = stack.length - 1 - depth;
        const spread = hot ? SPREAD : 0.11;
        const x = x0 + i * gap - cw / 2 - (hot ? 0 : (slot - midSlot) * cw * 0.04);
        const y = y0 - slot * cw * spread - (hot ? cw * 0.16 : 0);
        const cls = [
          draft.stage === 'draw' ? 'stack' : '',
          draft.drawn === id && draft.stage === 'allocate' ? 'drawn' : '',
          view.pick === id ? 'pick' : '',
          focus && !hot ? 'dim' : '',
        ]
          .filter(Boolean)
          .join(' ');
        // 抽出那一拍就在自己那一格里放大：点的是这张，亮的也必须是这张，别再往下飘回摞口。
        // 唯一能让的是横向——最外两摞放大到 1.3 倍会爬出桌沿，往里让最多 0.07cw（不到 4px），
        // 竖向一格都不动：挪了格子就又成了「我点的那张和翻过来展示的那张不是一个位置」
        if (view.lift === id) {
          const cx = x + cw / 2;
          const over = (cw * LIFT_SCALE) / 2 - Math.min(cx, board.w - cx);
          const nudge = Math.max(0, over) * (cx > board.w / 2 ? -1 : 1);
          put(id, { x: x + nudge, y, scale: LIFT_SCALE, z: 5000, down: !faceUp(id, false), cls });
          return;
        }
        put(id, {
          x,
          y,
          z: i * 10 + depth,
          down: !faceUp(id, false),
          rot: hot ? 0 : (slot - midSlot) * 1.4,
          cls,
        });
      });
    });
    return out;
  }

  // 收牌摞：四张码一摞，各家长在自家那块地盘上，一排两组、排满往桌心叠下一排，同摞内逐张错开好数张数。
  // 地盘是固定大小的方框（`pileBox`），组数超过框里原有的四格就把小牌缩一档、格数加排，
  // 所以一家独吞 32 张也是八组各占一格排整齐，不会叠成一坨（他原话：超过 4 摞也要按顺序排好）。
  for (let seat = 0; seat < state.players; seat++) {
    const g = pileGeom(rel(seat), state.players, board, cw);
    const ids = view.piles[seat] ?? [];
    // 挂在左右两条竖边那两家：沿边那一长条排到自己那坨手牌的上沿为止（手牌贴边、摞也从贴角那头起排，
    // 桌矮的时候两条会搭界）。横边那两家的沿边方向是横的，够长，不量这条。
    const up = g.alongX ? Infinity : seatAnchor(rel(seat), state.players, board, cw).y - (cw * 0.6) / 2 - g.y;
    const u = pileUnit(Math.ceil(ids.length / PILE_SIZE), cw, up);
    ids.forEach((id, k) => {
      const group = Math.floor(k / PILE_SIZE);
      const depth = k % PILE_SIZE;
      const along = (group % PILE_ROW) * u * GROUP_STEP_A + depth * u * 0.16;
      const inward = Math.floor(group / PILE_ROW) * u * GROUP_STEP_I + depth * u * 0.24;
      put(id, {
        x: g.x + (g.alongX ? g.sa * along : g.si * inward) - cw / 2 + u / 2,
        y: g.y + (g.alongX ? g.si * inward : g.sa * along) - cw / 2 + u / 2,
        scale: u / cw,
        z: 100 + seat * 40 + group * 4 + depth,
        down: !faceUp(id, seat === view.mine),
        delay: view.justWon.has(id) ? 140 : 0,
        cls: view.justWon.has(id) ? 'won' : 'pile',
      });
    });
  }

  // 桌面这一墩：只认 freeze 快照，app 在结算动画期间照样留着它。
  // 落点取「座位到桌心」的中点，抵押那套再往桌心挪一截，四家各占一条，不会跟手牌叠在一起
  const mid = { x: board.w / 2, y: board.h / 2 };
  for (const play of view.freeze ?? []) {
    const d = dir(rel(play.seat), state.players);
    const a = seatAnchor(rel(play.seat), state.players, board, cw);
    const bx = a.x + (mid.x - a.x) * 0.52 - d.x * cw * (play.pledge ? 0.62 : 0);
    const by = a.y + (mid.y - a.y) * 0.52 - d.y * cw * (play.pledge ? 0.62 : 0);
    play.ids.forEach((id, k) => {
      put(id, {
        x: bx - cw / 2 + (k - (play.ids.length - 1) / 2) * cw * 0.72,
        y: by - cw / 2,
        rot: (k - (play.ids.length - 1) / 2) * 5,
        scale: play.pledge ? 0.82 : 1,
        z: 600 + play.seat * 8 + k + (play.pledge ? 0 : 40),
        down: !faceUp(id, play.seat === view.mine && view.peek.has(id)),
        cls: play.pledge ? 'pledge' : play.best ? 'ontable best' : 'ontable',
      });
    });
  }

  // 手牌：我的摊成扇形（可点），别家的按张数码一坨背面
  for (let seat = 0; seat < state.players; seat++) {
    const hand = state.hands[seat];
    if (seat === view.mine) {
      // 扇形以桌面正中为轴，左右各让出 CORNER_KEEP 个 cw 给角上那摞
      const lift = fanLift(board);
      const step = fanStep(hand.length, board);
      const fans = fan(hand, (id) => state.byId.get(id)!.tier);
      // 摊开态：选完收回扇形，这中间它就是全桌最该看清的一块，z 给到最高，别被别家的坨压住。
      // 挡路的是此刻摆在桌上的收牌摞（含刚收下那张），按它们的**视觉框**给摊开的牌让位——
      // 光让 `handSpread` 自己猜不出摞在哪，四家地盘长短各不一样。
      const spots = view.spread ? handSpread(fans.length, board, pileBoxes(out.values(), cw)) : null;
      fans.forEach((f, k) => {
        const s = spots?.[k];
        put(f.id, {
          x: s ? s.x : board.w / 2 + f.dx * step - cw / 2,
          y: s ? s.y : board.h - lift + f.dy * cw * FAN_DIP,
          rot: s ? 0 : f.rot * 6,
          scale: s ? s.scale : 1,
          z: s ? 1500 + k : 900 + Math.round((f.dx + 50) * 10),
          down: false,
          delay: view.deal ? k * 45 : 0,
          cls: `hand ${s ? 'spread' : ''} ${view.sel.has(f.id) ? 'sel' : view.hint.has(f.id) ? 'hint' : ''}`,
        });
      });
    } else {
      const a = seatAnchor(rel(seat), state.players, board, cw);
      hand.forEach((id, k) => {
        put(id, {
          x: a.x - (cw * 0.6) / 2 + (k % 4) * cw * 0.16,
          y: a.y - (cw * 0.6) / 2 + Math.floor(k / 4) * cw * 0.11,
          scale: 0.6,
          z: 400 + seat * 30 + k,
          down: !faceUp(id, false),
          delay: view.deal ? k * 45 : 0,
        });
      });
    }
  }

  return out;
}
