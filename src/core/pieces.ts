export type Color = 'red' | 'black';

export interface RankDef {
  name: string;
  order: number;
  redLabel: string;
  blackLabel: string;
  /** [黑方枚数, 红方枚数] */
  count: [number, number];
  /** 同职红是否压黑。默认 true（连帅压将也算在内）；设成 false 这一级红黑同档 */
  redBeatsBlack?: boolean;
  /** 成组时是否要求同色；将/帅只有黑白各一枚，要能配对必须放开 */
  groupColors?: 'same' | 'any';
}

export interface Piece {
  id: number;
  rank: number;
  color: Color;
  tier: number;
  /** 抽签点数：兵卒 7、炮 6、车 5、马 4、相 3、士 2、将帅 1（红黑同点，只看职级） */
  point: number;
  label: string;
}

export function buildRanks(defs: RankDef[]): RankDef[] {
  return defs.map((d, i) => ({ ...d, order: i }));
}

/** 按职级顺序铺 tier；redBeatsBlack=false 的职级里红黑同 tier */
export function buildPieceSet(ranks: RankDef[]): Piece[] {
  const pieces: Piece[] = [];
  let id = 0;
  let tier = 0;
  ranks.forEach((rank, rankIndex) => {
    const blackTier = tier;
    tier += 1;
    const redTier = rank.redBeatsBlack === false ? blackTier : tier++;
    const point = ranks.length - rankIndex;
    const push = (color: Color, tierValue: number, label: string, n: number) => {
      for (let i = 0; i < n; i++) {
        pieces.push({ id: id++, rank: rankIndex, color, tier: tierValue, point, label });
      }
    };
    push('black', blackTier, rank.blackLabel, rank.count[0]);
    push('red', redTier, rank.redLabel, rank.count[1]);
  });
  return pieces;
}

export function pieceLabel(piece: Piece): string {
  return piece.label;
}
