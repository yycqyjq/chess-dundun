import { isFaceDown, type GameState } from '../core/game.ts';

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

/** 桌面像素尺寸：可落牌的那块矩形，底部按钮条不在里面 */
export interface Board {
  w: number;
  h: number;
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
  /** 摸签「选中」那一拍：点中这张抬起描边，其余七摞降透明。只做位移以外的强调 */
  pick: number | null;
  /** 摸签「抽出」那一拍：这张签牌就在自己那一格里放大翻面，null 表示已经送回扣下 */
  lift: number | null;
  /** 自己的手牌摊开了没：收起时是握着的扇形（互相压着），摊开后每张各占一格、互不遮挡 */
  spread: boolean;
}

const STACKS = 8;

/** 一摞几张：收来的牌按这个数码，四张一墩看得清 */
export const PILE_SIZE = 4;

/** 摸签时鼠标压着的那摞彻底摊开，四张互不遮挡、每张都能单独点——间距按牌面直径算，`stackSpots` 跟着它 */
const SPREAD = 1.04;

/**
 * 名字条（.chip）在桌面上占的边带。宽高是 CSS 里那条 pill 的实际尺寸，
 * **落点由 app.ts 从 `labelBands()` 写进内联样式**，CSS 只管长相——两边不会各自漂移。
 * 152→168：加了「本墩第几手」的圆角标，它是按最宽那条文字量的（角标 + P2 + 已出 + 16 张 + 收 12）。
 * 这条只能按最坏情况留，浏览器里真量才算得准，我这儿是估的——他在真机上一眼能看出来有没有被裁。
 */
export const LABEL_W = 168;
export const LABEL_H = 26;
const LABEL_X = 8;
const LABEL_TOP = 6;
const LABEL_BOTTOM = 3;
/** 牌让开名字条的缝（桌面像素），摞和扇形都按它算，别靠肉眼估 */
const LABEL_GAP = 5;

/** 收牌摞上那张小牌的缩放：一摞四张码起来就这么大 */
const PILE_SCALE = 0.55;

/** 一排放两组摞，排满往桌心叠下一排——贴着角那一小块地盘就这么宽 */
const PILE_ROW = 2;

/** 往桌心最多叠两排：再多就原地挤出一丝边缝，一家独吞时摞不会爬到别家地盘上 */
const PILE_MAX_ROWS = 2;

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

/** 摊开最多排几排：再多一排就顶到桌面那一墩上，看牌不能把牌桌盖了 */
const HS_ROWS = 3;

/** 摊开时两张牌的圆心距（乘牌径），大于 1 才互不遮挡、每张各自点得着 */
const HS_GAP = 1.06;

/** 按钮条按两行量（窄屏三个分牌按钮必折行，和布局测试同一口径）：摊开不许顶进它 */
const BTN_ROWS = 2;
const BTN_H = 40;
const BTN_GAP = 6;

/** 摊开手牌能吃的那块地：底边名字条以上、按钮条以下 */
export function handBand(board: Board): { top: number; bottom: number } {
  return {
    top: board.h - ctrlLift(board) - (BTN_ROWS * BTN_H + (BTN_ROWS - 1) * BTN_GAP),
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
 * 手牌摊开后的格子：每张各占一格、互不遮挡，从底边名字条上方往上排。
 * 先按原尺寸铺，铺不进 `HS_ROWS` 排就整排缩——宁可牌小一圈，也不许爬到桌面那一墩上盖住别人的牌。
 * 返回的是**未缩放方框的左上角**（和 `layout` 的 Placed 同一口径）和该用的 `scale`。
 */
export function handSpread(n: number, board: Board): { x: number; y: number; scale: number }[] {
  const full = pieceSize(board);
  const band = handBand(board);
  const room = handRoom(full, board);
  const stepFull = full * HS_GAP;
  const colsFit = Math.max(1, Math.floor(room / stepFull));
  // 排数取「铺得下的列数刚好用完」的最少排：能两排摆开就别挤三排，多一排就多盖一排桌面
  let rows = Math.min(HS_ROWS, Math.max(1, Math.ceil(n / colsFit)));
  let step = stepFull;
  // 原尺寸铺不进三排就整排缩：先按张数定几列，再看横向和纵向哪头先不够
  if (Math.ceil(n / colsFit) > HS_ROWS) {
    rows = HS_ROWS;
    step = Math.min(room / Math.ceil(n / rows), (band.bottom - band.top) / rows);
  }
  const cw = step / HS_GAP;
  const scale = Math.min(1, cw / full);
  const cols = Math.ceil(n / rows);
  const out: { x: number; y: number; scale: number }[] = [];
  for (let k = 0; k < n; k++) {
    const row = Math.floor(k / cols);
    const col = k % cols;
    // 最后一排往往铺不满，按这一排实际几张居中，别整排靠左
    const inRow = Math.min(cols, n - row * cols);
    const spanW = (inRow - 1) * step;
    out.push({
      x: board.w / 2 - spanW / 2 + col * step - full / 2,
      y: band.bottom - cw / 2 - row * step - full / 2,
      scale,
    });
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
 * 一块收牌地盘能吃多深：沿边铺开那一长条（两组 + 同摞错开 + 溢出排挤的边缝 + 最外那张牌）
 * 和往桌心叠到 `PILE_MAX_ROWS` 排，两个方向取大。名字条贴边、别家让位都按这个数算，别靠肉眼估。
 */
export function pileDepth(cw: number): number {
  const u = cw * PILE_SCALE;
  const along = u * (1.7 * (PILE_ROW - 1) + (0.16 + 0.08) * (PILE_SIZE - 1) + 1);
  const inward = u * (1.85 * (PILE_MAX_ROWS - 1) + 0.24 * (PILE_SIZE - 1) + 1);
  return Math.max(along, inward);
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
 * 4 人局里 P2 不贴左下角（那条边整个归你，摆在那儿只会被当成你的牌），改成挂在 P3 那排摞底下、
 * 顺着左边往下数第一个空位。
 */
export function labelBands(players: number, board: Board): { seat: number; x: number; y: number; w: number; h: number }[] {
  const band = (x: number, y: number, seat: number) => ({ seat, x, y, w: LABEL_W, h: LABEL_H });
  const top = LABEL_TOP;
  const bottom = board.h - LABEL_H - LABEL_BOTTOM;
  const left = LABEL_X;
  const right = board.w - LABEL_W - LABEL_X;
  if (players === 2) return [band(right, bottom, 0), band(left, top, 1)];
  return [band(right, bottom, 0), band(left, topBand(board) + LABEL_GAP, 1), band(left, top, 2), band(right, top, 3)];
}

/** 摆摞阶段的几何：8 摞在哪、多大，摆牌的和那一排的领地用同一套常数 */
function draftGeom(board: Board) {
  const cw = pieceSize(board);
  const gap = cw * 1.16;
  return { cw, gap, x0: board.w / 2 - (gap * (STACKS - 1)) / 2, y0: board.h * 0.42 };
}

/** 抽出来展示这张放大这么多：整桌就它一张在讲点数，得比摞里的牌明显大一圈 */
const LIFT_SCALE = 1.3;

/** 每摞的领地（桌面像素坐标）：按摊开后的整列算。鼠标进这一块就把那摞摊开，「第 N 摞」标签也挂在这儿。
 *  点击目标不是它——摊开之后摞里每一张各是一个目标，点哪张抽哪张。 */
export function stackSpots(board: Board): { x: number; y: number; w: number; h: number }[] {
  const { cw, gap, x0, y0 } = draftGeom(board);
  return Array.from({ length: STACKS }, (_, i) => ({
    x: x0 + i * gap - cw * 0.56,
    y: y0 - cw * (SPREAD * 3 + 0.16),
    w: cw * 1.12,
    h: cw * (SPREAD * 3 + 1.32),
  }));
}

/** 棋子直径：8 摞横排要塞得下，短边还得留出手牌和出牌区 */
export function pieceSize(board: Board): number {
  return Math.max(20, Math.min(board.w / (STACKS * 1.16), board.h * 0.4 / 4, 56));
}

interface Point {
  x: number;
  y: number;
}

/** 从桌子中心指向这个座位的单位向量，出牌区和牌摞都靠它外推 */
function dir(seat: number, players: number): Point {
  if (players === 2) return seat === 0 ? { x: 0, y: 1 } : { x: 0, y: -1 };
  return [{ x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }][seat]!;
}

/**
 * 座位锚点：0 号永远在下方正中（他的牌摊成扇形），其余三家贴自己那条边。
 * 另一头也不再居中——各朝自己右手边那个角偏过去（P2 偏下、P3 偏左、P4 偏上），
 * 三家都压在中轴上就等于挤在桌心，出的牌反而没地方摆。
 */
function seatAnchor(seat: number, players: number, board: Board, cw: number): Point {
  const inset = cw * 1.6;
  if (seat === 0) return { x: board.w / 2, y: board.h - inset };
  if (players === 2) return { x: board.w / 2, y: inset };
  if (seat === 1) return { x: inset, y: board.h * 0.62 };
  if (seat === 3) return { x: board.w - inset, y: board.h * 0.38 };
  return { x: board.w * 0.34, y: inset };
}

/** P2（4 人局坐左手边那家）名字条的 y：挂在顶边那条带底下，收牌摞紧贴着它往下排 */
function sideLabelY(board: Board): number {
  return topBand(board) + LABEL_GAP;
}

/**
 * 收牌摞长在哪：各家的**右手边那个角**（南家的右手在屏幕右、西家在下、北家在左、东家在上），
 * 从那个角沿边排开、排满了往桌心叠第二排。名字条就贴在同一个角下面。
 * 4 人局的 P2 是唯一的例外：底边那一条整个是你的地盘（扇形铺满），摞摆左下角会被读成你的牌，
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

function pileGeom(seat: number, players: number, board: Board, cw: number): PileGeom {
  const s = cw * 0.62;
  // 牌缩放到 PILE_SCALE 后四周各空 (cw-w)/2，锚点补回这 0.05cw，摞沿就正好压在顶/底那一长条的边上
  const below = LABEL_TOP + LABEL_H + LABEL_GAP + cw * 0.05;
  const above = board.h - bottomBand(board) + cw * 0.05;
  // 2 人局对面坐北，右手边＝左上角
  if (players === 2) {
    return seat === 0
      ? { x: board.w - s, y: above, alongX: true, sa: -1, si: -1 }
      : { x: s, y: below, alongX: true, sa: 1, si: 1 };
  }
  if (seat === 0) return { x: board.w - s, y: above, alongX: true, sa: -1, si: -1 };
  if (seat === 1) return { x: s, y: sideLabelY(board) + LABEL_H + LABEL_GAP + cw * 0.05, alongX: false, sa: 1, si: 1 };
  if (seat === 2) return { x: s, y: below, alongX: true, sa: 1, si: 1 };
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

  if (state.phase === 'draft' && state.draft) {
    const draft = state.draft;
    const { gap, x0, y0 } = draftGeom(board);
    // 「选中/抽出」这两拍要把别家那七摞压到后面去，正在演的那一摞不参与
    const focus = view.pick !== null || view.lift !== null;
    draft.stacks.forEach((stack, i) => {
      const hot = view.hover === i;
      stack.forEach((id, depth) => {
        // 摞口朝下数：数组末尾那张是摞口（不指定时引擎抽的就是它），所以它落在最下面那格、紧挨那一排，
        // 摊开和抽牌都是「从摞口揭走一张」的视角，而不是从整列最高点飞下来
        const slot = stack.length - 1 - depth;
        const spread = hot ? SPREAD : 0.11;
        const x = x0 + i * gap - cw / 2 - (hot ? 0 : (slot - 1.5) * cw * 0.04);
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
          rot: hot ? 0 : (slot - 1.5) * 1.4,
          cls,
        });
      });
    });
    return out;
  }

  // 收牌摞：四张码一摞，各家长在自家那块地盘上，一排两组、排满往桌心叠一排，同摞内逐张错开好数张数。
  // 叠到 `PILE_MAX_ROWS` 排就封顶，后面的摞原地挤一点边缝——一家独吞也不会把摞爬到别家那边。
  const u = cw * PILE_SCALE;
  for (let seat = 0; seat < state.players; seat++) {
    const g = pileGeom(seat, state.players, board, cw);
    const ids = view.piles[seat] ?? [];
    ids.forEach((id, k) => {
      const group = Math.floor(k / PILE_SIZE);
      const depth = k % PILE_SIZE;
      const row = Math.floor(group / PILE_ROW);
      const along = (group % PILE_ROW) * u * 1.7 + depth * u * 0.16 + Math.max(0, row - (PILE_MAX_ROWS - 1)) * u * 0.08;
      const inward = Math.min(row, PILE_MAX_ROWS - 1) * u * 1.85 + depth * u * 0.24;
      put(id, {
        x: g.x + (g.alongX ? g.sa * along : g.si * inward) - u / 2,
        y: g.y + (g.alongX ? g.si * inward : g.sa * along) - u / 2,
        scale: PILE_SCALE,
        z: 100 + seat * 40 + group * 8 + depth,
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
    const d = dir(play.seat, state.players);
    const a = seatAnchor(play.seat, state.players, board, cw);
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
      // 摊开态：整块压过桌面和收牌摞，选完收回扇形——所以 z 给到全桌最高
      const spots = view.spread ? handSpread(fans.length, board) : null;
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
      const a = seatAnchor(seat, state.players, board, cw);
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
