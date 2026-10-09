/**
 * 单机那一局的纯策略：建局、AI 选座、落子记账、结算账、战报原文。
 * 参数进、结果出——`this`、Promise、render/toast/popup/sound/nap 一个都不进这儿；
 * DOM 与编排留在 App（app.ts），这一份能在 node 里脱离 DOM 单测。
 */
import { choose, type Level } from '../ai/agent.ts';
import { apply, createGame, legalActions, seatName, type Action, type GameState, type Rules } from '../core/game.ts';
import { nextDrawer, recordGame, type MatchBook } from '../core/match.ts';
import { viewFor } from '../core/view.ts';

/** 摊在桌面的这一墩快照。引擎结算完就不给了，动画得自己留着 */
export interface OnTable {
  seat: number;
  ids: number[];
  pledge: boolean;
  best: boolean;
}

/**
 * 新一局的种子／派生：同一档玩法第 gameNo 局的种子 = 基准种子 + 局号 × 7919，
 * 起抽人沿用上一局赢家（drawer >= 0），第一局没有上一局才交给引擎随机。
 */
export function newGameState(
  rules: Rules,
  setup: { players: number; mode: 'ming' | 'kou'; seed: number },
  gameNo: number,
  drawer: number,
): GameState {
  return createGame({
    rules,
    players: setup.players,
    mode: setup.mode,
    seed: setup.seed + gameNo * 7919,
    ...(drawer >= 0 ? { drawer } : {}),
  });
}

/** AI 这一手：只喂它此刻看得见的 view 与合法着法，抽签／分牌这类同分选项由 choose 内部随机挑 */
export function aiActionFor(state: GameState, seat: number, level: Level, rng: () => number): Action {
  return choose(viewFor(state, seat), legalActions(state, seat), level, rng);
}

/**
 * 落一手并更新暗棋遮罩：apply 之后若是扣棋且这一墩还开着，日志从 logBefore 起遮住；
 * 明棋或这一墩已结算就揭开（-1）。返回值就是 App 的 maskFrom。
 */
export function stepAndMask(state: GameState, seat: number, action: Action, logBefore: number, maskFrom: number): number {
  apply(state, seat, action);
  if (state.mode !== 'kou' || !state.trick) return -1;
  return maskFrom < 0 ? logBefore : maskFrom;
}

/** 收尾那一手的完整桌面＝之前的快照 + 刚出的这张；赢家那家亮起来，抵押的照常跟着收 */
export function closedTable(
  state: GameState,
  seat: number,
  action: Action,
  before: OnTable[] | null,
  wonBefore: number[],
): OnTable[] | null {
  if (!before) return null;
  const ids = 'pieceIds' in action ? [...action.pieceIds] : [];
  const winner = state.won.findIndex((w, i) => w !== wonBefore[i]);
  return [...before, { seat, ids, pledge: action.kind === 'discard', best: false }].map((e) => ({
    ...e,
    best: !e.pledge && e.seat === winner,
  }));
}

/** 一局收账：记进总账，并算出下一局谁起抽（这一局赢家；并列则沿用本局起抽人） */
export function settleMatch(book: MatchBook, state: GameState): number {
  recordGame(book, state);
  return nextDrawer(state);
}

/**
 * 系列战绩那一句。结算卡、复盘原文、牌桌顶栏念的都是这一份——
 * 三处各抄一遍的话，改个口径（「冠」改「夺冠」）就会漂成三种说法。
 * `who` 由调用方给：单机／联机那套「你／P2」的念法住在 app.ts 的 who()。
 */
export function bookLine(book: MatchBook, who: (seat: number) => string): string {
  return `累计 ${book.games} 局：${book.titles.map((t, seat) => `${who(seat)} 冠 ${t}`).join('　')}｜并列 ${book.ties} 局`;
}

/** 结算那份复盘原文：座位名跟屏上口径一致（日志里写的 P1/P2，这儿标出哪一位是你） */
export function reportText(state: GameState, book: MatchBook, me: number, title: string): string {
  const who = (seat: number) => (seat === me ? '你' : seatName(seat));
  const head = `棋墩墩 · ${state.mode === 'ming' ? '明棋' : '扣棋'} · ${state.players} 人（我是 ${seatName(me)}）· 种子 ${state.seed}`;
  return `${head}\n${title}\n\n${state.log.join('\n')}\n\n${bookLine(book, who)}`;
}
