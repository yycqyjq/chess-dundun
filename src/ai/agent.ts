import type { Action } from '../core/game.ts';
import { beats, type TrickConfig } from '../core/trick.ts';
import type { View } from '../core/view.ts';

export type Level = 'easy' | 'greedy' | 'hard';

export const LEVELS: Level[] = ['easy', 'greedy', 'hard'];

/** 老手每次出手摊多少副牌：同一批摊牌喂给所有候选，候选之间的运气互相抵消，比出来的才是判断差 */
const SAMPLES = 32;
/** 残局深搜的门槛：各家手里剩牌不多于这个数，就把剩下的整局按摊牌推完再选（再往上单墩的账够用） */
const ROLLOUT_MAX_CARDS = 12;
/** 残局推演里候选并列时的微调：同样期望，先把这一墩拿到手的那条线略微优先（方差更小、主动权更早落地） */
const TIE_EPS = 1e-6;

/**
 * 只喂 View：AI 看得见多少，和真人屏幕上显示的完全一样。
 * 同分的走法攒起来随机挑一个，别永远取第一个——抽签、分牌全是同分。
 *
 * 三档的口径：
 * - 入门：合法着法里纯随机。
 * - 常手：省牌为底，认得「活牌」——档位压过所有未见过的牌的，领出去／跟出去都是白捡的墩，当场捡；
 *   其余照旧出最省的。不摊牌不算赢面，比入门会抓机会，比老手短视。
 * - 老手：领出和应战都按「按位置摊牌」算赢面——把没见过的牌按档位直方图随机摊到各个未知位置
 *   （别家暗出的几套、暗弃的几把、各家手里），一副牌结算一墩，采样均值就是赢面，再对
 *   「赢面 × 墩里张数」和「这套牌留在手里的价值」做期望比较。同一张牌不再既当威胁又留在池里被重复计。
 *   残局（各家剩牌 ≤ ROLLOUT_MAX_CARDS）再进一步：候选的账不在单墩上算，而是把这副摊牌剩下的墩
 *   一墩一墩推到底，谁的「总收牌期望」高谁当选——「赢这墩＝下一墩我先出」的连锁价值从这儿才进得了账。
 *   推演里别家走公开可知的省牌策略（明棋被逼着应就拿最大的那份试，暗棋随手抽），全程只吃 View。
 */
export function choose(view: View, actions: Action[], level: Level, rng: () => number): Action {
  if (actions.length === 0) throw new Error(`P${view.seat + 1} 无合法行动`);
  if (level === 'easy') return actions[Math.floor(rng() * actions.length)];
  const remaining = view.counts.reduce((a, b) => a + b, 0);
  const deep = level === 'hard' && remaining <= ROLLOUT_MAX_CARDS;
  const deals =
    level === 'hard' && (deep || actions.some((a) => a.kind === 'lead' || a.kind === 'follow'))
      ? makeDeals(view, rng, SAMPLES)
      : null;
  const candidates = deep ? pruneDiscards(view, actions) : actions;
  let tied: Action[] = [];
  let bestScore = Infinity;
  for (const action of candidates) {
    const score = scoreAction(view, action, level, deals, deep);
    if (score < bestScore) {
      tied = [action];
      bestScore = score;
    } else if (score === bestScore) {
      tied.push(action);
    }
  }
  return tied.length === 1 ? tied[0]! : tied[Math.floor(rng() * tied.length)]!;
}

/** 抵押的组合能多到几千种（C(16,5)），残局推演一份一份跑不起——按「丢的价值」只留最省的几份，
 *  它们的推演结果几乎一样，差的那点被采样噪声盖住 */
function pruneDiscards(view: View, actions: Action[]): Action[] {
  const discards = actions.filter((a) => a.kind === 'discard');
  if (discards.length <= 8) return actions;
  const rest = actions.filter((a) => a.kind !== 'discard');
  const kept = [...discards]
    .sort(
      (a, b) =>
        holdValue(view, (a as { pieceIds: number[] }).pieceIds) -
        holdValue(view, (b as { pieceIds: number[] }).pieceIds),
    )
    .slice(0, 8);
  return [...rest, ...kept];
}

function scoreAction(view: View, action: Action, level: Level, deals: Deal[] | null, deep: boolean): number {
  switch (action.kind) {
    // 牌堆随机扣着、没人看得见，所以抽哪摞、这一档允许的几种分法怎么选在信息上等值——不做偏好，交给同分随机
    case 'draw':
    case 'allocate':
    case 'noop':
      return 0;
    case 'discard':
      // 残局里弃哪几张，影响的是后面几墩谁跟谁碰——交给推演；中盘照旧丢最没用的
      if (level === 'hard' && deep && deals) return rolloutScore(view, action.pieceIds, deals, 'discard');
      return holdValue(view, action.pieceIds) + 0.01;
    case 'lead': {
      if (level === 'greedy') {
        // 常手：整套都是活牌（每张都压过所有未见过的牌）就是白捡的墩，捡墩最大的那份；没有才丢最省的
        const pot = action.pieceIds.length * view.players;
        if (allLive(view, action.pieceIds)) return -10000 - pot;
        return playCost(view, action.pieceIds);
      }
      if (deep && deals) return rolloutScore(view, action.pieceIds, deals, 'lead');
      // 老手中盘：领出也是一桩买卖——赢面 × 墩里能收的张数，对比这套牌留在手里的价值
      const rate = deals ? winRate(view, action.pieceIds, deals) : 0;
      return holdValue(view, action.pieceIds) - rate * (action.pieceIds.length * view.players);
    }
    case 'follow': {
      const cost = playCost(view, action.pieceIds);
      if (level === 'greedy') {
        // 常手暗棋跟牌：活牌压得住所有暗出（unseen 里没有同等以上），白捡的墩当场捡；
        // 明棋的候选本来就全是能压的，照旧出最省的
        if (view.mode === 'kou' && view.trick !== null) {
          const top = Math.max(...action.pieceIds.map((id) => view.piece(id).tier));
          if (top > unseenMaxTier(view)) return -10000 - potSize(view, action.pieceIds.length);
        }
        return cost;
      }
      if (deep && deals) return rolloutScore(view, action.pieceIds, deals, 'follow');
      // 老手中盘：抢下这一墩期望收几枚，对比这套牌留在手里还值几枚
      const rate = deals ? winRate(view, action.pieceIds, deals) : 0;
      return holdValue(view, action.pieceIds) - rate * potSize(view, action.pieceIds.length);
    }
  }
}

/** 未见过的牌里最高的一档：手里的牌比它高，桌面上就再没有人压得住它 */
function unseenMaxTier(view: View): number {
  let max = -1;
  view.unknownTiers.forEach((n, tier) => {
    if (n > 0 && tier > max) max = tier;
  });
  return max;
}

function allLive(view: View, ids: number[]): boolean {
  const max = unseenMaxTier(view);
  // 领出是我先出：同档并列也算我赢（tieBreak: leader）；别的口径下并列归先出那位，得严格更大
  const floor = view.cfg.tieBreak === 'leader' ? max : max + 1;
  return ids.every((id) => view.piece(id).tier > floor - 1);
}

function playCost(view: View, ids: number[]): number {
  let cost = ids.reduce((sum, id) => sum + view.piece(id).tier, 0);
  if (ids.length === 1 && breaksAPair(view, ids[0]!)) cost += 4;
  return cost;
}

function breaksAPair(view: View, id: number): boolean {
  const piece = view.piece(id);
  // 同职不同色凑不成组（groupColors:'any' 那几级除外），跟 groupPlays 的桶键同口径——
  // 以前只比职级，把一红一黑的两枚兵也当成对子，拆了白心疼
  const sameColor = !view.groupAny.has(piece.rank);
  return (
    view.hand.filter((other) => {
      const o = view.piece(other);
      return o.rank === piece.rank && (!sameColor || o.color === piece.color);
    }).length > 1
  );
}

/**
 * 这套牌留在手里的未来值，单位是枚：顶张约等于一整墩，兵卒约等于零。
 * 一墩正常收几张 = 我出几张 × 几家，所以拿它当尺度，墩大的地方才值得砸大牌。
 */
function holdValue(view: View, ids: number[]): number {
  const trickValue = ids.length * view.players;
  let strength = 0;
  for (const id of ids) {
    const piece = view.piece(id);
    strength += piece.tier / view.topTier;
    // 成组是能凑出来的大墩子，拆成单张出掉就没了
    if (ids.length === 1 && breaksAPair(view, id)) strength += 0.3;
  }
  return strength * trickValue;
}

/** 我出这套之后桌上还有几家要表态：墩里的牌就是这些份加起来 */
function potSize(view: View, k: number): number {
  const trick = view.trick;
  if (trick === null) return k * view.players;
  let pot = k;
  for (const play of trick.plays) pot += play.size;
  for (const discard of trick.discarded) pot += discard.size;
  return pot;
}

/** 一副摊好的牌：各未知位置各领到哪几档。只有档位没有牌 id——AI 本来就只配看到档位直方图 */
interface Deal {
  hiddenPlays: { seat: number; tiers: number[] }[];
  hiddenDiscards: number[][];
  hands: { seat: number; tiers: number[] }[];
}

/**
 * 把没见过的牌随机摊到各个未知位置：暗出的几套、暗弃的几把、其余各家手里
 * （含已经出过牌那几家的剩牌——池子要摊得一颗不剩，账才平）。
 * 摊完一副就能结算一墩（或把残局整局推完），采样均值就是这套牌的赢面。
 */
function makeDeals(view: View, rng: () => number, samples: number): Deal[] {
  const pool: number[] = [];
  view.unknownTiers.forEach((n, tier) => {
    for (let i = 0; i < n; i++) pool.push(tier);
  });
  const trick = view.trick;
  const hiddenPlays = trick
    ? trick.plays
        .filter((p) => p.seat !== view.seat && p.pieceIds.length === 0)
        .map((p) => ({ seat: p.seat, size: p.size }))
    : [];
  const hiddenDiscards = trick ? trick.discarded.filter((d) => d.pieceIds.length === 0).map((d) => d.size) : [];
  const hands = view.counts
    .map((n, seat) => ({ seat, n }))
    .filter((s) => s.seat !== view.seat && s.n > 0);

  // 各摊位份量加起来正好是活牌数：明棋垫牌反扣后，垫掉的死牌留在池尾不参与摊位——
  // 摊牌只从活牌里抽，账是平的（死牌的档位没人知道，留在池尾即是正确边际）
  const deals: Deal[] = [];
  for (let s = 0; s < samples; s++) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    let at = 0;
    const take = (n: number): number[] => pool.slice(at, (at += n));
    deals.push({
      hiddenPlays: hiddenPlays.map((p) => ({ seat: p.seat, tiers: take(p.size) })),
      hiddenDiscards: hiddenDiscards.map((n) => take(n)),
      hands: hands.map((h) => ({ seat: h.seat, tiers: take(h.n) })),
    });
  }
  return deals;
}

function winRate(view: View, mine: number[], deals: Deal[]): number {
  let wins = 0;
  for (const deal of deals) if (sampleWin(view, mine, deal)) wins++;
  return wins / deals.length;
}

/**
 * 一副牌摊完之后，这套牌是不是这一墩的赢家。结算口径与引擎同一套（trick.ts 的 beats）：
 * 按先出序一圈比过去，同档算先出的赢（tieBreak: leader），后出的要严格更大才翻得了盘。
 * 应战那几家的出法是个建模选择：明棋被规则逼着「有更大的必出」，拿它最大的那份试（压得住的上限）；
 * 暗棋出什么全凭自己，谁也不知道谁扣着什么，按最大熵随手抽。
 */
function sampleWin(view: View, mine: number[], deal: Deal): boolean {
  const leader = view.trick ? view.trick.leader : view.seat;
  const rank = (seat: number) => (seat - leader + view.players) % view.players;
  const k = mine.length;
  const entries: { seat: number; tiers: number[] }[] = [{ seat: view.seat, tiers: mine }];
  for (const hp of deal.hiddenPlays) entries.push({ seat: hp.seat, tiers: hp.tiers });
  for (const h of deal.hands) {
    // 已表态的座位这一墩不再出牌（暗棋）；明棋只有还没轮到的座位压得了我
    if (view.trick !== null && !view.trick.waiting.includes(h.seat)) continue;
    const m = view.mode === 'ming' ? k : Math.min(k, h.tiers.length);
    if (m === 0 || h.tiers.length < m) continue; // 手里不够这一份，只能弃，不构成威胁
    entries.push({ seat: h.seat, tiers: view.mode === 'ming' ? bestM(h.tiers, m) : h.tiers.slice(0, m) });
  }
  entries.sort((a, b) => rank(a.seat) - rank(b.seat));
  let champion = entries[0]!;
  for (let i = 1; i < entries.length; i++) {
    const challenger = entries[i]!;
    if (beats(powerOfTiers(challenger.tiers), powerOfTiers(champion.tiers), view.cfg)) champion = challenger;
  }
  return champion.seat === view.seat;
}

// ---------- 残局深搜：把剩下的墩按摊牌一墩一墩推到底 ----------

function rolloutScore(view: View, ids: number[], deals: Deal[], play: 'lead' | 'follow' | 'discard'): number {
  let total = 0;
  for (const deal of deals) total += rolloutCollect(view, ids, deal, play);
  // 同期望时偏向先把这一墩拿到手的线（TIE_EPS 的量级远小于一枚牌，只管并列时定方向）；
  // 抵押那一路不进墩，没有「拿到手」可言，并列时交给同分随机
  const tie = play !== 'discard' ? winRate(view, ids, deals) : 0;
  return -(total / deals.length) - TIE_EPS * tie;
}

/**
 * 一副摊牌之下，把「candidate 落地 → 这一墩结完 → 赢家先出 → 剩下的墩打完」整局推完，
 * 返回我这边的总收牌张数。别家在推演里走省牌策略：领出丢最省的单张，明棋被逼着应就拿
 * 压得住的那份里最省的，压不过弃最省的；暗棋随手抽。全程只有档位，没有一张没公开的牌面。
 */
function rolloutCollect(view: View, ids: number[], deal: Deal, play: 'lead' | 'follow' | 'discard'): number {
  const players = view.players;
  const collected = new Array<number>(players).fill(0);
  const hands = new Map<number, number[]>();
  for (const h of deal.hands) hands.set(h.seat, [...h.tiers]);
  const myTiers = view.hand.map((id) => view.piece(id).tier);
  const dropMine = (ids: number[]): number[] => {
    const out = ids.map((id) => view.piece(id).tier);
    for (const t of out) myTiers.splice(myTiers.indexOf(t), 1);
    return out;
  };

  // ---- 当前这一墩：candidate 落进去，还没表态的座位补齐，按先出序结出赢家 ----
  const trick = view.trick;
  const leader = trick ? trick.leader : view.seat;
  const k0 = trick ? (trick.plays[0]?.size ?? 1) : ids.length;
  const seatTiers = new Map<number, number[]>();
  const discardPile: number[][] = [];
  if (trick === null) {
    seatTiers.set(view.seat, dropMine(ids));
  } else {
    const hidP = [...deal.hiddenPlays];
    const hidD = [...deal.hiddenDiscards];
    for (const p of trick.plays) {
      if (p.seat === view.seat) continue;
      seatTiers.set(p.seat, p.pieceIds.length ? p.pieceIds.map((id) => view.piece(id).tier) : (hidP.shift()?.tiers ?? []));
    }
    for (const d of trick.discarded) {
      discardPile.push(d.pieceIds.length ? d.pieceIds.map((id) => view.piece(id).tier) : (hidD.shift() ?? []));
    }
    if (play === 'follow') seatTiers.set(view.seat, dropMine(ids));
    if (play === 'discard') discardPile.push(dropMine(ids));
  }

  let champ: { seat: number; tiers: number[] } | null = null;
  for (let step = 0; step < players; step++) {
    const seat = (leader + step) % players;
    let tiers = seatTiers.get(seat);
    if (tiers === undefined) {
      const hand = hands.get(seat);
      if (!hand || hand.length === 0) continue;
      if (trick !== null && !trick.waiting.includes(seat)) continue; // 这墩没它的份（已表态/已弃干净）
      if (view.mode === 'kou') {
        const m = Math.min(k0, hand.length);
        tiers = hand.splice(0, m); // 摊牌顺序本身就是随机的，前 m 张就是随手抽的一份
        if (tiers.length < k0) {
          discardPile.push(tiers);
          continue;
        }
      } else {
        const m = Math.min(k0, hand.length);
        const best = bestM(hand, m);
        if (best.length === k0 && champ !== null && beats(powerOfTiers(best), powerOfTiers(champ.tiers), view.cfg)) {
          tiers = cheapestWinning(hand, k0, champ.tiers, view.cfg) ?? best;
          for (const t of tiers) hand.splice(hand.indexOf(t), 1);
        } else {
          tiers = hand.splice(0, m);
          discardPile.push(tiers);
          continue;
        }
      }
      seatTiers.set(seat, tiers);
    }
    if (champ === null) champ = { seat, tiers };
    else if (beats(powerOfTiers(tiers), powerOfTiers(champ.tiers), view.cfg)) champ = { seat, tiers };
  }
  const winner = champ!.seat;
  let potCount = 0;
  for (const t of seatTiers.values()) potCount += t.length;
  for (const d of discardPile) potCount += d.length;
  collected[winner]! += potCount;

  // ---- 剩下的墩：赢家先出，领出最省的单张，打到各家出空；我出完了就不用再推 ----
  let next = winner;
  for (let guard = 0; guard < 64 && myTiers.length > 0; guard++) {
    let leadSeat = -1;
    for (let step = 0; step < players; step++) {
      const seat = (next + step) % players;
      const n = seat === view.seat ? myTiers.length : (hands.get(seat)?.length ?? 0);
      if (n > 0) {
        leadSeat = seat;
        break;
      }
    }
    if (leadSeat < 0) break;
    const leadHand = leadSeat === view.seat ? myTiers : hands.get(leadSeat)!;
    // 领出策略：手里有对（同一档 ≥ 2 张）先领对——墩大一份，还逼得没对的人弃牌；没有才丢最省的单张
    const counts = new Map<number, number>();
    for (const t of leadHand) counts.set(t, (counts.get(t) ?? 0) + 1);
    let pairTier: number | null = null;
    for (const [t, n] of counts) if (n >= 2) pairTier = t;
    const leadTiers = pairTier !== null
      ? (() => { const out: number[] = []; for (const t of leadHand) { if (t === pairTier && out.length < 2) out.push(t); } for (const t of out) leadHand.splice(leadHand.indexOf(t), 1); return out; })()
      : [popSmallest(leadHand)];
    let champ2: { seat: number; tiers: number[] } = { seat: leadSeat, tiers: leadTiers };
    const pile: number[][] = [leadTiers];
    const disc: number[][] = [];
    for (let step = 1; step < players; step++) {
      const seat = (leadSeat + step) % players;
      const hand = seat === view.seat ? myTiers : (hands.get(seat) ?? []);
      if (hand.length === 0) continue;
      if (view.mode === 'kou') {
        const played = [popSmallest(hand)];
        pile.push(played);
        if (beats(powerOfTiers(played), powerOfTiers(champ2.tiers), view.cfg)) champ2 = { seat, tiers: played };
      } else {
        const winning = cheapestWinning(hand, 1, champ2.tiers, view.cfg);
        if (winning) {
          for (const t of winning) hand.splice(hand.indexOf(t), 1);
          pile.push(winning);
          if (beats(powerOfTiers(winning), powerOfTiers(champ2.tiers), view.cfg)) champ2 = { seat, tiers: winning };
        } else {
          disc.push([popSmallest(hand)]);
        }
      }
    }
    const w2 = champ2.seat;
    collected[w2]! += pile.reduce((a, p) => a + p.length, 0) + disc.reduce((a, p) => a + p.length, 0);
    next = w2;
  }
  return collected[view.seat]!;
}

function popSmallest(hand: number[]): number {
  let at = 0;
  for (let i = 1; i < hand.length; i++) if (hand[i]! < hand[at]!) at = i;
  return hand.splice(at, 1)[0]!;
}

/** 一手里凑得出的一份 k 张：单张（k=1）或同一档的 k 张（将帅那种跨色成组是特例，推演里不单列） */
function sameSizePlays(hand: number[], k0: number): number[][] {
  if (k0 === 1) {
    const seen = new Set<number>();
    const out: number[][] = [];
    for (const t of hand) if (!seen.has(t)) out.push([t]);
    return out;
  }
  const counts = new Map<number, number>();
  for (const t of hand) counts.set(t, (counts.get(t) ?? 0) + 1);
  const out: number[][] = [];
  for (const [t, n] of counts) if (n >= k0) out.push(Array.from({ length: k0 }, () => t));
  return out;
}

/** 压得住当前最大的那份里最省的：明棋被逼着应战时，理性人出的是这一份 */
function cheapestWinning(hand: number[], k0: number, champTiers: number[], cfg: TrickConfig): number[] | null {
  const champ = powerOfTiers(champTiers);
  let best: number[] | null = null;
  let bestCost = Infinity;
  for (const play of sameSizePlays(hand, k0)) {
    if (!beats(powerOfTiers(play), champ, cfg)) continue;
    const cost = play.reduce((a, t) => a + t, 0);
    if (cost < bestCost) {
      best = play;
      bestCost = cost;
    }
  }
  return best;
}

function powerOfTiers(tiers: number[]): { top: number; second: number | null; size: number } {
  const desc = [...tiers].sort((a, b) => b - a);
  return { top: desc[0]!, second: desc.length > 1 ? desc[1]! : null, size: desc.length };
}

/** 一手里最大的 m 张：明棋里被逼着应战时，这是它压得住我的上限 */
function bestM(tiers: number[], m: number): number[] {
  return [...tiers].sort((a, b) => b - a).slice(0, m);
}
