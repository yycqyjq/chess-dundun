import { parseRules, type Action, type AllocWay, type GameState, type Rules } from '../core/game.ts';
import type { MatchBook } from '../core/match.ts';
import { LEVELS, type Level } from '../ai/agent.ts';
import type { RankFile } from '../core/pieces.ts';
import type { Color, Piece } from '../core/pieces.ts';
import type { FoundRoom } from './discover.ts';

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
  /** 这一局归真人（开局那一刻定下的）。掉线被代打位仍是真人位，回来还接得上 */
  human: boolean;
  /** 人已经坐下，但这一局仍由电脑代打，下一局开局才归他——中途进来就站这个状态 */
  queued: boolean;
  /** 这台设备自己起的短代号，空串＝还没人报过。候场厅拿它分辨「哪把椅子是谁」 */
  nick: string;
}

/** 桌的两态：候场厅里等人开局，开局以后才真在打 */
export type TableStatus = 'waiting' | 'playing';

/** 演一拍要知道桌刚落了哪一手。这些信息快照里本来就有（谁出了哪几张 id），单独说一遍不算泄底 */
export type LastMove = { seat: number; action: Action };

/** 还没入座就能看见的那点事：几个位子、谁坐过、谁是房主、第几局、什么玩法、开没开局 */
export interface Lobby {
  players: number;
  hostSeat: number;
  gameNo: number;
  mode: 'ming' | 'kou';
  level: Level;
  seats: SeatInfo[];
  status: TableStatus;
}

/**
 * 座位表回给客户端时再附上「这桌在局域网里怎么够得着」。
 * 地址只有房主进程知道（它才清楚监听端口和这块网卡的 IP），所以由它拼，桌不管。
 */
export type Seats = Lobby & { lan: string[] };

export type ToHost =
  | { t: 'lobby' }
  | { t: 'join'; seat: number; token: string; nick?: string }
  | { t: 'act'; action: Action }
  /** 房主在候场厅按的那颗开始：头一局和下一局走同一扇门 */
  | { t: 'start' }
  /** 还在候场厅时改这桌的配置，只有房主说了算 */
  | { t: 'setup'; players?: number; mode?: 'ming' | 'kou'; level?: Level }
  /** 候场厅里把自己那把椅子还回去：坐错位、或者这桌要减人都得先走这一步 */
  | { t: 'stand' }
  /** 房主在候场厅清了这桌的账：局号回 1、跨局那本整本换新，椅子一张不动 */
  | { t: 'reset' }
  /** 寻一圈同网别的桌：浏览器发不了 UDP，这一趟由本机那个宿主代跑（口径见 src/net/discover.ts） */
  | { t: 'find' }
  | { t: 'ping'; at: number };

/** 这几张清单照着引擎里的联合类型列：多写一个合法值都不许，`check` 盯得住漏、盯得住多 */
const KINDS: readonly Action['kind'][] = ['draw', 'allocate', 'lead', 'follow', 'discard', 'noop'];
const WAYS: readonly AllocWay[] = ['layered', 'stacks-left', 'stacks-right'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 整数就是整数：`"1"` 和 `1` 在 Map 的键上是两把椅子，这个亏吃一次就够 */
function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

/** 出牌那一伙：张数得是真的有，空着的意思「不出一张」引擎压根不认 */
function isIds(v: unknown): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.every(isInt);
}

/**
 * 一句线上的话过一遍形：字段齐不齐、取值在不在列。回 `ToHost` 是认了，回一句话就是拒。
 * 这一道是「不合形的字节进不了权威状态」的唯一关口，原来两头都漏过：
 * `mode:"zzz"` 被原样写进 GameState（流程像扣棋、规则却按明棋那套走），
 * `seat:"1"` 让桌认下了椅子却把快照发给不存在的第 1 号位（Map 的键是字符串），
 * 而 `action:{}` 更干脆——`sameAction` 里 `[...undefined]` 抛出去就把房主整个进程带走。
 * 几个人、哪几种玩法以桌上那张规则表为准，电脑档位跟 AI 那份清单同源；
 * 出得出去哪一手仍归桌按 `legalActions` 判，这儿只管形状。
 */
export function checkHost(raw: unknown, seats: number, rules: Pick<Rules, 'modes' | 'playerCounts'>): ToHost | string {
  if (!isObj(raw)) return '说不清的一句话';
  switch (raw.t) {
    case 'lobby':
      return { t: 'lobby' };
    case 'start':
      return { t: 'start' };
    case 'stand':
      return { t: 'stand' };
    case 'find':
      return { t: 'find' };
    case 'reset':
      return { t: 'reset' };
    case 'ping':
      return typeof raw.at === 'number' && Number.isFinite(raw.at) ? { t: 'ping', at: raw.at } : 'ping 的那个数说不清';
    case 'join': {
      if (!isInt(raw.seat) || raw.seat < 0 || raw.seat >= seats) return `没这个座位：这桌只 ${seats} 把椅子`;
      if (typeof raw.token !== 'string') return '令牌得是一串字';
      if (raw.nick !== undefined && typeof raw.nick !== 'string') return '代号得是一串字';
      return { t: 'join', seat: raw.seat, token: raw.token, nick: raw.nick };
    }
    case 'setup': {
      const out: { players?: number; mode?: 'ming' | 'kou'; level?: Level } = {};
      if (raw.players !== undefined) {
        if (!isInt(raw.players) || !rules.playerCounts.includes(raw.players)) {
          return `这桌只能 ${rules.playerCounts.join(' 或 ')} 人`;
        }
        out.players = raw.players;
      }
      if (raw.mode !== undefined) {
        if (!oneOf(rules.modes, raw.mode)) return `没听过这种玩法：这桌只有 ${rules.modes.join('、')}`;
        out.mode = raw.mode;
      }
      if (raw.level !== undefined) {
        if (!oneOf(LEVELS, raw.level)) return '没听过这档电脑';
        out.level = raw.level;
      }
      return { t: 'setup', ...out };
    }
    case 'act': {
      const a = raw.action;
      if (!isObj(a) || !oneOf(KINDS, a.kind)) return '这一手说不出是什么';
      switch (a.kind) {
        case 'noop':
          return { t: 'act', action: { kind: 'noop' } };
        case 'draw': {
          if (!isInt(a.stackIdx) || a.stackIdx < 0) return '抽的那一摞说不清';
          if (a.pieceId === undefined) return { t: 'act', action: { kind: 'draw', stackIdx: a.stackIdx } };
          return isInt(a.pieceId)
            ? { t: 'act', action: { kind: 'draw', stackIdx: a.stackIdx, pieceId: a.pieceId } }
            : '抽的那张说不清';
        }
        case 'allocate':
          return oneOf(WAYS, a.way)
            ? { t: 'act', action: { kind: 'allocate', way: a.way } }
            : '没听过这种切法';
        default:
          return isIds(a.pieceIds)
            ? { t: 'act', action: { kind: a.kind, pieceIds: a.pieceIds } }
            : '出的张数不对';
      }
    }
    default:
      return '看不懂这句';
  }
}

export type ToClient =
  | ({ t: 'seats' } & Seats)
  | { t: 'welcome'; seat: number; token: string; status: TableStatus }
  | {
      t: 'state';
      seq: number;
      /** 桌自己是第几局。中途坐下的人得跟着桌报数，不能从「1」自己数 */
      gameNo: number;
      /** 跨局那本账只在桌上一本，随快照发下去：客户端自己攒一本，改人数、重连、中途入座随便哪条路都会分叉 */
      book: MatchBook;
      /** 候场厅里的快照一份牌都还没出；界面照这个决定画候场厅还是画牌桌 */
      status: TableStatus;
      view: WireState;
      acts: Action[];
      seats: SeatInfo[];
      maskFrom: number;
      last: LastMove | null;
    }
  | { t: 'reject'; why: string }
  /** 寻一圈的答话：空清单也得回，why 就是那句为什么空（AP 隔离、寻呼口占不住、刚寻过一轮） */
  | { t: 'rooms'; rooms: FoundRoom[]; why: string }
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
