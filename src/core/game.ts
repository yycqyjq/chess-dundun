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
  draft: { stackSize: number; ways: AllocWay[] };
  /** 按人数落定的那一档覆盖；没有覆盖的人数直接用上面那份 */
  variants?: PlayerVariant[];
}

/** 处置人定的三种分牌规则：层层轮流分 / 整摞轮流拿（从左起 / 从右起） */
export type AllocWay = 'layered' | 'stacks-left' | 'stacks-right';

/** 三种拿法的全集，规则表里写的 `ways` 只能是它的子集 */
export const ALL_WAYS: readonly AllocWay[] = ['layered', 'stacks-left', 'stacks-right'];

/**
 * 某一档人数的牌组与发牌覆盖。枚数是**替换**不是增减（`"兵卒": [4, 4]` 就是这一级黑四枚红四枚），
 * 省得「减几枚」这种事要在两处对账。
 */
export interface PlayerVariant {
  players: number;
  note?: string;
  /** 职级名 → 这一档的 [黑, 红] 枚数 */
  ranks?: Record<string, [number, number]>;
  draft?: { stackSize?: number; ways?: AllocWay[] };
}

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
  plays: { seat: number; pieceIds: number[] }[];
  discards: { seat: number; pieceIds: number[] }[];
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

function checkDraft(draft: { stackSize: number; ways: AllocWay[] }, at: string): void {
  if (!Number.isInteger(draft.stackSize) || draft.stackSize < 1)
    throw new Error(`rules.json：${at} 的一摞张数得是个正整数，写的是 ${draft.stackSize}`);
  if (!Array.isArray(draft.ways) || draft.ways.length === 0)
    throw new Error(`rules.json：${at} 的 ways 至少得留一种拿法，否则处置人那一步没人能落子`);
  for (const way of draft.ways)
    if (!ALL_WAYS.includes(way))
      throw new Error(`rules.json：${at} 写了「${way}」，拿法只有 ${ALL_WAYS.join(' / ')} 这三种`);
}

/** 发得平才算这套规则跑得起来：枚数除得尽家数、一摞张数除得尽家数（层层轮流分每摞要走完整圈），整摞拿还要求摞数除得尽家数 */
function checkDealt(total: number, draft: { stackSize: number; ways: AllocWay[] }, players: number, at: string): void {
  if (total % players !== 0) throw new Error(`rules.json：${at} 一共 ${total} 枚，${players} 人发不平`);
  if (draft.stackSize % players !== 0)
    throw new Error(
      `rules.json：${at} 一摞 ${draft.stackSize} 张分给 ${players} 家，层层轮流分每摞都要多出一截（一摞张数得是家数的整数倍）`,
    );
  if (draft.ways.some((way) => way !== 'layered') && (total / draft.stackSize) % players !== 0)
    throw new Error(
      `rules.json：${at} 一共 ${total / draft.stackSize} 摞分给 ${players} 家，整摞轮流拿会拿成不等张：要么改一摞张数，要么 ways 只留 layered`,
    );
}

/**
 * 规则表进引擎的唯一入口：谁读文件、谁 fetch、谁内联 JSON 都随调用方，core 不碰 fs。
 * rules.json 是给人手写改的，所以那些「改错了会静默不生效」的形状在这儿当场拒：
 * 职级名打错（那一档覆盖就白写）、人数没进 playerCounts（那档桌压根开不起来）、拿法名字写错、
 * 摞大小发不平。宁可开不起来念一句人话，也别抱着一副坏牌组打到中局。
 */
/**
 * 换玩法的那几枚开关，写错一个字符就静默走默认分支：改规则的人以为换了玩法，牌桌纹丝不动；
 * discardCost 填个「很像人话」的 'all' 更狠——Math.min(NaN,…) 让压不过的人凑不出抵押，整桌走到那步再也动不了。
 * 照这张表既有的红字风格当场拒，跟 checkDraft 同一个脾气：宁可开不起来念一句人话，也别抱着坏表打到中局。
 */
const TIE_BREAKS: readonly string[] = ['leader', 'later'];
const NEXT_LEADERS: readonly string[] = ['clockwise', 'trick-winner'];
const GROUP_COMPARES: readonly string[] = ['sameSize', 'sizeFirst', 'topTierFirst'];

/** 明暗两版比牌规则逐槽验。mode 在类型上必填，可 raw 是人手写的 JSON、运行时可能整个没写——先认存在性再验值 */
function checkModes(mode: ModeRules, at: string): void {
  if (!mode || typeof mode !== 'object')
    throw new Error(`rules.json：${at} 这一档的比牌规则没写（得是个对象，带 mustBeatIfAble、groupCompare、discardCost 三格）`);
  if (typeof mode.mustBeatIfAble !== 'boolean')
    throw new Error(`rules.json：${at}.mustBeatIfAble 得是 true 或 false，写的是 ${JSON.stringify(mode.mustBeatIfAble)}`);
  if (!GROUP_COMPARES.includes(mode.groupCompare))
    throw new Error(`rules.json：${at}.groupCompare 只有 ${GROUP_COMPARES.join(' / ')} 这三种，写的是「${mode.groupCompare}」`);
  if (!(mode.discardCost === 'same' || (Number.isInteger(mode.discardCost) && mode.discardCost >= 1)))
    throw new Error(
      `rules.json：${at}.discardCost 得是 'same'（对方几张抵几张）或正整数（固定弃几张，至少 1），写的是 ${JSON.stringify(mode.discardCost)}——填 0 会让压不过的人凑不出抵押那一步，整桌走到那儿就再也动不了`,
    );
}

export function parseRules(raw: Omit<Rules, 'ranks'> & { ranks: readonly RankFile[] }): Rules {
  const { ranks, ...rest } = raw;
  const rules: Rules = { ...rest, ranks: buildRanks(ranks) };
  if (!TIE_BREAKS.includes(rules.tieBreak))
    throw new Error(`rules.json：tieBreak（一样大算谁赢）只有 ${TIE_BREAKS.join(' / ')} 这两种，写的是「${rules.tieBreak}」`);
  if (!NEXT_LEADERS.includes(rules.nextLeader))
    throw new Error(`rules.json：nextLeader（下一墩谁先出）只有 ${NEXT_LEADERS.join(' / ')} 这两种，写的是「${rules.nextLeader}」`);
  checkModes(rules.mingqi, 'mingqi');
  checkModes(rules.kouqi, 'kouqi');
  for (const n of rules.playerCounts)
    if (!Number.isInteger(n) || n < 2)
      throw new Error(`rules.json：playerCounts 里的「${n}」不算一档人数（至少 2 人，且得是整数）`);
  checkDraft(rules.draft, '默认那一档');
  for (const v of rules.variants ?? []) {
    const at = `${v.players} 人那一档`;
    if (!rules.playerCounts.includes(v.players))
      throw new Error(`rules.json：${at} 的覆盖写了，可 playerCounts 里没有 ${v.players} 人——这张覆盖永远走不到`);
    const unknown = Object.keys(v.ranks ?? {}).filter((name) => !rules.ranks.some((r) => r.name === name));
    if (unknown.length)
      throw new Error(`rules.json：${at} 改的职级「${unknown.join('、')}」在这张表里不存在（职级名要照 ranks 里那个 name 写）`);
    for (const [name, count] of Object.entries(v.ranks ?? {}))
      if (!Array.isArray(count) || count.length !== 2 || !count.every((c) => Number.isInteger(c) && c >= 0))
        throw new Error(`rules.json：${at} 的「${name}」枚数得写成 [黑, 红] 两个非负整数`);
    if (v.draft) checkDraft({ stackSize: v.draft.stackSize ?? rules.draft.stackSize, ways: v.draft.ways ?? rules.draft.ways }, at);
  }
  for (const players of rules.playerCounts) {
    const eff = settle(rules, players);
    checkDealt(buildPieceSet(eff.ranks).length, eff.draft, players, `${players} 人那一档`);
  }
  return rules;
}

/**
 * 按人数把牌组枚数、一摞张数、能选哪几种拿法落定成「只这一档」那一份。
 * 落定要连档位清单一起收掉：`GameState.rules` 说的是一桌的牌怎么发，不再是那张给人手写的配置表。
 * 留着 `variants` 会出两件事：一是不再适用（覆盖已经吃进来了），二是这张表再进一次 `parseRules`
 * （线上快照、存档还原都走这一趟）会拿 3 人档的「一摞 3 张」去查 2 人档发不发得平，当场自己拒自己。
 */
function settle(rules: Rules, players: number): Rules {
  const v = rules.variants?.find((x) => x.players === players);
  const { variants: _applied, ...rest } = rules;
  return {
    ...rest,
    playerCounts: [players],
    ranks: rules.ranks.map((r) => (v?.ranks?.[r.name] ? { ...r, count: v.ranks[r.name]! } : r)),
    draft: { stackSize: v?.draft?.stackSize ?? rules.draft.stackSize, ways: v?.draft?.ways ?? rules.draft.ways },
  };
}

/**
 * 按人数落定的那一份规则——GameState 里存的就是它，往下比牌、发牌、界面念的数全出自同一份。
 * 校验已经在 parseRules 做过了，这儿只是替换，不再抛。
 */
export function rulesFor(rules: Rules, players: number): Rules {
  return settle(rules, players);
}

/**
 * 档位人数念成一句人话：`2、3 或 4`。
 * 拒人那句（命令行、开桌请求、改人数）都从这一处出口，三处各写各的 join 就会一个念「2 或 3 或 4 人」。
 */
export function countsText(playerCounts: number[]): string {
  const last = playerCounts[playerCounts.length - 1];
  if (playerCounts.length < 2) return `${last}`;
  return `${playerCounts.slice(0, -1).join('、')} 或 ${last}`;
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
  // 先按人数落定这一档的牌组枚数与摞大小，再铺牌——3 人局那两张减掉的兵卒就是在这儿生效的
  const rules = rulesFor(opts.rules, opts.players);
  const pieces = buildPieceSet(rules.ranks);
  const byId = new Map(pieces.map((p) => [p.id, p]));
  // 随机扣摞：只洗牌不分大小排序，摆好的牌堆本身不带任何可推算的信息
  const stacks = chunks(shuffled(pieces.map((p) => p.id), rng), rules.draft.stackSize);
  const drawer = opts.drawer ?? Math.floor(rng() * opts.players);
  return {
    rules,
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
  // 能选哪几种拿法归规则表（3 人局那一档只有「层层轮流分」：10 摞分 3 家，整摞拿必然不等张）
  return state.rules.draft.ways.map((way) => ({ kind: 'allocate', way }));
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
  // 摸签阶段这一摞全扣着，抽哪张的点数期望都一样，所以拆开热点不影响公平
  const drawn = pieceId ?? stack[stack.length - 1];
  const piece = state.byId.get(drawn)!;
  draft.stackIdx = stackIdx;
  draft.drawn = drawn;
  draft.decider = countTo(draft.drawer, piece.point, state.players);
  draft.stage = 'allocate';
  state.opening = { drawer: draft.drawer, stackIdx, pieceId: drawn, seat: draft.decider };
  state.log.push(
    `${seatName(draft.drawer)} 从第 ${stackIdx + 1} 摞抽到 ${label(state, drawn)}（${piece.point} 点，当场各家都看见，进手后跟着扣），从自己数到 ${seatName(draft.decider)}——这 ${draft.stacks.length} 摞怎么分归他定，第一轮也由他先出`,
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
    plays: [{ seat, pieceIds }],
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
  insertPlay(state, trick, { seat, pieceIds });
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
  const at = trick.plays.findIndex((p) => rank(p.seat) > rank(play.seat));
  if (at < 0) trick.plays.push(play);
  else trick.plays.splice(at, 0, play);
}

function applyDiscard(state: GameState, seat: number, pieceIds: number[]): GameState {
  take(state, seat, pieceIds);
  const trick = state.trick!;
  trick.discards.push({ seat, pieceIds });
  trick.waiting = trick.waiting.filter((s) => s !== seat);
  reveal(state, pieceIds);
  state.log.push(`${seatName(seat)} 大不过，弃 ${labels(state, pieceIds)}`);
  return maybeCloseTrick(state);
}

/** 明棋出牌即亮；暗棋扣着出，整墩打完才翻开 */
function reveal(state: GameState, pieceIds: number[]): void {
  if (state.mode === 'ming') for (const id of pieceIds) state.revealed.add(id);
}

/**
 * 亮不亮的唯一口径（逐张形式）。签牌只在摆牌那一段公开：draft 一清空它就跟着扣进手里。
 * 集合口径的单一出口在 view.ts 的 openSet（wire 快照与 viewFor 都走它）；写侧 reveal/maybeCloseTrick 决定谁进 revealed。
 */
export function isFaceDown(state: GameState, id: number): boolean {
  return !state.revealed.has(id) && state.draft?.drawn !== id;
}

function maybeCloseTrick(state: GameState): GameState {
  const trick = state.trick!;
  if (trick.waiting.length > 0) return state;
  trick.championIdx = resolveTrick(trick.plays, state.byId, trickCfg(state));
  const winner = trick.plays[trick.championIdx].seat;
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
