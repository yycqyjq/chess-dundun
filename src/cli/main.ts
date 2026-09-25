import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { choose, LEVELS, type Level } from '../ai/agent.ts';
import {
  apply,
  createGame,
  currentActor,
  finalRank,
  isFaceDown,
  legalActions,
  loadRules,
  seatName,
  type Action,
  type GameState,
} from '../core/game.ts';
import { buildPieceSet, buildRanks, pieceLabel, type RankDef } from '../core/pieces.ts';
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
  console.log('  起抽人从 8 摞里挑一摞翻一张，按职级点数从自己开始顺时针数，数到的人就是处置人');
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
      return `抽第 ${action.stackIdx + 1} 摞（翻开最上面那张定点数）`;
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
    const champion = state.trick.plays[state.trick.championIdx];
    console.log(
      `本墩桌面：${state.trick.plays.map((p) => `${seatName(p.player)}:${p.pieceIds.map(shown).join('+')}`).join('  ')}｜当前最大 ${seatName(champion.player)}`,
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

async function play(opts: { players: number; mode: 'ming' | 'kou'; seed: number; level: Level }): Promise<void> {
  const state = createGame({ rules: loadRules(), players: opts.players, mode: opts.mode, seed: opts.seed });
  const rng = mulberry32(opts.seed ^ 0x9e3779b9);
  const rl = createInterface({ input: process.stdin });
  const input = makeInput(rl);
  console.log(`棋墩墩 · ${opts.mode === 'ming' ? '明棋' : '扣棋'} · ${opts.players} 人（你是 P1，其余 ${opts.level} AI，种子 ${opts.seed}）`);

  while (state.phase !== 'over') {
    const seat = currentActor(state)!;
    const actions = legalActions(state, seat);
    if (seat !== 0) {
      apply(state, seat, choose(viewFor(state, seat), actions, opts.level, rng));
      continue;
    }
    renderBoard(state, seat);
    const options = actions.map((a, i) => `  ${i + 1}. ${describeAction(state, a)}`).join('\n');
    // 暗棋中途不能把别人扣着的牌泄在提示里，只有翻开之后才有复盘
    const recent =
      state.mode === 'kou' && state.trick ? ['本墩全员扣牌，出完才翻开'] : state.log.slice(-4);
    const answer = await input.ask(
      `\n最近：\n${recent.join('\n')}\n你的选择：\n${options}\n\n输入 1-${actions.length}（q 退出）> `,
    );
    const n = Number((answer ?? '').trim());
    if (answer === null || answer.trim().toLowerCase() === 'q' || !Number.isInteger(n) || n < 1 || n > actions.length) {
      console.log('没看懂，先退了。');
      break;
    }
    apply(state, seat, actions[n - 1]);
  }
  rl.close();
  console.log(`\n—— 复盘 ——\n${state.log.join('\n')}`);
}

function selfplay(opts: {
  players: number;
  mode: 'ming' | 'kou';
  games: number;
  seed: number;
  levels: Level[];
  verbose: boolean;
}): void {
  const rules = loadRules();
  const seatLevel = (seat: number) => opts.levels[seat % opts.levels.length];
  const tally = Array.from({ length: opts.players }, () => 0);
  const byLevel = new Map<Level, { seats: number; won: number }>(LEVELS.map((l) => [l, { seats: 0, won: 0 }]));
  let tricks = 0;
  let discards = 0;
  let ties = 0;
  for (let g = 0; g < opts.games; g++) {
    const state = createGame({ rules, players: opts.players, mode: opts.mode, seed: opts.seed + g * 7919 });
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
    const rank = finalRank(state);
    if (state.won[rank[0]] === state.won[rank[1]]) ties++;
    tally[rank[0]]++;
    for (let seat = 0; seat < opts.players; seat++) byLevel.get(seatLevel(seat))!.seats++;
    if (rank[0] !== undefined && state.won[rank[0]] > 0) byLevel.get(seatLevel(rank[0]))!.won++;
    if (opts.verbose && g === 0) console.log(`\n—— 第 1 局实录（种子 ${state.seed}）——\n${state.log.slice(before).join('\n')}`);
  }
  console.log(`\n${opts.games} 局 · ${opts.mode === 'ming' ? '明棋' : '暗棋'} · ${opts.players} 人 · 座位难度=${opts.levels.join(',')}`);
  console.log(`  胜率：${tally.map((w, i) => `${seatName(i)}(${seatLevel(i)}) ${((w / opts.games) * 100).toFixed(0)}%`).join('  ')}`);
  // 按「难度座位」算：某难度赢下它所在那局的比例（同难度多座时一个赢家只记一次）
  const strength = opts.levels
    .filter((l, i) => opts.levels.indexOf(l) === i)
    .map((l) => {
      const slot = byLevel.get(l)!;
      return `${l} ${slot.seats === 0 ? '—' : `${((slot.won / slot.seats) * 100).toFixed(0)}%`}（${slot.seats / opts.games} 座）`;
    });
  console.log(`  平均：每局 ${(tricks / opts.games).toFixed(1)} 墩，每局 ${(discards / opts.games).toFixed(1)} 次抵押，打完仍并列 ${ties}/${opts.games} 局`);
  console.log(`  分难度胜率：${strength.join(' vs ')}`);
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
if (cmd === 'selfplay') {
  const raw = flag(rest, 'levels', 'greedy');
  selfplay({
    players,
    mode,
    seed,
    games: Number(flag(rest, 'games', '50')),
    levels: raw.split(',').filter(Boolean).map(toLevel),
    verbose: rest.includes('--verbose'),
  });
  process.exit(0);
}
if (cmd === 'play') {
  await play({ players, mode, seed, level: toLevel(flag(rest, 'level', 'greedy')) });
  process.exit(0);
}
console.log(`未知命令：${cmd}\n可用：check | selfplay | play   （都能带 --mode=ming|kou --players=2|4 --seed=N；play 带 --level=easy|greedy|hard，selfplay 带 --levels=easy,greedy,hard）`);
process.exit(2);
