import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { choose, LEVELS, type Level } from '../ai/agent.ts';
import {
  apply,
  createGame,
  currentActor,
  isFaceDown,
  legalActions,
  pendingSeats,
  seatName,
  type Action,
  type GameState,
} from '../core/game.ts';
import { loadRules } from '../node/load_rules.ts';
import { indexedHand, pickByIndices, sizesOf, tooLong } from './menu.ts';
import { buildPieceSet, buildRanks, pieceLabel, type RankDef } from '../core/pieces.ts';
import { nextDrawer, openMatch, recordGame, winners } from '../core/match.ts';
import { viewFor } from '../core/view.ts';
import { mulberry32 } from '../core/rng.ts';

function flag(argv: string[], name: string, fallback: string): string {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
}

function rulesPath(): string {
  return fileURLToPath(new URL(`../../rules.json`, import.meta.url));
}

function check(): number {
  const raw = JSON.parse(readFileSync(rulesPath(), 'utf8')) as {
    ranks: RankDef[];
    playerCounts: number[];
    name: string;
    tieBreak?: string;
    nextLeader?: string;
    mingqi?: { groupCompare?: string; mustBeatIfAble?: boolean; discardCost?: number | 'same' };
    kouqi?: { groupCompare?: string; mustBeatIfAble?: boolean; discardCost?: number | 'same' };
    draft?: { stackSize?: number };
  };
  const ranks = buildRanks(raw.ranks);
  const pieces = buildPieceSet(ranks);
  let problems = 0;

  console.log(`规则表：${raw.name}\n\n强度序（由小到大，大的压小的）\n`);
  const tiers = new Map<number, Map<string, number>>();
  for (const p of pieces) {
    const inner = tiers.get(p.tier) ?? new Map<string, number>();
    const label = pieceLabel(p);
    inner.set(label, (inner.get(label) ?? 0) + 1);
    tiers.set(p.tier, inner);
  }
  for (const tier of [...tiers.keys()].sort((a, b) => a - b)) {
    const text = [...tiers.get(tier)!].map(([l, n]) => (n > 1 ? `${l}×${n}` : l)).join('   ');
    console.log(`  ${String(tier + 1).padStart(2, '0')}  ${text}`);
  }
  const tieBreakRule: Record<string, string> = {
    leader: '一样大没有和棋，算顺时针在前（先出）那家赢',
    later: '一样大算后出的压过去',
  };
  console.log(
    `\n合计 ${pieces.length} 枚、${tiers.size} 档；同档判定：${tieBreakRule[raw.tieBreak ?? ''] ?? `未知 tieBreak：${raw.tieBreak}`}`,
  );
  console.log(
    `下一墩谁先出：${raw.nextLeader === 'clockwise' ? '顺时针轮下一家' : raw.nextLeader === 'trick-winner' ? '本墩最大的人（明暗都一样）' : `未知 nextLeader：${raw.nextLeader}`}`,
  );

  console.log('\n人数与牌堆\n');
  const stackSize = raw.draft?.stackSize ?? 4;
  for (const n of raw.playerCounts) {
    const okCount = pieces.length % n === 0;
    const per = pieces.length / n;
    console.log(
      `  ${okCount ? '✓' : '✗'} ${n} 人局：${okCount ? `每人 ${per} 枚${Number.isInteger(per / stackSize) ? ` = ${per / stackSize} 摞 × ${stackSize} 层` : `（不是 ${stackSize} 的倍数，摆不满整摞）`}` : `${pieces.length} 除不尽 ${n}`}`,
    );
    if (!okCount) problems++;
  }
  console.log(`  牌堆：${Math.ceil(pieces.length / stackSize)} 摞 × ${stackSize} 层 = ${pieces.length} 枚，随机码扣、不按大小排`);

  console.log('\n摆摞与分牌（全局只抽一次签）\n');
  console.log('  起抽人从 8 摞里挑一摞、摊开点其中一张（命令行没「点」这个动作，一律抽摞口那张），按职级点数从自己开始顺时针数，数到的人就是处置人');
  console.log('  处置人三种拿法：');
  console.log('    1) 层层轮流分：每摞从顶上开始，从自己起顺时针一人一张');
  console.log('    2) 整摞轮流拿·从左：自己拿最左那摞，然后顺时针一人一摞');
  console.log('    3) 整摞轮流拿·从右：同上，反过来从最右那摞开始');
  console.log('  只能定拿的规则，不能把某摞指名给谁');

  const groupRule: Record<string, string> = {
    sameSize: '张数要对得上：单张应单张，对应对，几对几（不同张数不能互压）',
    sizeFirst: '张数多的直接压张数少的',
    topTierFirst: '只比最大点',
  };
  for (const [name, mq] of [
    ['明棋', raw.mingqi],
    ['暗棋（扣棋）', raw.kouqi],
  ] as const) {
    console.log(`\n${name}比牌\n`);
    if (!mq) {
      console.log(`  ✗ 规则表里没有这一档`);
      problems++;
      continue;
    }
    console.log(`  ${groupRule[mq.groupCompare ?? ''] ?? `未知 groupCompare：${mq.groupCompare}`}`);
    console.log(
      `  压不过：${mq.mustBeatIfAble ? '手里有同张数更大的必须得出（拆对也得出）' : '可以故意出小的，不要求比对方大'}，否则抵押给赢家`,
    );
    console.log(`  抵押几张：${mq.discardCost === 'same' ? '对方出几张抵几张' : `固定 ${mq.discardCost} 张`}`);
    console.log(`  什么时候亮牌：${name === '明棋' ? '出牌即亮' : '一墩出完一起翻开'}`);
  }
  return problems;
}

function describeAction(state: GameState, action: Action): string {
  const name = (id: number) => pieceLabel(state.byId.get(id)!);
  switch (action.kind) {
    case 'draw':
      return `抽第 ${action.stackIdx + 1} 摞（命令行不给挑，抽摞口那张定点数；网页上点哪张抽哪张）`;
    case 'allocate':
      return {
        layered: '层层轮流分：从自己开始，一人一张',
        'stacks-left': '整摞轮流拿：从最左边那摞开始',
        'stacks-right': '整摞轮流拿：从最右边那摞开始',
      }[action.way];
    case 'noop':
      return '过（无牌可出）';
    default:
      return `${action.kind === 'lead' ? '出' : action.kind === 'follow' ? '压' : '弃'} ${action.pieceIds.map(name).join('+')}`;
  }
}

function renderBoard(state: GameState, seat: number): void {
  if (state.draft) {
    const d = state.draft;
    const drawn = d.stage === 'allocate' ? state.byId.get(d.drawn)! : null;
    console.log(
      `\n牌堆：${d.stacks.length} 摞 × ${d.stacks[0].length} 层，全部扣着｜起抽人 ${seatName(d.drawer)}${
        drawn ? `｜翻出 ${pieceLabel(drawn)}（${drawn.point} 点）→ 处置人 ${seatName(d.decider)}` : ''
      }`,
    );
    return;
  }
  const hand = state.hands[seat].map((id) => pieceLabel(state.byId.get(id)!)).join(' ');
  console.log(`\n你的手牌（${state.hands[seat].length} 枚）：${hand}`);
  console.log(`收牌：${state.won.map((w, i) => `${seatName(i)} ${w}`).join('  ')}`);
  if (state.trick) {
    const shown = (id: number) => (isFaceDown(state, id) ? '扣' : pieceLabel(state.byId.get(id)!));
    const table = state.trick.plays.map((p) => `${seatName(p.player)}:${p.pieceIds.map(shown).join('+')}`).join('  ');
    // 扣棋是同时暗出，没翻开之前桌上不分大小，别报「当前最大」
    console.log(
      state.mode === 'kou'
        ? `本墩桌面：${table}｜全员出完才翻开比大小`
        : `本墩桌面：${table}｜当前最大 ${seatName(state.trick.plays[state.trick.championIdx].player)}`,
    );
  }
}

/** 自己管行队列：rl.question 一次只能挂一个 Promise，管道里剩下的行会被丢掉 */
function makeInput(rl: ReturnType<typeof createInterface>) {
  const queue: string[] = [];
  let waiting: ((line: string | null) => void) | null = null;
  let closed = false;
  rl.setPrompt('');
  rl.on('line', (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      queue.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(null);
    }
  });
  return {
    ask(prompt: string): Promise<string | null> {
      process.stdout.write(prompt);
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
  };
}

async function play(opts: {
  players: number;
  mode: 'ming' | 'kou';
  seed: number;
  level: Level;
  chain: boolean;
}): Promise<void> {
  const rules = loadRules();
  const rng = mulberry32(opts.seed ^ 0x9e3779b9);
  const rl = createInterface({ input: process.stdin });
  const input = makeInput(rl);
  // 座位名跟引擎复盘里的 P1/P2 对齐，只有第一家标出是「你」
  const seats = Array.from({ length: opts.players }, (_, i) => (i === 0 ? '你（P1）' : `P${i + 1}`));
  const book = openMatch(opts.players);
  let drawer = -1;
  let tiedLast = false;
  console.log(`棋墩墩 · ${opts.mode === 'ming' ? '明棋' : '扣棋'} · ${opts.players} 人（你是 ${seats[0]}，其余 ${opts.level} AI，种子 ${opts.seed}）`);

  for (let g = 0; ; g++) {
    // 跨局：上一局赢家担任本局起抽人；每局各摇签（--independent）就留空让引擎自己随机
    const state = createGame({
      rules,
      players: opts.players,
      mode: opts.mode,
      seed: opts.seed + g * 7919,
      ...(opts.chain && drawer >= 0 ? { drawer } : {}),
    });
    if (g === 0) console.log(`\n第 1 局：${seats[state.drawer]} 起抽`);
    else console.log(`\n第 ${g + 1} 局：${seats[state.drawer]} 起抽（上一局${tiedLast ? '并列，沿用' : '赢家'}）`);

    let aborted = false;
    while (state.phase !== 'over') {
      // 扣棋里几家并列能动手：先问人，他一落子就再也看不见别人出的是什么
      const pending = pendingSeats(state);
      const seat = pending.includes(0) ? 0 : pending[0]!;
      const actions = legalActions(state, seat);
      if (seat !== 0) {
        apply(state, seat, choose(viewFor(state, seat), actions, opts.level, rng));
        continue;
      }
      renderBoard(state, seat);
      // 暗棋中途不能把别人扣着的牌泄在提示里，只有翻开之后才有复盘
      const recent =
        state.mode === 'kou' && state.trick ? ['本墩全员扣牌，出完才翻开'] : state.log.slice(-4);
      // 长菜单（抵押的全部组合）不数行号，改成按下标报牌
      const byIndex = tooLong(actions);
      const options = byIndex
        ? `这一轮出 ${sizesOf(actions).join(' 或 ')} 张，按下标报牌（空格分开）\n${indexedHand(state, seat)}`
        : actions.map((a, i) => `  ${i + 1}. ${describeAction(state, a)}`).join('\n');
      const answer = await input.ask(
        `\n最近：\n${recent.join('\n')}\n你的选择：\n${options}\n\n${
          byIndex ? '输入下标（q 退出）' : `输入 1-${actions.length}（q 退出）`
        }> `,
      );
      if (answer === null) {
        console.log('输入断了，这一局不算，收杆。');
        aborted = true;
        break;
      }
      const raw = answer.trim();
      // 空行只当没输入，重新问一次，别把整局作废
      if (raw === '') continue;
      if (raw.toLowerCase() === 'q') {
        console.log('收杆。');
        aborted = true;
        break;
      }
      const picked = byIndex ? pickByIndices(state, seat, actions, raw) : actions[Number(raw) - 1] ?? null;
      // 按下标报牌手一抖就错，报错了重新问一次就成，不值当把整局作废
      if (picked === null) {
        console.log(byIndex ? '这几张凑不成一套，或者下标不对——重新报一次。' : '没看懂这个序号——重新报一次。');
        continue;
      }
      apply(state, seat, picked);
    }
    // 中途退出的局不记账，免得半截牌混进总账
    if (aborted) break;
    recordGame(book, state);
    console.log(`\n—— 第 ${g + 1} 局复盘 ——\n${state.log.join('\n')}`);
    const top = winners(state);
    console.log(
      `本局：${top.length === 1 ? `${seats[top[0]!]} 夺冠` : top.length === 0 ? '谁都没收到牌，平局' : `${top.map((s) => seats[s]).join('、')} 并列`}`,
    );
    console.log(
      `累计（${book.games} 局）：${book.titles.map((t, seat) => `${seats[seat]} 冠 ${t}`).join('  ')}｜${book.cards.map((c, seat) => `${seats[seat]} 收 ${c} 枚`).join('  ')}`,
    );
    if (!opts.chain) break;
    drawer = nextDrawer(state);
    tiedLast = winners(state).length !== 1;
    const again = await input.ask('\n再来一局？回车继续（q 收杆）> ');
    if (again === null || again.trim().toLowerCase() === 'q') break;
  }
  rl.close();
}

function selfplay(opts: {
  players: number;
  mode: 'ming' | 'kou';
  games: number;
  seed: number;
  levels: Level[];
  /** 默认跨局：上一局赢家起抽。--independent 才是每局各摇一次签（做公平性统计时用） */
  chain: boolean;
  verbose: boolean;
}): void {
  const rules = loadRules();
  const seatLevel = (seat: number) => opts.levels[seat % opts.levels.length];
  const tally = Array.from({ length: opts.players }, () => 0);
  const byLevel = new Map<Level, { seats: number; won: number }>(LEVELS.map((l) => [l, { seats: 0, won: 0 }]));
  const book = openMatch(opts.players);
  let tricks = 0;
  let discards = 0;
  let drawer = -1;
  for (let g = 0; g < opts.games; g++) {
    // 第一局随机起抽，之后每一局都由上一局的赢家起抽（并列就还是他）
    const state = createGame({
      rules,
      players: opts.players,
      mode: opts.mode,
      seed: opts.seed + g * 7919,
      ...(opts.chain && drawer >= 0 ? { drawer } : {}),
    });
    const rng = mulberry32(state.seed ^ 0x51ed2701);
    const before = state.log.length;
    let guard = 0;
    while (state.phase !== 'over') {
      const seat = currentActor(state);
      if (seat === null) break;
      const actions = legalActions(state, seat);
      if (actions.length === 0) throw new Error(`${seatName(seat)} 卡住了，phase=${state.phase}`);
      const action = choose(viewFor(state, seat), actions, seatLevel(seat), rng);
      if (action.kind === 'discard') discards++;
      apply(state, seat, action);
      if (++guard > 2000) throw new Error(`超过 2000 步未结束，种子 ${state.seed}`);
    }
    tricks += state.log.filter((l) => l.includes('本墩归')).length;
    // 并列就不算冠军：finalRank 会把第一名落在最低座上，拿它统计会虚高 P1
    const top = winners(state);
    recordGame(book, state);
    if (top.length === 1) tally[top[0]!]++;
    for (let seat = 0; seat < opts.players; seat++) byLevel.get(seatLevel(seat))!.seats++;
    if (top.length === 1) byLevel.get(seatLevel(top[0]!))!.won++;
    if (opts.chain) drawer = nextDrawer(state);
    if (opts.verbose && g === 0) console.log(`\n—— 第 1 局实录（种子 ${state.seed}）——\n${state.log.slice(before).join('\n')}`);
  }
  console.log(`\n${opts.games} 局 · ${opts.mode === 'ming' ? '明棋' : '暗棋'} · ${opts.players} 人 · 座位难度=${opts.levels.join(',')}`);
  console.log(`  夺冠率：${tally.map((w, i) => `${seatName(i)}(${seatLevel(i)}) ${((w / opts.games) * 100).toFixed(0)}%`).join('  ')}（并列局不计冠军，见下行）`);
  // 按「难度座位」算：某难度赢下它所在那局的比例（同难度多座时一个赢家只记一次）
  const strength = opts.levels
    .filter((l, i) => opts.levels.indexOf(l) === i)
    .map((l) => {
      const slot = byLevel.get(l)!;
      return `${l} ${slot.seats === 0 ? '—' : `${((slot.won / slot.seats) * 100).toFixed(0)}%`}（${slot.seats / opts.games} 座）`;
    });
  console.log(`  平均：每局 ${(tricks / opts.games).toFixed(1)} 墩，每局 ${(discards / opts.games).toFixed(1)} 次抵押，打完仍并列 ${book.ties}/${opts.games} 局`);
  console.log(`  分难度胜率：${strength.join(' vs ')}`);
  if (opts.chain) {
    console.log(
      `  起抽人夺冠率：${book.draws.map((n, seat) => `${seatName(seat)} ${n === 0 ? '没起过抽' : `${(((book.drawWins[seat] ?? 0) / n) * 100).toFixed(0)}%（${book.drawWins[seat]}/${n}）`}`).join('  ')}`,
    );
    console.log(`  累计：夺冠 ${book.titles.map((t, seat) => `${seatName(seat)} ${t}`).join('  ')}｜收牌 ${book.cards.map((c, seat) => `${seatName(seat)} ${c}`).join('  ')}`);
  }
}

/** 难度名收在 --level / --levels 两处；不认识就直接停，别默默退回 greedy */
function toLevel(raw: string): Level {
  if ((LEVELS as string[]).includes(raw)) return raw as Level;
  console.log(`未知难度：${raw}（可选 ${LEVELS.join('|')}，--levels 用逗号按座位分隔）`);
  process.exit(2);
}

const [, , cmd = 'check', ...rest] = process.argv;
const mode = flag(rest, 'mode', 'ming') as 'ming' | 'kou';
const players = Number(flag(rest, 'players', '4'));
const seed = Number(flag(rest, 'seed', '7'));

if (cmd === 'check') process.exit(check() === 0 ? 0 : 1);
const chain = !rest.includes('--independent');
if (cmd === 'selfplay') {
  const raw = flag(rest, 'levels', 'greedy');
  selfplay({
    players,
    mode,
    seed,
    games: Number(flag(rest, 'games', '50')),
    levels: raw.split(',').filter(Boolean).map(toLevel),
    chain,
    verbose: rest.includes('--verbose'),
  });
  process.exit(0);
}
if (cmd === 'play') {
  await play({ players, mode, seed, chain, level: toLevel(flag(rest, 'level', 'greedy')) });
  process.exit(0);
}
console.log(
  `未知命令：${cmd}\n可用：check | selfplay | play   （都能带 --mode=ming|kou --players=2|4 --seed=N；play 带 --level=easy|greedy|hard，selfplay 带 --levels=easy,greedy,hard；默认一局接一局、上一局赢家起抽，加 --independent 则每局各摇签）`,
);
process.exit(2);
