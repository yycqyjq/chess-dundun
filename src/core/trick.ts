import type { Piece } from './pieces.ts';

export interface PlayPower {
  top: number;
  second: number | null;
  size: number;
}

export interface TrickConfig {
  /** leader = 一样大算先出那家赢（明暗一致）；later = 一样大算后出的压过去 */
  tieBreak: 'leader' | 'later';
  /** sameSize = 张数必须对得上才能比（对子压对子，三家压三家）；sizeFirst = 张数多的直接压张数少的；topTierFirst = 只比最大点 */
  groupCompare: 'sameSize' | 'sizeFirst' | 'topTierFirst';
}

export function powerOf(ids: number[], byId: Map<number, Piece>): PlayPower {
  const tiers = ids.map((id) => byId.get(id)!.tier).sort((a, b) => b - a);
  return { top: tiers[0], second: tiers.length > 1 ? tiers[1] : null, size: tiers.length };
}

/** 张数不同就是两种牌型，按我家的规矩不能互压：单张只能拿单张应，对子只能拿更大的对子应 */
export function comparable(a: PlayPower, b: PlayPower, cfg: TrickConfig): boolean {
  return cfg.groupCompare !== 'sameSize' || a.size === b.size;
}

/** 只比强度：1 = a 大，-1 = b 大，0 = 完全并列（交给 tieBreak 判）。张数是否可比由 comparable 把关 */
export function comparePower(a: PlayPower, b: PlayPower, cfg: TrickConfig): number {
  if (cfg.groupCompare === 'sizeFirst' && a.size !== b.size) return a.size > b.size ? 1 : -1;
  if (a.top !== b.top) return a.top > b.top ? 1 : -1;
  if (a.second !== null && b.second !== null && a.second !== b.second) {
    return a.second > b.second ? 1 : -1;
  }
  if (cfg.groupCompare === 'topTierFirst' && a.size !== b.size) return a.size > b.size ? 1 : -1;
  return 0;
}

/** 应战者永远比当前赢家靠后，所以并列时按 tieBreak 决定能否压过去 */
export function beats(candidate: PlayPower, champion: PlayPower, cfg: TrickConfig): boolean {
  if (!comparable(candidate, champion, cfg)) return false;
  const cmp = comparePower(candidate, champion, cfg);
  if (cmp > 0) return true;
  if (cmp < 0) return false;
  return cfg.tieBreak === 'later';
}

export interface TrickPlay {
  player: number;
  pieceIds: number[];
}

/** 按出牌顺序结算，返回赢家在 plays 里的下标 */
export function resolveTrick(plays: TrickPlay[], byId: Map<number, Piece>, cfg: TrickConfig): number {
  let champion = 0;
  let champPower = powerOf(plays[0].pieceIds, byId);
  for (let i = 1; i < plays.length; i++) {
    const power = powerOf(plays[i].pieceIds, byId);
    const cmp = comparePower(power, champPower, cfg);
    const overturns =
      comparable(power, champPower, cfg) && (cmp > 0 || (cmp === 0 && cfg.tieBreak === 'later'));
    if (overturns) {
      champion = i;
      champPower = power;
    }
  }
  return champion;
}
