import { parseRules, type Action, type GameState, type Rules } from '../core/game.ts';
import type { Level } from '../ai/agent.ts';
import type { RankFile } from '../core/pieces.ts';
import type { Color, Piece } from '../core/pieces.ts';

/**
 * 线上传的牌：公开过的才带字。
 * tier 和牌名是一一对应的，给 tier 就等于没打码——所以没公开的只剩一个 id。
 */
export type WirePiece = {
  id: number;
  label?: string;
  rank?: number;
  color?: Color;
  tier?: number;
  point?: number;
};

/** 规则表在线上的形状，跟 rules.json 一个模子，回来交给 parseRules 补 order */
export type WireRules = Omit<Rules, 'ranks'> & { ranks: RankFile[] };

/** 一份GameState里，除了牌面元数据，其余全是各家都看得见的结构 */
export interface WireState {
  seed: number;
  mode: 'ming' | 'kou';
  players: number;
  phase: 'draft' | 'ming' | 'kou' | 'over';
  leader: number;
  drawer: number;
  opening: { drawer: number; stackIdx: number; pieceId: number; seat: number } | null;
  rules: WireRules;
  pieces: WirePiece[];
  hands: number[][];
  won: number[];
  draft: {
    stacks: number[][];
    drawer: number;
    stage: 'draw' | 'allocate';
    stackIdx: number;
    drawn: number;
    decider: number;
  } | null;
  trick: {
    leader: number;
    waiting: number[];
    championIdx: number;
    plays: { player: number; pieceIds: number[] }[];
    discards: { player: number; pieceIds: number[] }[];
  } | null;
  revealed: number[];
  /** 已经能给这个座位看的日志行，暗棋没翻开的那几行压根不上线 */
  log: string[];
}

/** 一个座位现在的处境，名字条要画这些 */
export interface SeatInfo {
  seat: number;
  name: string;
  /** 连着没 */
  online: boolean;
  /** 这把椅子被人坐过：令牌不对就回不来，也没法再坐 */
  taken: boolean;
  /** 这一手的牌由桌代发 */
  ai: boolean;
}

/** 演一拍要知道桌刚落了哪一手。这些信息快照里本来就有（谁出了哪几张 id），单独说一遍不算泄底 */
export type LastMove = { seat: number; action: Action };

/** 还没入座就能看见的那点事：几个位子、谁坐过、谁是房主、第几局、什么玩法 */
export interface Lobby {
  players: number;
  hostSeat: number;
  gameNo: number;
  mode: 'ming' | 'kou';
  level: Level;
  seats: SeatInfo[];
}

/**
 * 座位表回给客户端时再附上「这桌在局域网里怎么够得着」。
 * 地址只有房主进程知道（它才清楚监听端口和这块网卡的 IP），所以由它拼，桌不管。
 */
export type Seats = Lobby & { lan: string[] };

export type ToHost =
  | { t: 'lobby' }
  | { t: 'join'; seat: number; token: string }
  | { t: 'act'; action: Action }
  | { t: 'next' }
  | { t: 'ping'; at: number };

export type ToClient =
  | ({ t: 'seats' } & Seats)
  | { t: 'welcome'; seat: number; token: string; host: string }
  | {
      t: 'state';
      seq: number;
      /** 桌自己是第几局。中途坐下的人得跟着桌报数，不能从「1」自己数 */
      gameNo: number;
      view: WireState;
      acts: Action[];
      seats: SeatInfo[];
      maskFrom: number;
      last: LastMove | null;
    }
  | { t: 'reject'; why: string }
  | { t: 'pong'; at: number };

/** 一张牌公开了没。口径跟引擎的 isFaceDown 一致，不另起一套 */
function publicIds(state: GameState): Set<number> {
  const open = new Set<number>(state.revealed);
  if (state.draft && state.draft.drawn >= 0) open.add(state.draft.drawn);
  return open;
}

/**
 * 打码：把权威状态降成「这个座位只配看见的东西」。
 * hands / trick / draft 里的 id 照发——id 本身不携带任何信息，知道「第 17 号在 P3 手里」
 * 也猜不出它是车是卒，这正是记牌本来该有的信息量。
 */
export function snapshotFor(state: GameState, seat: number, logUpTo: number): WireState {
  const open = publicIds(state);
  // 自己的手牌永远亮着
  for (const id of state.hands[seat]) open.add(id);
  // 自己这一墩摊在桌上的那套也亮着：单机版里鼠标压上去就能看见自己扣着出的牌，联机不能少这一口
  const trick = state.trick;
  if (trick) {
    for (const p of [...trick.plays, ...trick.discards]) {
      if (p.player !== seat) continue;
      for (const id of p.pieceIds) open.add(id);
    }
  }
  return build(state, open, logUpTo);
}

/** 桌自己存档用的那份：全公开，恢复出来才是一副完整的牌 */
export function fullWire(state: GameState): WireState {
  return build(state, new Set(state.pieces.map((p) => p.id)), state.log.length);
}

function build(state: GameState, open: Set<number>, logUpTo: number): WireState {
  return {
    seed: state.seed,
    mode: state.mode,
    players: state.players,
    phase: state.phase,
    leader: state.leader,
    drawer: state.drawer,
    opening: state.opening,
    rules: dropOrder(state.rules),
    pieces: state.pieces.map((p) =>
      open.has(p.id) ? { id: p.id, label: p.label, rank: p.rank, color: p.color, tier: p.tier, point: p.point } : { id: p.id },
    ),
    hands: state.hands.map((h) => [...h]),
    won: [...state.won],
    draft: state.draft ? { ...state.draft, stacks: state.draft.stacks.map((s) => [...s]) } : null,
    trick: state.trick
      ? {
          leader: state.trick.leader,
          waiting: [...state.trick.waiting],
          championIdx: state.trick.championIdx,
          plays: state.trick.plays.map((p) => ({ player: p.player, pieceIds: [...p.pieceIds] })),
          discards: state.trick.discards.map((p) => ({ player: p.player, pieceIds: [...p.pieceIds] })),
        }
      : null,
    revealed: [...state.revealed],
    log: state.log.slice(0, logUpTo),
  };
}

function dropOrder(rules: Rules): WireRules {
  return { ...rules, ranks: rules.ranks.map(({ order: _order, ...rest }) => rest as RankFile) };
}

/** 没公开的牌一读就炸——和 view.piece() 同一个脾气，越界查看不作弊靠结构拦着 */
function sealed(id: number): Piece {
  const boom = () => {
    throw new Error(`第 ${id} 号牌线上没给，客户端不许看它的牌面`);
  };
  return new Proxy({ id } as Piece, {
    get: (_t, key) => (key === 'id' ? id : boom()),
    has: () => false,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
}

/** 还原成 board.ts / app.ts 直接能使的 GameState；rng 不给，客户端压根没有掷骰子的份 */
export function hydrate(raw: WireState): GameState {
  const pieces = raw.pieces.map((p) => (p.label === undefined ? sealed(p.id) : (p as Piece)));
  const byId = new Map<number, Piece>(pieces.map((p) => [p.id, p]));
  return {
    rules: parseRules(raw.rules),
    mode: raw.mode,
    players: raw.players,
    pieces,
    byId,
    hands: raw.hands.map((h) => [...h]),
    won: [...raw.won],
    phase: raw.phase,
    draft: raw.draft ? { ...raw.draft, stacks: raw.draft.stacks.map((s) => [...s]) } : null,
    trick: raw.trick ? { ...raw.trick } : null,
    leader: raw.leader,
    drawer: raw.drawer,
    opening: raw.opening,
    revealed: new Set(raw.revealed),
    rng: () => {
      throw new Error('联机时随机数只在桌上，客户端不掷骰子');
    },
    log: [...raw.log],
    seed: raw.seed,
  };
}

/** 给 DOM 用的牌面表：没公开的留白字，翻开时 Pieces.paint() 补上去 */
export function deckFor(raw: WireState): Piece[] {
  return raw.pieces.map(
    (p) =>
      ({
        id: p.id,
        label: p.label ?? '',
        rank: p.rank ?? 0,
        color: p.color ?? 'red',
        tier: p.tier ?? 0,
        point: p.point ?? 0,
      }) as Piece,
  );
}
