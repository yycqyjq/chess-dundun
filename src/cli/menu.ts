import type { Action, GameState } from '../core/game.ts';
import { pieceLabel } from '../core/pieces.ts';

/**
 * 命令行菜单的收口。
 * 合法动作是引擎枚举出来的组合：手里 16 张弃 5 张就是 C(16,5)=4368 行，
 * terminal 里数着行号点牌不是给人用的，所以这种长菜单改成「按下标报几张」，
 * 报完照样回查合法表——凑不成一套就不作数，绝不放一个引擎不认的动作过去。
 */
export const MENU_LIMIT = 40;

/** 这一轮要不要收成按下标报牌：全是选牌的动作、且组合多到数不完 */
export function tooLong(actions: Action[]): boolean {
  return actions.length > MENU_LIMIT && actions.every((a) => 'pieceIds' in a);
}

/** 这一轮允许出几张（收成下标菜单时要告诉人报几张） */
export function sizesOf(actions: Action[]): number[] {
  return [...new Set(actions.map((a) => ('pieceIds' in a ? a.pieceIds.length : 0)))].sort((a, b) => a - b);
}

/** 手牌按 1 起始编号列出来：人报的是这个编号，不是牌的 id */
export function indexedHand(state: GameState, seat: number): string {
  return state.hands[seat]!.map((id, i) => `${i + 1}.${pieceLabel(state.byId.get(id)!)}`).join('  ');
}

/** 返回 null = 这串下标凑不成一个合法动作，caller 重新问，别把整局作废 */
export function pickByIndices(state: GameState, seat: number, actions: Action[], raw: string): Action | null {
  const hand = state.hands[seat]!;
  const nums = raw
    .trim()
    .split(/[\s,，、]+/)
    .filter(Boolean)
    .map((s) => Number(s));
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > hand.length)) return null;
  const ids = nums.map((n) => hand[n - 1]!);
  if (new Set(ids).size !== ids.length) return null;
  const key = [...ids].sort((a, b) => a - b).join(',');
  return actions.find((a) => 'pieceIds' in a && [...a.pieceIds].sort((x, y) => x - y).join(',') === key) ?? null;
}
