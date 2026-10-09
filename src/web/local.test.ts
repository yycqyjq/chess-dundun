/**
 * 单机纯策略那一份（local.ts）的守卫：不碰 DOM、不碰 this，直接在 node 里跑。
 * 钉五件事：建局种子可复算、AI 选座必从 legalActions 出、落子＋暗棋遮罩与旧口径一致、
 * 收尾桌面赢家账、战报原文格式。搬走的那几段行为不变，全靠这几条盯着。
 */
import { aiActionFor, bookLine, closedTable, newGameState, reportText, settleMatch, stepAndMask, type OnTable } from './local.ts';
import { apply, legalActions, pendingSeats, type Action, type GameState, type Rules } from '../core/game.ts';
import { openMatch } from '../core/match.ts';
import { buildRanks } from '../core/pieces.ts';
import { mulberry32 } from '../core/rng.ts';
import type { Level } from '../ai/agent.ts';

let failures = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 一张够跑完整局的小表：16 枚、一摞 4 张、2 人档（一摞张数是家数的整数倍） */
const rules: Rules = {
  name: '测试表',
  ranks: buildRanks([
    { name: '将', redLabel: '帅', blackLabel: '将', count: [1, 1] },
    { name: '车', redLabel: '红车', blackLabel: '黑车', count: [2, 2] },
    { name: '马', redLabel: '红马', blackLabel: '黑马', count: [2, 2] },
    { name: '兵', redLabel: '兵', blackLabel: '卒', count: [3, 3] },
  ]),
  playerCounts: [2],
  modes: ['ming', 'kou'],
  tieBreak: 'leader',
  nextLeader: 'trick-winner',
  mingqi: { mustBeatIfAble: true, groupCompare: 'sameSize', discardCost: 'same' },
  kouqi: { mustBeatIfAble: false, groupCompare: 'sameSize', discardCost: 'same' },
  draft: { stackSize: 4, ways: ['layered'] },
};

const key = (a: Action): string => JSON.stringify(a);

// ---------- 1. 建局：种子数学可复算 ----------

console.log('\n建局：种子与牌序都可复算');
{
  const setup = { players: 2, mode: 'kou' as const, seed: 12345 };
  const a = newGameState(rules, setup, 0, -1);
  const b = newGameState(rules, setup, 0, -1);
  ok('基准局种子就是传进来的那个', a.seed === 12345);
  ok('同一档玩法第 gameNo 局的种子 = 基准 + gameNo × 7919', newGameState(rules, setup, 3, -1).seed === 12345 + 3 * 7919);
  ok('同参数两局牌序一模一样', a.pieces.map((p) => p.id).join() === b.pieces.map((p) => p.id).join());
  ok('drawer >= 0 时起抽人沿用上一局赢家', newGameState(rules, setup, 0, 1).drawer === 1);
  ok(
    'drawer < 0 时交给引擎随机（落在合法座位里）',
    [-1, -2].every((d) => {
      const s = newGameState(rules, setup, 0, d).drawer;
      return s >= 0 && s < 2;
    }),
  );
}

// ---------- 2. AI 选座：合法且必从 legalActions 出 ----------

console.log('\nAI 选座：喂给它的着法一定在 legalActions 里');
{
  const levels: Level[] = ['easy', 'greedy', 'hard'];
  for (const level of levels) {
    const state = newGameState(rules, { players: 2, mode: 'kou', seed: 7 }, 0, -1);
    const rng = mulberry32(99);
    const seat = pendingSeats(state)[0]!;
    const legal = legalActions(state, seat);
    const pickedDbg = aiActionFor(state, seat, level, rng);
    ok(
      `摸签阶段（${level}）：AI 那一手在 legalActions 里`,
      legal.some((a) => key(a) === key(pickedDbg)),
      `picked ${key(pickedDbg)} 不在 ${legal.map(key).join('｜')}`,
    );
  }
  const state = newGameState(rules, { players: 2, mode: 'ming', seed: 21 }, 0, -1);
  const rng = mulberry32(5);
  let checked = 0;
  for (let i = 0; i < 200 && state.phase !== 'over'; i++) {
    const seats = pendingSeats(state);
    if (seats.length === 0) break;
    const seat = seats[0]!;
    const legal = legalActions(state, seat);
    const picked = aiActionFor(state, seat, 'hard', rng);
    if (!legal.some((a) => key(a) === key(picked))) {
      ok('出牌阶段：AI 那一手在 legalActions 里', false, `第 ${i} 手 ${key(picked)} 不在 ${legal.map(key).join('｜')}`);
      checked = -1;
      break;
    }
    checked++;
    apply(state, seat, picked);
  }
  if (checked >= 0) ok(`出牌阶段：${checked} 手全部合法`, checked > 0, `只走了 ${checked} 手`);
}

// ---------- 3. stepAndMask：与旧 apply+mask 口径一致 ----------

console.log('\n落子＋暗棋遮罩：与旧 apply+mask 逐拍一致');
{
  const legacy = (s: GameState, seat: number, action: Action, logBefore: number, maskFrom: number): number => {
    apply(s, seat, action);
    if (s.mode !== 'kou' || !s.trick) return -1;
    return maskFrom < 0 ? logBefore : maskFrom;
  };
  const drive = (
    step: (s: GameState, seat: number, action: Action, logBefore: number, maskFrom: number) => number,
    mode: 'ming' | 'kou',
    seed: number,
  ): { masks: number[]; tricks: boolean[]; won: number[] } => {
    const state = newGameState(rules, { players: 2, mode, seed }, 0, -1);
    const rng = mulberry32(seed ^ 0x9e3779b9);
    let maskFrom = -1;
    const masks: number[] = [];
    const tricks: boolean[] = [];
    for (let i = 0; i < 400 && state.phase !== 'over'; i++) {
      const seats = pendingSeats(state);
      if (seats.length === 0) break;
      const seat = seats[0]!;
      const action = aiActionFor(state, seat, 'greedy', rng);
      const logBefore = state.log.length;
      maskFrom = step(state, seat, action, logBefore, maskFrom);
      masks.push(maskFrom);
      tricks.push(state.trick !== null);
    }
    return { masks, tricks, won: [...state.won] };
  };

  for (const mode of ['ming', 'kou'] as const) {
    for (const seed of [3, 88, 1001]) {
      const a = drive(stepAndMask, mode, seed);
      const b = drive(legacy, mode, seed);
      ok(
        `${mode} 种子 ${seed}：逐拍 maskFrom 与旧口径一致（${a.masks.length} 拍）`,
        a.masks.length > 0 && a.masks.join(',') === b.masks.join(','),
        `新 ${a.masks.join(',')}｜旧 ${b.masks.join(',')}`,
      );
      ok(`${mode} 种子 ${seed}：终局收牌与旧口径一致`, a.won.join(',') === b.won.join(','), `${a.won}｜${b.won}`);
    }
  }

  const kou = drive(stepAndMask, 'kou', 3);
  ok('扣棋：这一墩还开着时日志必被遮住，一结算就揭开', kou.tricks.every((open, i) => open === (kou.masks[i]! >= 0)));
  ok(
    '扣棋：遮罩一旦落下就钉住不动（直到揭开）',
    kou.masks.every((m, i) => i === 0 || m < 0 || kou.masks[i - 1]! < 0 || m === kou.masks[i - 1]),
  );
  const ming = drive(stepAndMask, 'ming', 3);
  ok('明棋：从头到尾都不遮（maskFrom 恒 -1）', ming.masks.every((m) => m === -1));
}

// ---------- 4. closedTable：赢家账 ----------

console.log('\n收尾桌面：刚出的那张补进去，赢家那家亮起来');
{
  const state = newGameState(rules, { players: 2, mode: 'ming', seed: 1 }, 0, -1);
  state.won = [5, 0];
  const before: OnTable[] = [{ seat: 1, ids: [9], pledge: false, best: false }];
  const wonBefore = [0, 0];

  const lead = closedTable(state, 0, { kind: 'lead', pieceIds: [3, 4] }, before, wonBefore)!;
  ok('之前的快照原样接着，刚出的那张补在末尾', lead.length === 2 && lead[1]!.seat === 0 && lead[1]!.ids.join() === '3,4');
  ok('收牌的那家（won 变了的那位）亮起来，别家不亮', lead[1]!.best === true && lead[0]!.best === false);
  ok('lead 不是抵押', lead[1]!.pledge === false);

  const discard = closedTable(state, 0, { kind: 'discard', pieceIds: [3, 4] }, before, wonBefore)!;
  ok('抵押那家不亮（pledge 记下来）', discard[1]!.pledge === true && discard[1]!.best === false);

  const noop = closedTable(state, 0, { kind: 'noop' }, before, wonBefore)!;
  ok('不带 pieceIds 的着法补进去是一张空牌', noop[1]!.ids.length === 0 && noop[1]!.pledge === false);

  ok(
    '没有之前的快照（不是收尾那一手）就返回 null',
    closedTable(state, 0, { kind: 'lead', pieceIds: [3] }, null, wonBefore) === null,
  );
}

// ---------- 5. settleMatch：一局收账 + 下一局起抽 ----------

console.log('\n收账：记进总账，下一局由这一局赢家起抽');
{
  const state = newGameState(rules, { players: 2, mode: 'kou', seed: 2 }, 0, -1);
  state.phase = 'over';
  state.drawer = 1;
  state.won = [6, 2];
  const book = openMatch(2);
  const next = settleMatch(book, state);
  ok('总账记了这一局（games+1、赢家加冕）', book.games === 1 && book.titles[0] === 1 && book.titles[1] === 0);
  ok('起抽那本也记了（这一局是 P2 起抽）', book.draws[1] === 1);
  ok('下一局起抽 = 这一局赢家', next === 0);

  const tie = newGameState(rules, { players: 2, mode: 'kou', seed: 2 }, 0, -1);
  tie.phase = 'over';
  tie.drawer = 1;
  tie.won = [4, 4];
  const book2 = openMatch(2);
  const next2 = settleMatch(book2, tie);
  ok('并列：谁都不加冕、ties+1，下一局仍由本局起抽人起抽', book2.titles.every((t) => t === 0) && book2.ties === 1 && next2 === 1);
}

// ---------- 6. reportText：复盘原文格式 ----------

console.log('\n战报：抬头／标题／日志／总账四段');
{
  const state = newGameState(rules, { players: 2, mode: 'ming', seed: 999 }, 0, -1);
  state.log.push('P1 出 红车', 'P2 压 红马');
  const book = openMatch(2);
  book.games = 3;
  book.titles = [2, 1];
  book.ties = 1;
  const txt = reportText(state, book, 0, '第 1 局｜你 夺冠');
  ok('抬头：玩法／人数／我坐哪／种子', txt.startsWith('棋墩墩 · 明棋 · 2 人（我是 P1）· 种子 999'), txt.split('\n')[0]);
  ok('标题原样带进来', txt.includes('\n第 1 局｜你 夺冠\n'));
  ok('日志逐行摊开', txt.includes('P1 出 红车\nP2 压 红马'));
  ok(
    '总账：冠军数按「你／P2」口径念，并列局数也在',
    txt.includes('累计 3 局：你 冠 2　P2 冠 1｜并列 1 局'),
    txt.split('\n').slice(-1)[0],
  );
  ok('我坐 P2 时抬头跟着换', reportText(state, book, 1, 't').startsWith('棋墩墩 · 明棋 · 2 人（我是 P2）· 种子 999'));
}

// ---------- 7. bookLine：系列战绩那一句的单一出处 ----------

console.log('\n系列战绩：顶栏／结算卡／复盘原文念的是同一句');
{
  const book = openMatch(3);
  book.games = 11;
  book.titles = [6, 1, 3];
  book.ties = 1;
  const who = (seat: number) => (seat === 0 ? '你' : `P${seat + 1}`);
  const line = bookLine(book, who);
  ok(
    '局数／各家夺冠／并列都念到了，座位名走调用方那一套',
    line === '累计 11 局：你 冠 6　P2 冠 1　P3 冠 3｜并列 1 局',
    line,
  );
  // 复盘原文那一段就是这一句——两处各写一遍的话，改个口径就漂成两种说法
  const state = newGameState(rules, { players: 3, mode: 'kou', seed: 7 }, 0, -1);
  ok('复盘原文末段就是这一句', reportText(state, book, 0, 't').endsWith(line));
  // 一局都没打完时念出来的是「累计 0 局」——藏不藏是画那一头的事，这一句只管文案
  ok('零局也念得出来（藏不藏由顶栏那一头决定）', bookLine(openMatch(2), who) === '累计 0 局：你 冠 0　P2 冠 0｜并列 0 局');
}

console.log(failures ? `\n${failures} 条没过` : '\n全部通过');
const G = globalThis as unknown as Record<string, unknown>;
(G.process as { exit(code: number): void }).exit(failures ? 1 : 0);
