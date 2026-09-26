import { finalRank, type GameState } from './game.ts';

/** 打完这局的赢家名单：一个（胜出）或几个（并列）；一张没收到就是空 */
export function winners(state: GameState): number[] {
  const rank = finalRank(state);
  const best = state.won[rank[0]] ?? 0;
  if (best === 0) return [];
  return rank.filter((seat) => state.won[seat] === best);
}

/**
 * 下一局谁起抽 = 这一局的赢家；打完并列就沿用上局那位（没人赢，签也就不动）。
 * 第一局没有上一局，靠 `createGame({ drawer })` 或引擎随机。
 */
export function nextDrawer(state: GameState): number {
  if (state.phase !== 'over') throw new Error('这局还没打完，定不了下一局谁起抽');
  const top = winners(state);
  return top.length === 1 ? top[0]! : state.drawer;
}

/** 一局接一局的总账 */
export interface MatchBook {
  games: number;
  /** 各座位起抽过几局 */
  draws: number[];
  /** 各座位起抽的那局里赢下几局——先手值多少就看这一个 */
  drawWins: number[];
  /** 各座位夺冠几局（并列局谁都不加冕） */
  titles: number[];
  /** 各座位累计收牌枚数 */
  cards: number[];
  /** 打完仍并列的局数 */
  ties: number;
}

export function openMatch(players: number): MatchBook {
  const zero = () => Array.from({ length: players }, () => 0);
  return { games: 0, draws: zero(), drawWins: zero(), titles: zero(), cards: zero(), ties: 0 };
}

export function recordGame(book: MatchBook, state: GameState): void {
  const seat = state.drawer;
  book.games++;
  book.draws[seat] = (book.draws[seat] ?? 0) + 1;
  state.won.forEach((w, s) => (book.cards[s] = (book.cards[s] ?? 0) + w));
  const top = winners(state);
  if (top.length === 1) book.titles[top[0]!] = (book.titles[top[0]!] ?? 0) + 1;
  else book.ties++;
  if (top.length === 1 && top[0] === seat) book.drawWins[seat] = (book.drawWins[seat] ?? 0) + 1;
}
