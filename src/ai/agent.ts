import type { Action } from '../core/game.ts';
import { beats, powerOf } from '../core/trick.ts';
import type { Piece } from '../core/pieces.ts';
import type { View } from '../core/view.ts';

export type Level = 'easy' | 'greedy' | 'hard';

export const LEVELS: Level[] = ['easy', 'greedy', 'hard'];

/**
 * 只喂 View：AI 看得见多少，和真人屏幕上显示的完全一样。
 * 同分的走法攒起来随机挑一个，别永远取第一个——抽签、分牌全是同分。
 */
export function choose(view: View, actions: Action[], level: Level, rng: () => number): Action {
  if (actions.length === 0) throw new Error(`P${view.seat + 1} 无合法行动`);
  if (level === 'easy') return actions[Math.floor(rng() * actions.length)];
  let tied: Action[] = [];
  let bestScore = Infinity;
  for (const action of actions) {
    const score = scoreAction(view, action, level);
    if (score < bestScore) {
      tied = [action];
      bestScore = score;
    } else if (score === bestScore) {
      tied.push(action);
    }
  }
  return tied.length === 1 ? tied[0]! : tied[Math.floor(rng() * tied.length)]!;
}

/**
 * 分数越小越该选。
 * greedy：只挑最省的牌，不猜赢面——明棋就是「拿刚好压得住的最小套」，暗棋就是「喂最小的」。
 * hard：把两边都换算成「枚」比一次——抢下这墩期望收几枚，对比这套牌留在手里还值几枚。
 */
function scoreAction(view: View, action: Action, level: Level): number {
  switch (action.kind) {
    // 牌堆随机扣着、没人看得见，所以抽哪摞、三种分法怎么选在信息上等值——不做偏好，交给同分随机
    case 'draw':
    case 'allocate':
    case 'noop':
      return 0;
    // 这一墩已经收不下了，抵押就丢最没用的，别把大牌搭进去
    case 'discard':
      return holdValue(view, action.pieceIds) + 0.01;
    case 'lead':
      // 自己领出时桌面是空的，抢赢也只值自己那几张；先丢最没用的，把判断留到应战那一步
      return playCost(view, action.pieceIds);
    case 'follow': {
      const cost = playCost(view, action.pieceIds);
      if (level === 'greedy') return cost;
      // 应战才有墩可抢：期望收几枚，对比这套牌留在手里还值几枚
      const gain = winOdds(view, action.pieceIds) * potSize(view, action.pieceIds.length);
      return holdValue(view, action.pieceIds) - gain;
    }
  }
}

function playCost(view: View, ids: number[]): number {
  let cost = ids.reduce((sum, id) => sum + view.piece(id).tier, 0);
  if (ids.length === 1 && breaksAPair(view, ids[0])) cost += 4;
  return cost;
}

function breaksAPair(view: View, id: number): boolean {
  const rank = view.piece(id).rank;
  return view.hand.filter((other) => view.piece(other).rank === rank).length > 1;
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

/** 我出这一套之后仍是全桌最大的概率。只用明处的牌 + 未公开牌的档位直方图，跟真人记牌看到的一样多 */
function winOdds(view: View, ids: number[]): number {
  const mine = sortedTiers(view, ids);
  const top = mine[0];
  const k = ids.length;
  let total = 0;
  let gt = 0;
  let eq = 0;
  view.unknownTiers.forEach((n, tier) => {
    if (!n) return;
    total += n;
    if (tier > top) gt += n;
    else if (tier === top) eq += n;
  });
  const trick = view.trick;
  let odds = 1;
  for (const play of trick ? trick.plays : []) {
    if (play.size !== k) continue;
    if (play.pieceIds.length === k) {
      // 牌面在明处，直接按规矩比一次，不用猜
      if (!iBeat(view, ids, play.pieceIds)) return 0;
      continue;
    }
    // 扣着的那一套：他比我先出，同档算他赢，所以 gt + eq 都算压得住我的牌
    const danger = hiddenBeatsMe(total, gt + eq, k);
    if (danger >= 1) return 0;
    odds *= 1 - danger;
  }
  for (const seat of responders(view)) {
    const held = view.counts[seat];
    // 手里凑不出 k 张就应不了这一套（sameSize 的规矩）
    if (held < k) continue;
    // 后出的要压过我必须真的有更大的，同档算我赢。
    // 明棋：他手里有大的就必须出，整只手都是威胁。
    // 暗棋：他摸黑应战，只会真掏出 k 张来，威胁按这 k 张算。
    odds *= 1 - hiddenBeatsMe(total, gt, view.mode === 'ming' ? held : k);
  }
  return odds;
}

/** 还没表态、要在我之后出牌的那几家 */
function responders(view: View): number[] {
  if (view.trick === null) {
    return view.counts.map((_, seat) => seat).filter((seat) => seat !== view.seat);
  }
  return view.trick.waiting.filter((seat) => seat !== view.seat);
}

/** 从看不见这些牌的立场估：摸 draws 张里有一张能压住我的概率 */
function hiddenBeatsMe(total: number, bad: number, draws: number): number {
  if (total <= 0 || bad <= 0 || draws <= 0) return 0;
  const clean = Math.max(total - bad, 0) / total;
  return 1 - Math.pow(clean, draws);
}

/** 我后出，按同档不算我赢的规矩比一次 */
function iBeat(view: View, mine: number[], theirs: number[]): boolean {
  const map = new Map<number, Piece>();
  for (const id of [...mine, ...theirs]) map.set(id, view.piece(id));
  return beats(powerOf(mine, map), powerOf(theirs, map), view.cfg);
}

/** 赢了这一墩能收几枚：桌面已有的 + 各家抵押的 + 我这套 */
function potSize(view: View, k: number): number {
  const trick = view.trick;
  if (trick === null) return k;
  let pot = k;
  for (const play of trick.plays) pot += play.size;
  for (const discard of trick.discarded) pot += discard.size;
  return pot;
}

function sortedTiers(view: View, ids: number[]): number[] {
  return ids.map((id) => view.piece(id).tier).sort((a, b) => b - a);
}
