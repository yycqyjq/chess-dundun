import {
  buildPieceSet,
  buildRanks,
  pieceLabel,
  type Piece,
  type RankDef,
  type RankFile,
} from './pieces.ts';
import { mulberry32, shuffled } from './rng.ts';
import {
  beats,
  comparable,
  powerOf,
  resolveTrick,
  type PlayPower,
  type TrickConfig,
  type TrickPlay,
} from './trick.ts';

/** 一种玩法的比牌规则。明暗两版结构相同，只差 mustBeatIfAble */
export interface ModeRules {
  /** 明棋 true：手里有同张数且更大的必须出；暗棋 false：可以故意出小的 */
  mustBeatIfAble: boolean;
  groupCompare: 'sameSize' | 'sizeFirst' | 'topTierFirst';
  /** 'same' = 对方出几张你弃几张；数字 = 固定弃这么多张 */
  discardCost: number | 'same';
}

export interface Rules {
  name: string;
  note?: string;
  ranks: RankDef[];
  playerCounts: number[];
  modes: ('ming' | 'kou')[];
  /** leader = 一样大算先出那家赢；later = 一样大算后出的压过去 */
  tieBreak: 'leader' | 'later';
  /** clockwise = 每墩先出者按顺时针轮转；trick-winner = 上一墩最大的人先出 */
  nextLeader: 'clockwise' | 'trick-winner';
  mingqi: ModeRules;
  kouqi: ModeRules;
  draft: { stackSize: number };
}

/** 处置人定的三种分牌规则：层层轮流分 / 整摞轮流拿（从左起 / 从右起） */
export type AllocWay = 'layered' | 'stacks-left' | 'stacks-right';

export type Action =
  | { kind: 'draw'; stackIdx: number; pieceId?: number }
  | { kind: 'allocate'; way: AllocWay }
  | { kind: 'lead'; pieceIds: number[] }
  | { kind: 'follow'; pieceIds: number[] }
  | { kind: 'discard'; pieceIds: number[] }
  | { kind: 'noop' };

interface DraftState {
  stacks: number[][];
  /** 整局固定的起抽人：第一局随机，之后由上一局赢家担任 */
  drawer: number;
  stage: 'draw' | 'allocate';
  /** 抽的是哪一摞、翻开的是哪张。点数看完这张放回原摞，跟着这摞一起分 */
  stackIdx: number;
  drawn: number;
  /** 点数数到的处置人，也是第一轮先出的人 */
  decider: number;
}

interface TrickState {
  leader: number;
  /** 还没应战的人。明棋按这个顺序一家家来，扣棋里首出之后剩下的是一伙人同时暗出 */
  waiting: number[];
  championIdx: number;
  /** 永远按顺时针（从首出者数过去）排；扣棋并发时谁先落子都不改这个次序 */
  plays: { player: number; pieceIds: number[] }[];
  discards: { player: number; pieceIds: number[] }[];
}

export interface GameState {
  rules: Rules;
  mode: 'ming' | 'kou';
  players: number;
  pieces: Piece[];
  byId: Map<number, Piece>;
  hands: number[][];
  won: number[];
  phase: 'draft' | 'ming' | 'kou' | 'over';
  draft: DraftState | null;
  trick: TrickState | null;
  leader: number;
  /** 本局起抽人：整局定死，发完牌也留着——跨局驱动靠它算下一局谁起抽 */
  drawer: number;
  /** 全局唯一一抽：谁抽的、抽的哪摞、翻出哪张、点数数到了谁 */
  opening: { drawer: number; stackIdx: number; pieceId: number; seat: number } | null;
  /** 永久摊在明处的牌：明棋出过的 + 每墩翻开结算的。签牌不算在这儿，它只在摆牌阶段公开，见 isFaceDown */
  revealed: Set<number>;
  rng: () => number;
  log: string[];
  seed: number;
}

/** 规则表进引擎的唯一入口：谁读文件、谁 fetch、谁内联 JSON 都随调用方，core 不碰 fs */
export function parseRules(raw: Omit<Rules, 'ranks'> & { ranks: readonly RankFile[] }): Rules {
  const { ranks, ...rest } = raw;
  return { ...rest, ranks: buildRanks(ranks) };
}

export function createGame(opts: {
  rules: Rules;
  players: number;
  mode: 'ming' | 'kou';
  seed: number;
  /** 本局起抽人。省略则随机——真实流程是第一局随机、之后由上一局赢家起抽 */
  drawer?: number;
}): GameState {
  const rng = mulberry32(opts.seed);
  const pieces = buildPieceSet(opts.rules.ranks);
  const byId = new Map(pieces.map((p) => [p.id, p]));
  // 随机扣摞：只洗牌不分大小排序，摆好的牌堆本身不带任何可推算的信息
  const stacks = chunks(shuffled(pieces.map((p) => p.id), rng), opts.rules.draft.stackSize);
  const drawer = opts.drawer ?? Math.floor(rng() * opts.players);
  return {
    rules: opts.rules,
    mode: opts.mode,
    players: opts.players,
    pieces,
    byId,
    hands: Array.from({ length: opts.players }, () => []),
    won: Array.from({ length: opts.players }, () => 0),
    phase: 'draft',
    draft: {
      stacks,
      drawer,
      stage: 'draw',
      stackIdx: -1,
      drawn: -1,
      decider: -1,
    },
    trick: null,
    leader: -1,
    drawer,
    opening: null,
    revealed: new Set<number>(),
    rng,
    log: [],
    seed: opts.seed,
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function label(state: GameState, id: number): string {
  return pieceLabel(state.byId.get(id)!);
}

function labels(state: GameState, ids: number[]): string {
  return ids.map((id) => label(state, id)).join('+');
}

/** 点数：抽到几就从起抽人自己开始数几，数到谁就是谁（红黑同点，只看职级） */
function countTo(drawer: number, point: number, players: number): number {
  return (drawer + point - 1) % players;
}

/** 当前模式（明/暗）的那一套比牌规则 */
export function modeRules(state: GameState): ModeRules {
  return state.mode === 'kou' ? state.rules.kouqi : state.rules.mingqi;
}

function trickCfg(state: GameState): TrickConfig {
  return { tieBreak: state.rules.tieBreak, groupCompare: modeRules(state).groupCompare };
}

export function championPower(state: GameState): PlayPower | null {
  const trick = state.trick;
  if (!trick || trick.plays.length === 0) return null;
  return powerOf(trick.plays[trick.championIdx].pieceIds, state.byId);
}

/**
 * 此刻能动手的人。
 * 扣棋里首出之后其余几家是同时暗出，所以这是一伙人；明棋和摆牌阶段每次只有一个。
 */
export function pendingSeats(state: GameState): number[] {
  if (state.phase === 'draft') {
    const draft = state.draft!;
    return [draft.stage === 'draw' ? draft.drawer : draft.decider];
  }
  if (state.phase === 'over') return [];
  if (!state.trick) return [state.leader];
  return state.mode === 'kou' ? [...state.trick.waiting] : state.trick.waiting.slice(0, 1);
}

/** 当前该行动的人：并发时取第一个，命令行那种「一家一家问」的驱动照旧用它 */
export function currentActor(state: GameState): number | null {
  return pendingSeats(state)[0] ?? null;
}

export function legalActions(state: GameState, seat: number): Action[] {
  if (state.phase === 'draft') return draftActions(state, seat);
  if (state.phase === 'over') return [];
  const hand = state.hands[seat];
  if (state.trick === null) {
    if (seat !== state.leader) return [];
    if (hand.length === 0) return [{ kind: 'noop' }];
    return [...singlePlays(hand), ...groupPlays(state, hand)].map((p) => ({ kind: 'lead', pieceIds: p.pieceIds }));
  }
  if (!state.trick.waiting.includes(seat)) return [];
  return followActions(state, seat);
}

function singlePlays(hand: number[]): { pieceIds: number[] }[] {
  return hand.map((id) => ({ pieceIds: [id] }));
}

/** 同职可以凑成组出（2 张到手里有几张为止），成组不是必须的、拆开单出也行。默认要求同色，只有将/帅这级放开 */
function groupPlays(state: GameState, hand: number[]): { pieceIds: number[] }[] {
  const buckets = new Map<string, number[]>();
  for (const id of hand) {
    const piece = state.byId.get(id)!;
    const sameColor = state.rules.ranks[piece.rank].groupColors !== 'any';
    const key = sameColor ? `${piece.rank}:${piece.color}` : `${piece.rank}`;
    buckets.set(key, [...(buckets.get(key) ?? []), id]);
  }
  const out: { pieceIds: number[] }[] = [];
  for (const ids of buckets.values()) {
    for (const subset of subsetsLargerThanOne(ids)) out.push({ pieceIds: subset });
  }
  return out;
}

function subsetsLargerThanOne(ids: number[]): number[][] {
  const out: number[][] = [];
  for (let mask = 1; mask < 1 << ids.length; mask++) {
    const picked = ids.filter((_, i) => (mask >> i) & 1);
    if (picked.length > 1) out.push(picked);
  }
  return out;
}

function followActions(state: GameState, seat: number): Action[] {
  const cfg = trickCfg(state);
  const rules = modeRules(state);
  const champion = championPower(state)!;
  const hand = state.hands[seat];
  const plays = [...singlePlays(hand), ...groupPlays(state, hand)];
  // 张数对不上就摆不上桌面（sameSize 这版规则下等价于「必须应同张数」）
  const eligible = plays
    .map((play) => play.pieceIds)
    .filter((pieceIds) => comparable(powerOf(pieceIds, state.byId), champion, cfg));
  const winning = eligible.filter((pieceIds) => beats(powerOf(pieceIds, state.byId), champion, cfg));
  // 明棋：有更大的必须出（拆对也得出），出不了才抵押。暗棋：张数对得上就必须出，出大出小随意
  const forced = rules.mustBeatIfAble ? winning : eligible;
  if (forced.length > 0) return forced.map((pieceIds) => ({ kind: 'follow' as const, pieceIds }));
  const cost = Math.min(rules.discardCost === 'same' ? champion.size : rules.discardCost, hand.length);
  return cost === 0 ? [] : combinations(hand, cost).map((pieceIds) => ({ kind: 'discard' as const, pieceIds }));
}

function combinations(items: number[], size: number): number[][] {
  if (size === 1) return items.map((x) => [x]);
  const out: number[][] = [];
  for (let i = 0; i < items.length; i++) {
    for (const rest of combinations(items.slice(i + 1), size - 1)) out.push([items[i], ...rest]);
  }
  return out;
}

function draftActions(state: GameState, seat: number): Action[] {
  const draft = state.draft!;
  if (draft.stage === 'draw') {
    return draft.drawer === seat ? draft.stacks.map((_, stackIdx) => ({ kind: 'draw', stackIdx })) : [];
  }
  if (draft.decider !== seat) return [];
  const ways: AllocWay[] = ['layered', 'stacks-left', 'stacks-right'];
  return ways.map((way) => ({ kind: 'allocate', way }));
}

export function apply(state: GameState, seat: number, action: Action): GameState {
  switch (action.kind) {
    case 'draw':
      return applyDraw(state, action.stackIdx, action.pieceId);
    case 'allocate':
      return applyAllocate(state, action.way);
    case 'noop':
      state.leader = nextWithCards(state, seat);
      return state;
    case 'lead':
      return applyLead(state, seat, action.pieceIds);
    case 'follow':
      return applyFollow(state, seat, action.pieceIds);
    case 'discard':
      return applyDiscard(state, seat, action.pieceIds);
  }
}

function applyDraw(state: GameState, stackIdx: number, pieceId?: number): GameState {
  const draft = state.draft!;
  const stack = draft.stacks[stackIdx];
  // 界面上点哪张抽哪张；CLI 和 AI 都不传 pieceId，永远抽摞口那张。
  // 摸签阶段四张全扣着，抽哪张的点数期望都一样，所以拆开热点不影响公平
  const drawn = pieceId ?? stack[stack.length - 1];
  const piece = state.byId.get(drawn)!;
  draft.stackIdx = stackIdx;
  draft.drawn = drawn;
  draft.decider = countTo(draft.drawer, piece.point, state.players);
  draft.stage = 'allocate';
  state.opening = { drawer: draft.drawer, stackIdx, pieceId: drawn, seat: draft.decider };
  state.log.push(
    `${seatName(draft.drawer)} 从第 ${stackIdx + 1} 摞抽到 ${label(state, drawn)}（${piece.point} 点，当场各家都看见，进手后跟着扣），从自己数到 ${seatName(draft.decider)}——这 8 摞怎么分归他定，第一轮也由他先出`,
  );
  return state;
}

function applyAllocate(state: GameState, way: AllocWay): GameState {
  const draft = state.draft!;
  if (way === 'layered') {
    for (const stack of draft.stacks) {
      let seat = draft.decider;
      // 一摞从摞口那张开始，一人一张，每摞都从处置人起数
      for (const id of [...stack].reverse()) {
        state.hands[seat].push(id);
        seat = (seat + 1) % state.players;
      }
    }
    state.log.push(`${seatName(draft.decider)} 定：层层轮流分，从自己开始顺时针一人一张`);
  } else {
    const order = way === 'stacks-left' ? draft.stacks.map((_, i) => i) : draft.stacks.map((_, i) => i).reverse();
    order.forEach((stackIdx, step) => {
      const seat = (draft.decider + step) % state.players;
      state.hands[seat].push(...draft.stacks[stackIdx]);
    });
    state.log.push(
      `${seatName(draft.decider)} 定：${way === 'stacks-left' ? '从左' : '从右'}开始一摞一摞轮流拿，自己先拿第 ${order[0] + 1} 摞`,
    );
  }
  state.draft = null;
  startPlay(state, draft.decider);
  return state;
}

function startPlay(state: GameState, firstLeader: number): void {
  state.phase = state.mode;
  state.leader = firstLeader;
  state.log.push(
    `发牌完毕：${state.hands.map((h, i) => `${seatName(i)} ${h.length} 枚`).join('，')}｜先出 ${seatName(firstLeader)}`,
  );
}

function applyLead(state: GameState, seat: number, pieceIds: number[]): GameState {
  take(state, seat, pieceIds);
  state.trick = {
    leader: seat,
    waiting: responseOrder(state, seat),
    championIdx: 0,
    plays: [{ player: seat, pieceIds }],
    discards: [],
  };
  reveal(state, pieceIds);
  state.log.push(`${seatName(seat)} 出 ${labels(state, pieceIds)}`);
  // 别人手里都没牌时 waiting 为空，这一墩当场结算，不然会卡死
  return maybeCloseTrick(state);
}

function responseOrder(state: GameState, leader: number): number[] {
  const out: number[] = [];
  for (let step = 1; step <= state.players; step++) {
    const seat = (leader + step) % state.players;
    if (seat !== leader && state.hands[seat].length > 0) out.push(seat);
  }
  return out;
}

function applyFollow(state: GameState, seat: number, pieceIds: number[]): GameState {
  take(state, seat, pieceIds);
  const trick = state.trick!;
  insertPlay(state, trick, { player: seat, pieceIds });
  trick.waiting = trick.waiting.filter((s) => s !== seat);
  reveal(state, pieceIds);
  // 扣棋是同时暗出：没出完之前桌上没有「当前最大」，判赢留到翻开那一刻一次算完
  trick.championIdx = state.mode === 'ming' ? resolveTrick(trick.plays, state.byId, trickCfg(state)) : 0;
  state.log.push(`${seatName(seat)} 压 ${labels(state, pieceIds)}`);
  return maybeCloseTrick(state);
}

/** plays 永远按顺时针（从首出者数过去）排，谁先落子都不改：并列就该靠前那家赢 */
function insertPlay(state: GameState, trick: TrickState, play: TrickPlay): void {
  const rank = (seat: number) => (seat - trick.leader + state.players) % state.players;
  const at = trick.plays.findIndex((p) => rank(p.player) > rank(play.player));
  if (at < 0) trick.plays.push(play);
  else trick.plays.splice(at, 0, play);
}

function applyDiscard(state: GameState, seat: number, pieceIds: number[]): GameState {
  take(state, seat, pieceIds);
  const trick = state.trick!;
  trick.discards.push({ player: seat, pieceIds });
  trick.waiting = trick.waiting.filter((s) => s !== seat);
  reveal(state, pieceIds);
  state.log.push(`${seatName(seat)} 大不过，弃 ${labels(state, pieceIds)}`);
  return maybeCloseTrick(state);
}

/** 明棋出牌即亮；暗棋扣着出，整墩打完才翻开 */
function reveal(state: GameState, pieceIds: number[]): void {
  if (state.mode === 'ming') for (const id of pieceIds) state.revealed.add(id);
}

/** 亮不亮的唯一口径。签牌只在摆牌那一段公开：draft 一清空它就跟着扣进手里 */
export function isFaceDown(state: GameState, id: number): boolean {
  return !state.revealed.has(id) && state.draft?.drawn !== id;
}

function maybeCloseTrick(state: GameState): GameState {
  const trick = state.trick!;
  if (trick.waiting.length > 0) return state;
  trick.championIdx = resolveTrick(trick.plays, state.byId, trickCfg(state));
  const winner = trick.plays[trick.championIdx].player;
  let gained = 0;
  for (const play of trick.plays) gained += play.pieceIds.length;
  for (const discard of trick.discards) gained += discard.pieceIds.length;
  state.won[winner] += gained;
  for (const p of [...trick.plays, ...trick.discards]) {
    for (const id of p.pieceIds) state.revealed.add(id);
  }
  state.log.push(
    `${state.mode === 'kou' ? '翻开：' : ''}本墩归 ${seatName(winner)}（${labels(state, trick.plays[trick.championIdx].pieceIds)}），收 ${gained} 枚`,
  );
  state.trick = null;
  state.leader =
    state.rules.nextLeader === 'clockwise'
      ? nextWithCards(state, trick.leader)
      : state.hands[winner].length > 0
        ? winner
        : nextWithCards(state, winner);
  if (state.hands.every((h) => h.length === 0)) finish(state);
  return state;
}

function nextWithCards(state: GameState, from: number): number {
  for (let step = 1; step <= state.players; step++) {
    const seat = (from + step) % state.players;
    if (state.hands[seat].length > 0) return seat;
  }
  return from;
}

function take(state: GameState, seat: number, pieceIds: number[]): void {
  const hand = state.hands[seat];
  for (const id of pieceIds) {
    const at = hand.indexOf(id);
    if (at >= 0) hand.splice(at, 1);
  }
}

/** 只比收牌数：必须全打完，摞数相同就是并列，不存在提前判定 */
export function finalRank(state: GameState): number[] {
  return [...state.won.keys()].sort((a, b) => state.won[b] - state.won[a]);
}

function finish(state: GameState): void {
  state.phase = 'over';
  state.trick = null;
  const best = Math.max(...state.won);
  const top = state.won.map((w, i) => (w === best ? seatName(i) : '')).filter(Boolean);
  const verdict =
    top.length > 1
      ? `${top.join('、')} 并列 ${best} 枚（下一局仍由 ${seatName(state.drawer)} 起抽）`
      : `胜者 ${top[0]}（下一局由他起抽）`;
  state.log.push(`结束：${state.won.map((w, i) => `${seatName(i)} ${w} 枚`).join('，')}｜${verdict}`);
}

export function seatName(seat: number): string {
  return `P${seat + 1}`;
}
