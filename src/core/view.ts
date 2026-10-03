import { modeRules, type GameState } from './game.ts';
import type { Piece } from './pieces.ts';
import type { TrickConfig } from './trick.ts';

export interface TrickView {
  leader: number;
  waiting: number[];
  /** 本墩各家出了几张。暗棋扣着出不亮牌面，只有公开过的那几张（明棋出过的、这一墩翻开结算的）才给看 */
  plays: { seat: number; size: number; pieceIds: number[] }[];
  /** 本墩各家抵押了几张——张数是公开的，牌面按同一套规则亮不亮 */
  discarded: { seat: number; size: number; pieceIds: number[] }[];
  /** 当前最大那套是谁出的。暗棋里只知道座位和张数，不知道牌面 */
  championSeat: number;
}

/** 某个座位看得见的全部信息。真人屏幕上能显示的也就这些，AI 也只许吃这个 */
export interface View {
  seat: number;
  mode: 'ming' | 'kou';
  players: number;
  hand: number[];
  counts: number[];
  won: number[];
  /** 公开在明处的牌：明棋出过的 + 每墩翻开结算的 + 摆牌阶段刚抽出那张签 */
  open: Set<number>;
  /** 没公开的牌按档位数一遍：下标 = tier，值 = 张数。真人靠记牌得到的是同一张表，它不含「哪张在谁手里」 */
  unknownTiers: number[];
  /** 全场最高档的下标（将帅的红那档）。把档位换算成「值几枚牌」时用它归一 */
  topTier: number;
  /** 当前模式那套比牌规则。同档算谁赢、张数怎么比对两家都是公开的，判赢面要用 */
  cfg: TrickConfig;
  trick: TrickView | null;
  /** 查看不见的牌直接抛错——AI 伸手拿别人的牌就当场崩，不作弊是硬约束 */
  piece(id: number): Piece;
}

export interface OpenOpts {
  /** 本座摊在桌上那一墩（plays/discards）也算公开——单机版鼠标压上去能看见自己扣着出的牌，联机快照不能少这一口 */
  includeOwnTable?: boolean;
}

/**
 * 「哪些牌公开」的单一出口：集合口径。
 * base = revealed（明棋出过的 + 每墩翻开结算的）；摆牌阶段抽出的那张签在 draft 未清空时也算公开；
 * 自己的手牌永远亮着；`includeOwnTable` 时再加本座在这一墩 plays/discards 里的牌。
 * 单张判据 isFaceDown 是同一口径的逐张形式，写侧 reveal/maybeCloseTrick 决定谁进 revealed。
 */
export function openSet(state: GameState, seat: number, opts: OpenOpts = {}): Set<number> {
  const open = new Set<number>(state.revealed);
  // 签牌只在摆牌这一段算公开，分完牌 draft 清空它就跟着扣进手里——和 isFaceDown 同一口径
  if (state.draft && state.draft.drawn >= 0) open.add(state.draft.drawn);
  for (const id of state.hands[seat]) open.add(id);
  if (opts.includeOwnTable && state.trick) {
    for (const p of [...state.trick.plays, ...state.trick.discards]) {
      if (p.player !== seat) continue;
      for (const id of p.pieceIds) open.add(id);
    }
  }
  return open;
}

export function viewFor(state: GameState, seat: number): View {
  const open = openSet(state, seat);
  const unknownTiers: number[] = [];
  for (const p of state.pieces) {
    if (open.has(p.id)) continue;
    unknownTiers[p.tier] = (unknownTiers[p.tier] ?? 0) + 1;
  }
  const trick = state.trick;
  const shown = (ids: number[]) => (ids.every((id) => open.has(id)) ? [...ids] : []);
  return {
    seat,
    mode: state.mode,
    players: state.players,
    hand: [...state.hands[seat]],
    counts: state.hands.map((h) => h.length),
    won: [...state.won],
    open,
    unknownTiers,
    topTier: state.pieces.reduce((max, p) => Math.max(max, p.tier), 0),
    cfg: { tieBreak: state.rules.tieBreak, groupCompare: modeRules(state).groupCompare },
    trick: trick
      ? {
          leader: trick.leader,
          waiting: [...trick.waiting],
          plays: trick.plays.map((p) => ({ seat: p.player, size: p.pieceIds.length, pieceIds: shown(p.pieceIds) })),
          discarded: trick.discards.map((d) => ({ seat: d.player, size: d.pieceIds.length, pieceIds: shown(d.pieceIds) })),
          championSeat: trick.plays[trick.championIdx].player,
        }
      : null,
    piece(id: number): Piece {
      if (!open.has(id)) throw new Error(`P${seat + 1} 看不见第 ${id} 号牌`);
      return state.byId.get(id)!;
    },
  };
}
