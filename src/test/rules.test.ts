import {
  apply,
  createGame,
  currentActor,
  finalRank,
  isFaceDown,
  legalActions,
  pendingSeats,
  seatName,
  type Action,
  type GameState,
} from '../core/game.ts';
import { loadRules } from '../node/load_rules.ts';
import { buildPieceSet, pieceLabel } from '../core/pieces.ts';
import { viewFor } from '../core/view.ts';
import { choose, type Level } from '../ai/agent.ts';
import { beats, comparePower, powerOf, resolveTrick } from '../core/trick.ts';
import { mulberry32 } from '../core/rng.ts';
import { indexedHand, pickByIndices, sizesOf, tooLong } from '../cli/menu.ts';

let failures = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const base = loadRules();

/** 随机出招：公平性测试要排除 AI 强弱，只测结构 */
function playOut(state: GameState): GameState {
  const rng = mulberry32(state.seed ^ 0x51ed2701);
  let guard = 0;
  while (state.phase !== 'over') {
    const seat = currentActor(state);
    if (seat === null) break;
    const actions = legalActions(state, seat);
    if (actions.length === 0) throw new Error(`${seat} 无合法行动，phase=${state.phase}`);
    apply(state, seat, actions[Math.floor(rng() * actions.length)]);
    if (++guard > 3000) throw new Error('3000 步未结束');
  }
  return state;
}

/** 手工摆一个已经进了出牌阶段的局面：跳过摆摞，只看比牌规则 */
function toPlay(state: GameState, hands: number[][], leader: number): GameState {
  state.draft = null;
  state.hands = hands;
  state.won = state.won.map(() => 0);
  state.trick = null;
  state.phase = state.mode;
  state.leader = leader;
  return state;
}

const ids = (a: Action[]) => a.map((x) => x.kind).join(',');
const sizeOf = (a: Action) => (a as { pieceIds: number[] }).pieceIds.length;
const sameSet = (a: number[], b: number[]) => [...a].sort().join() === [...b].sort().join();

console.log('\n棋子与强度序');
const pieces = buildPieceSet(base.ranks);
const byName = new Map(pieces.map((p) => [p.label, p]));
const TOTAL = pieces.length;
const id = (name: string) => byName.get(name)!.id;
const idsOf = (name: string) => pieces.filter((p) => p.label === name).map((p) => p.id);
const map = new Map(pieces.map((p) => [p.id, p]));
ok('总数 32 枚', TOTAL === 32, `实际 ${TOTAL}`);
ok('7 个职级', base.ranks.length === 7, `实际 ${base.ranks.length}`);
ok('14 档：每一级黑都小于红，没有同档', new Set(pieces.map((p) => p.tier)).size === 14, `实际 ${new Set(pieces.map((p) => p.tier)).size}`);
ok('卒 全场最小', Math.min(...pieces.map((p) => p.tier)) === byName.get('卒')!.tier);
ok('兵 只比卒大一点：卒 < 兵 < 黑炮', byName.get('卒')!.tier < byName.get('兵')!.tier && byName.get('兵')!.tier < byName.get('黑炮')!.tier);
ok('兵 与 卒 同一职级（最低级 10 枚）', byName.get('兵')!.rank === byName.get('卒')!.rank);
ok('红帅 全场最大，帅压将', byName.get('红帅')!.tier > byName.get('黑将')!.tier && Math.max(...pieces.map((p) => p.tier)) === byName.get('红帅')!.tier);
ok('黑车 大于 红炮（跨职不看颜色）', byName.get('黑车')!.tier > byName.get('红炮')!.tier);

console.log('\n比大小');
const cfg = { tieBreak: base.tieBreak, groupCompare: base.mingqi.groupCompare } as const;
ok('同档压不过：一样的牌算先出那家赢', !beats(powerOf([id('兵')], map), powerOf([id('兵')], map), cfg));
ok('小压不了大', !beats(powerOf([id('兵')], map), powerOf([id('红车')], map), cfg));
ok(
  '张数对不上就不许压：两个兵压不了单张帅',
  !beats(powerOf(idsOf('兵').slice(0, 2), map), powerOf([id('红帅')], map), cfg),
);
ok('张数对不上就不许压：单张车压不了炮对', !beats(powerOf([id('红车')], map), powerOf(idsOf('黑炮'), map), cfg));
ok('同张数才比大小：红炮对比黑炮对大', comparePower(powerOf(idsOf('红炮'), map), powerOf(idsOf('黑炮'), map), cfg) > 0);
ok(
  '对子压对子：红车对比黑炮对大',
  beats(powerOf(idsOf('红车'), map), powerOf(idsOf('黑炮'), map), cfg),
);
ok(
  '三家只应三家：兵三压得了卒三，卒二压不了卒三',
  beats(powerOf(idsOf('兵').slice(0, 3), map), powerOf(idsOf('卒').slice(0, 3), map), cfg) &&
    !beats(powerOf(idsOf('卒').slice(0, 2), map), powerOf(idsOf('卒').slice(0, 3), map), cfg),
);
ok(
  '结算按出牌顺序，同档算先出那家',
  resolveTrick(
    [
      { player: 0, pieceIds: [id('黑炮')] },
      { player: 1, pieceIds: [id('黑炮')] },
      { player: 2, pieceIds: [id('卒')] },
    ],
    map,
    cfg,
  ) === 0,
);

console.log('\n明棋：有更大的必须出');
const mustBeat = toPlay(createGame({ rules: base, players: 2, mode: 'ming', seed: 7 }), [[id('红车'), id('兵')], [id('黑炮'), id('卒')]], 1);
apply(mustBeat, 1, { kind: 'lead', pieceIds: [id('卒')] });
const mustFollow = legalActions(mustBeat, 0);
ok('手里有同张数更大的，就不给弃牌的选项', mustFollow.every((a) => a.kind === 'follow'), ids(mustFollow));
ok(
  '拆对也得出来：能压的就是红车和兵两张单张',
  mustFollow.length === 2 && mustFollow.every((a) => sizeOf(a) === 1),
  mustFollow.map((a) => map.get((a as { pieceIds: number[] }).pieceIds[0])!.label).join(','),
);

console.log('\n压不过就抵押 / 打完才算账');
const pairLead = toPlay(createGame({ rules: base, players: 2, mode: 'ming', seed: 11 }), [idsOf('黑炮'), [...idsOf('红车').slice(0, 1), ...idsOf('卒').slice(0, 1)]], 0);
apply(pairLead, 0, { kind: 'lead', pieceIds: idsOf('黑炮') });
const owed = legalActions(pairLead, 1);
ok(
  '对方出对子，我手里有更大的单张也不许应战，只能抵押两张',
  owed.every((a) => a.kind === 'discard') && owed.every((a) => sizeOf(a) === 2),
  owed.map((a) => `${a.kind}:${sizeOf(a)}`).join(','),
);

// 同一条规则的另一个尺度：对方出三张，就得抵三张
const threeLead = toPlay(createGame({ rules: base, players: 2, mode: 'ming', seed: 12 }), [idsOf('卒').slice(0, 3), idsOf('兵').slice(0, 4)], 0);
apply(threeLead, 0, { kind: 'lead', pieceIds: idsOf('卒').slice(0, 3) });
const owing3 = legalActions(threeLead, 1);
ok(
  '对方出三张：兵三能压，压不了就得抵三张',
  owing3.some((a) => a.kind === 'follow' && sizeOf(a) === 3) && owing3.every((a) => sizeOf(a) === 3),
  owing3.map((a) => `${a.kind}:${sizeOf(a)}`).join(','),
);

// 同一条规则推到命令行那头：16 张里弃 5 张是 C(16,5)=4368 行菜单，得收成「按下标报牌」
const noFive = [...idsOf('卒').slice(0, 4), ...pieces.filter((p) => p.label !== '兵' && p.label !== '卒').slice(0, 12).map((p) => p.id)];
const bigKou = toPlay(createGame({ rules: base, players: 2, mode: 'kou', seed: 61 }), [idsOf('兵'), noFive], 0);
apply(bigKou, 0, { kind: 'lead', pieceIds: idsOf('兵') });
const bigOwed = legalActions(bigKou, 1);
ok(
  '对面出一整摞五兵，我手里凑不出五张一组：只能弃 5 张',
  bigOwed.every((a) => a.kind === 'discard' && sizeOf(a) === 5) && bigOwed.length === 4368,
  `${bigOwed.length} 条：${[...new Set(bigOwed.map((a) => a.kind))].join(',')}`,
);
ok('长菜单收口：4368 条组合不数行号，改成按下标报牌', tooLong(bigOwed), `${bigOwed.length} 条 / tooLong=${tooLong(bigOwed)}`);
ok('折成报下标时得告诉人这一轮出几张：那一轮只有 5 这一档', sizesOf(bigOwed).join() === '5', sizesOf(bigOwed).join());
const first = bigOwed[0]!;
const firstIdx = (first as { pieceIds: number[] }).pieceIds
  .map((id) => bigKou.hands[1]!.indexOf(id) + 1)
  .sort((a, b) => a - b)
  .join(' ');
ok(
  `按下标报回引擎认的那条：${firstIdx} 号 = ${(first as { pieceIds: number[] }).pieceIds.map((id) => map.get(id)!.label).join('+')}`,
  pickByIndices(bigKou, 1, bigOwed, firstIdx) === first,
);
ok(
  '下标乱报、重号、超范围、张数不对，一律 null 让 caller 重新问',
  ['7 7 8 9 10', '1 2 3 4 99', '0 1 2 3 4', 'a b c d e', '1 2 3', '1.5 2 3 4 5', ''].every(
    (raw) => pickByIndices(bigKou, 1, bigOwed, raw) === null,
  ),
);
ok('逗号顿号也当分隔，别逼人数空格', pickByIndices(bigKou, 1, bigOwed, firstIdx.replace(/ /g, '，')) === first);
ok('短菜单照旧数行号：只有四种的弃三张不折成下标', !tooLong(owing3));
// 张数对上了也不等于合法：弃牌那种「任意几张」当然全收，可压牌只认凑得成组的
const mixed = toPlay(createGame({ rules: base, players: 2, mode: 'kou', seed: 62 }), [idsOf('黑炮'), [id('红车'), ...idsOf('卒').slice(0, 2)]], 0);
apply(mixed, 0, { kind: 'lead', pieceIds: idsOf('黑炮') });
const mixedActs = legalActions(mixed, 1);
ok(
  '两张一组里只有那对卒合法：车+卒 报上来照样 null',
  mixedActs.length === 1 && pickByIndices(mixed, 1, mixedActs, '1 2') === null && pickByIndices(mixed, 1, mixedActs, '2 3') === mixedActs[0],
  mixedActs.map((a) => (a as { pieceIds: number[] }).pieceIds.join(',')).join(' | '),
);

// 同一套「按下标报牌」的显示那一半：列出来的号，跟报回去吃到的必须是同一张牌
// 四张挑四个不同名次的：同名次的牌列出来长一个样，号错位也看不出差别
const solo4 = [id('红车'), id('黑炮'), id('兵'), id('卒')];
const oneLead = toPlay(createGame({ rules: base, players: 2, mode: 'ming', seed: 71 }), [[id('红炮'), id('黑马')], solo4], 1);
const leadActs = legalActions(oneLead, 1);
const shown = indexedHand(oneLead, 1).split('  ');
const rest = (t: string) => t.slice(t.indexOf('.') + 1);
const soloOf = (a: Action) => (a as { pieceIds: number[] }).pieceIds;
ok(
  '这一轮是首出：手里那四张各有一条单出，正好拿来逐号回查',
  solo4.every((p) => leadActs.some((a) => a.kind === 'lead' && soloOf(a).length === 1 && soloOf(a)[0] === p)),
  `${leadActs.length} 条：${ids(leadActs)}`,
);
ok(
  '列出来的张数跟手里一样，号从 1 连着排到 n',
  shown.length === oneLead.hands[1]!.length && shown.every((t, i) => Number(t.slice(0, t.indexOf('.'))) === i + 1),
  indexedHand(oneLead, 1),
);
ok(
  '逐号报回去，引擎认的那张正是这一行列的那张',
  shown.length === 4 &&
    shown.every((t, i) => {
      // 人照屏上那行写的号敲，敲的就是这一行：号码取屏上那个，不取循环里的 i
      const a = pickByIndices(oneLead, 1, leadActs, t.slice(0, t.indexOf('.')));
      return !!a && soloOf(a)[0] === solo4[i] && map.get(soloOf(a)[0]!)!.label === rest(t);
    }),
  indexedHand(oneLead, 1),
);
ok(
  '列的是这一位手里的牌，不是隔壁那位的',
  indexedHand(oneLead, 0) !== indexedHand(oneLead, 1) &&
    indexedHand(oneLead, 0)
      .split('  ')
      .every((t, i) => rest(t) === map.get(oneLead.hands[0]![i]!)!.label),
  indexedHand(oneLead, 0),
);
ok(
  '号跟号之间那分隔，报回来那头切得开：两头用的是同一套切法',
  indexedHand(oneLead, 1).split(/[\s,，、]+/).length === oneLead.hands[1]!.length,
  indexedHand(oneLead, 1),
);
ok(
  '牌名里不许夹空白、逗号、顿号：一夹就串号',
  pieces.every((p) => !/[\s,，、]/.test(pieceLabel(p))),
  pieces.filter((p) => /[\s,，、]/.test(pieceLabel(p))).map((p) => p.label).join(','),
);
ok(
  '长菜单那头第 16 号（手里最后一张）报得回去，不算超范围',
  indexedHand(bigKou, 1).split('  ').length === 16 && pickByIndices(bigKou, 1, bigOwed, '16 15 14 13 12') !== null,
  `${indexedHand(bigKou, 1).split('  ').length} 号 / 报 16：${pickByIndices(bigKou, 1, bigOwed, '16 15 14 13 12') === null ? 'null' : '认'}`,
);

const tied = createGame({ rules: base, players: 4, mode: 'kou', seed: 3 });
tied.won = [8, 8, 4, 8];
const ranked = finalRank(tied);
ok(
  '摞数相同就是并列，不打完不看（前三家同为 8 枚，谁也不让谁）',
  ranked.join() === '0,1,3,2' && tied.won[ranked[0]] === tied.won[ranked[2]],
  JSON.stringify(ranked),
);

console.log('\n暗棋：张数对得上就必须出，出大出小随意');
const kou = toPlay(createGame({ rules: base, players: 2, mode: 'kou', seed: 41 }), [[id('红炮'), id('卒')], [id('红车'), id('卒')]], 0);
apply(kou, 0, { kind: 'lead', pieceIds: [id('红炮')] });
const kouFollow = legalActions(kou, 1);
ok(
  '有红车也不逼你压，出卒喂牌是合法选择',
  kouFollow.some((a) => a.kind === 'follow' && a.pieceIds.includes(id('卒'))),
  ids(kouFollow),
);
ok('但必须出，不给弃牌选项', kouFollow.every((a) => a.kind === 'follow'), ids(kouFollow));
const kouPair = toPlay(createGame({ rules: base, players: 2, mode: 'kou', seed: 42 }), [idsOf('黑炮'), [id('红车'), id('红马'), id('卒')]], 0);
apply(kouPair, 0, { kind: 'lead', pieceIds: idsOf('黑炮') });
const kouOwed = legalActions(kouPair, 1);
ok('凑不出两张就得抵两张', kouOwed.every((a) => a.kind === 'discard' && sizeOf(a) === 2), ids(kouOwed));

const hidden = toPlay(createGame({ rules: base, players: 2, mode: 'kou', seed: 43 }), [[id('红炮'), id('卒')], [id('卒'), id('卒')]], 0);
apply(hidden, 0, { kind: 'lead', pieceIds: [id('红炮')] });
ok('暗棋领出的牌结算前别人看不见', isFaceDown(hidden, id('红炮')));
apply(hidden, 1, { kind: 'follow', pieceIds: [id('卒')] });
ok('一墩出完才翻开，赢家收走全部', !isFaceDown(hidden, id('红炮')) && hidden.won[0] === 2 && hidden.leader === 0, JSON.stringify(hidden.won));

console.log('\n扣棋并发：首出之后其余几家同时暗出，不分先后');
const zu = idsOf('卒');
const pao = idsOf('红炮');
const conc = toPlay(createGame({ rules: base, players: 4, mode: 'kou', seed: 44 }), [[zu[0]], [pao[0]], [pao[1]], [zu[1]]], 0);
apply(conc, 0, { kind: 'lead', pieceIds: [zu[0]] });
ok(
  '首出一落，其余三家同时都能动手',
  pendingSeats(conc).join() === '1,2,3' && [1, 2, 3].every((s) => legalActions(conc, s).length > 0),
  pendingSeats(conc).join(),
);
apply(conc, 3, { kind: 'follow', pieceIds: [zu[1]] });
apply(conc, 2, { kind: 'follow', pieceIds: [pao[1]] });
ok('一墩没出完之前桌上没有「当前最大」', conc.trick!.championIdx === 0 && viewFor(conc, 1).trick!.championSeat === 0);
ok(
  '倒着落子也不改判定序：plays 按顺时针排，不是按谁先出',
  conc.trick!.plays.map((p) => p.player).join() === '0,2,3',
  conc.trick!.plays.map((p) => p.player).join(),
);
apply(conc, 1, { kind: 'follow', pieceIds: [pao[0]] });
ok('两张红炮并列，顺时针靠前那家赢，跟谁先落子无关', conc.won.join() === '0,4,0,0', JSON.stringify(conc.won));

console.log('\n成组出牌（成组不是必须的，拆开单出也行）');
function leadOptions(hand: number[]): number[][] {
  const s = toPlay(createGame({ rules: base, players: 2, mode: 'ming', seed: 5 }), [hand, idsOf('红车').slice(0, 1)], 0);
  return legalActions(s, 0)
    .filter((a) => a.kind === 'lead')
    .map((a) => [...(a as { pieceIds: number[] }).pieceIds].sort((x, y) => x - y));
}
const has = (group: number[]) => leadOptions(group).some((o) => o.join() === [...group].sort((x, y) => x - y).join());
const zu5 = idsOf('卒').slice(0, 5);
const bing2 = idsOf('兵').slice(0, 2);
ok('同色 5 枚卒可以一起出', has(zu5));
ok('同色 2 枚卒可以一起出', has(zu5.slice(0, 2)));
ok('对子也能拆成单张出', has([zu5[0]]));
ok('红兵和黑卒不能凑一组（跨色）', !has([...bing2, ...zu5.slice(0, 2)]));
ok('黑将和红帅可以凑一组（将帅这级允许跨色）', has([...idsOf('黑将'), ...idsOf('红帅')]));

console.log('\n摆摞：全局只抽一次签，点数数到谁谁定分法');
const point = (name: string) => byName.get(name)!.point;
ok('兵卒都是 7 点', point('兵') === 7 && point('卒') === 7);
ok('将帅都是 1 点，红黑同点', point('红帅') === 1 && point('黑将') === 1);
ok('点数只看职级：黑炮红炮都是 6', point('黑炮') === 6 && point('红炮') === 6);
ok('点数 = 职级倒序，从 7 数到 1', point('红炮') === 6 && point('红车') === 5 && point('红马') === 4 && point('红相') === 3 && point('红仕') === 2);

const opening = createGame({ rules: base, players: 4, mode: 'ming', seed: 21 });
const stacks0 = opening.draft!.stacks.map((s) => [...s]);
const drawer = currentActor(opening)!;
ok('一上来就是摆摞阶段，8 摞 × 4 层', opening.phase === 'draft' && stacks0.length === 8 && stacks0.every((s) => s.length === 4));
ok('牌堆随机扣着，不按大小排', stacks0.some((s) => opening.byId.get(s[3])!.tier < opening.byId.get(s[0])!.tier));
ok(
  '只有起抽人能动手，且能从任意一摞抽',
  legalActions(opening, drawer).length === 8 && legalActions(opening, (drawer + 1) % 4).length === 0,
);
apply(opening, drawer, { kind: 'draw', stackIdx: 3 });
const drawn = stacks0[3][3];
const firstPoint = opening.byId.get(drawn)!.point;
ok('不指定抽哪张就抽摞口那张，当场各家都看得见', opening.draft!.drawn === drawn && !isFaceDown(opening, drawn) && viewFor(opening, (drawer + 1) % 4).open.has(drawn));
ok(`翻出 ${firstPoint} 点：从起抽人自己数到 ${seatName((drawer + firstPoint - 1) % 4)}`, opening.draft!.decider === (drawer + firstPoint - 1) % 4 && opening.opening!.seat === opening.draft!.decider);
ok('抽完这一签就定了：只剩处置人能选分法，起抽人没牌可抽了', legalActions(opening, opening.draft!.decider).length === 3 && legalActions(opening, drawer).length === 0);

// 界面上摊开之后每一张各是一个点击目标，引擎得照着「点的那张」抽；CLI 和 AI 不传 pieceId，走的还是摞口
const pickGame = createGame({ rules: base, players: 4, mode: 'ming', seed: 21 });
const pickStack = pickGame.draft!.stacks[1];
const pickId = pickStack[1];
apply(pickGame, currentActor(pickGame)!, { kind: 'draw', stackIdx: 1, pieceId: pickId });
ok('点哪张抽哪张：抽的就是点的那张，不是永远摞口那张', pickGame.draft!.drawn === pickId && pickGame.opening!.pieceId === pickId);
ok(
  '抽摞中间那张也照它的点数数人',
  pickGame.draft!.decider === (pickGame.opening!.drawer + pickGame.byId.get(pickId)!.point - 1) % 4,
);
apply(pickGame, pickGame.draft!.decider, { kind: 'allocate', way: 'layered' });
ok(
  '摞里被抽走一张也分得完：每人还是 8 枚，那张跟着这摞进了某家',
  pickGame.hands.every((h) => h.length === 8) && pickGame.hands.some((h) => h.includes(pickId)),
  pickGame.hands.map((h) => h.length).join(','),
);

const rngDraft = mulberry32(99);
while (opening.phase === 'draft') {
  const seat = currentActor(opening)!;
  const acts = legalActions(opening, seat);
  apply(opening, seat, acts[Math.floor(rngDraft() * acts.length)]);
}
ok('8 摞一次分完，发完牌先出的就是那一抽数到的人', opening.leader === opening.opening!.seat && opening.hands.every((h) => h.length === 8), `手牌 ${opening.hands.map((h) => h.length).join(',')}`);
const holder = opening.hands.findIndex((h) => h.includes(drawn));
ok('签牌进手就跟着扣：分完牌 isFaceDown 为真', isFaceDown(opening, drawn));
ok('持有人自己还认得这张签，别人查它直接抛错', viewFor(opening, holder).piece(drawn).id === drawn && (() => { try { viewFor(opening, (holder + 1) % 4).piece(drawn); return false; } catch { return true; } })());

console.log('\n分牌：三种拿法都不指名给谁，张数一定公平');
function drafted(way: 'layered' | 'stacks-left' | 'stacks-right', players = 4, seed = 31) {
  const state = createGame({ rules: base, players, mode: 'ming', seed, drawer: 0 });
  const stacks = state.draft!.stacks.map((s) => [...s]);
  apply(state, 0, { kind: 'draw', stackIdx: 0 });
  const decider = state.draft!.decider;
  apply(state, decider, { kind: 'allocate', way });
  return { state, stacks, decider };
}
const perHead = (players: number) => TOTAL / players;
const lay = drafted('layered');
ok('层层轮流分：从处置人自己开始，每摞拿最上面那张', lay.stacks.every((s) => lay.state.hands[lay.decider].includes(s[3])));
ok(`层层轮流分：每人正好 ${perHead(4)} 枚`, lay.state.hands.every((h) => h.length === perHead(4)), lay.state.hands.map((h) => h.length).join(','));
const left = drafted('stacks-left', 4, 32);
ok(
  '整摞轮流拿·从左：处置人拿第 1 摞，转一圈回来拿第 5 摞',
  sameSet(left.state.hands[left.decider], [...left.stacks[0], ...left.stacks[4]]) &&
    sameSet(left.state.hands[(left.decider + 1) % 4], [...left.stacks[1], ...left.stacks[5]]),
  left.state.hands.map((h) => h.length).join(','),
);
const right = drafted('stacks-right', 4, 33);
ok(
  '整摞轮流拿·从右：处置人从最右那摞开始拿（第 8 摞 + 第 4 摞）',
  sameSet(right.state.hands[right.decider], [...right.stacks[7], ...right.stacks[3]]),
);
ok('两种整摞拿法也是人手相同', left.state.hands.every((h) => h.length === perHead(4)) && right.state.hands.every((h) => h.length === perHead(4)));
const lay2 = drafted('layered', 2, 34);
ok('2 人局层层分：每人 16 枚', lay2.state.hands.every((h) => h.length === perHead(2)), lay2.state.hands.map((h) => h.length).join(','));

console.log('\n本墩最大的人领下一墩');
const spin = toPlay(
  createGame({ rules: base, players: 4, mode: 'ming', seed: 6 }),
  [[id('红炮'), id('卒')], [id('黑车'), id('卒')], [id('红相'), id('卒')], [id('黑炮'), id('卒')]],
  0,
);
apply(spin, 0, { kind: 'lead', pieceIds: [id('红炮')] });
ok('明棋：下家有更大的就必须压，不能放过', ids(legalActions(spin, 1)) === 'follow');
for (const seat of [1, 2, 3]) {
  const act = legalActions(spin, seat)[0];
  apply(spin, seat, act);
}
ok('第三家（红相）最大，下一墩就他先出，不是轮到领出者的下家', spin.trick === null && spin.leader === 2, `${seatName(spin.leader)} 先出`);
ok('抵押的牌归赢家一起算：三家各出 1 张全进赢家手里', spin.won.join() === '0,0,4,0', JSON.stringify(spin.won));

console.log('\nAI 的信息边界（暗棋不许开全图）');
const peek = toPlay(createGame({ rules: base, players: 2, mode: 'kou', seed: 51 }), [[id('红车')], [id('红帅')]], 0);
let peekErr = '';
try {
  viewFor(peek, 0).piece(id('红帅'));
} catch (e) {
  peekErr = String((e as Error).message);
}
ok('伸手查对手扣着的牌：直接抛错', peekErr !== '', peekErr);
ok('自己手里的牌照查', viewFor(peek, 0).piece(id('红车')).label === '红车');

/** P0 先领一张黑炮，轮到 P1（红车 + 卒）；opp 里多出来的那张是 P0 扣着的 */
function kouTurn(opp: number[], level: Level = 'greedy'): { state: GameState; action: Action } {
  const s = toPlay(createGame({ rules: base, players: 2, mode: 'kou', seed: 52 }), [opp, [id('红车'), id('卒')]], 0);
  apply(s, 0, { kind: 'lead', pieceIds: [id('黑炮')] });
  return { state: s, action: choose(viewFor(s, 1), legalActions(s, 1), level, mulberry32(3)) };
}
const picked = (a: Action) => map.get((a as { pieceIds: number[] }).pieceIds[0])!.label;
const hiding = kouTurn([id('黑炮'), id('红帅')]);
const weak = kouTurn([id('黑炮'), id('黑士')]);
ok(
  '对手扣着帅还是扣着士它一概不知：两次都只按自己手里的牌出最小的',
  picked(hiding.action) === '卒' && picked(weak.action) === '卒',
  `${picked(hiding.action)} / ${picked(weak.action)}`,
);
ok('暗棋结算前，桌面上只看得见张数', viewFor(hiding.state, 1).trick!.plays[0].pieceIds.length === 0);

console.log('\nhard 档：赢面 × 墩值（仍然只吃 View 那份信息）');
const grabStrong = kouTurn([id('黑炮'), id('红帅')], 'hard');
const grabWeak = kouTurn([id('黑炮'), id('黑士')], 'hard');
ok(
  '桌上已经躺着一枚，抢下来值两枚：hard 肯用红车，greedy 只会喂卒',
  grabStrong.action.kind === 'follow' && picked(grabStrong.action) === '红车',
  `${grabStrong.action.kind}:${picked(grabStrong.action)}`,
);
ok(
  'hard 也猜不出对手扣的是帅还是士：换掉那张，抢法一字不变',
  picked(grabWeak.action) === '红车',
  picked(grabWeak.action),
);
const leadKou = toPlay(createGame({ rules: base, players: 2, mode: 'kou', seed: 54 }), [[id('红车'), id('卒')], [id('黑士'), id('黑炮')]], 0);
const leadHard = choose(viewFor(leadKou, 0), legalActions(leadKou, 0), 'hard', mulberry32(3));
ok(
  '自己领出时桌面是空的，抢赢也只值一枚：hard 不砸红车，先丢卒',
  leadHard.kind === 'lead' && picked(leadHard) === '卒',
  `${leadHard.kind}:${picked(leadHard)}`,
);
const bigPot = toPlay(createGame({ rules: base, players: 4, mode: 'kou', seed: 55 }), [[id('红车')], [id('黑士')], [id('卒')], [id('黑炮')]], 1);
apply(bigPot, 1, { kind: 'lead', pieceIds: [id('黑士')] });
apply(bigPot, 2, { kind: 'follow', pieceIds: [id('卒')] });
apply(bigPot, 3, { kind: 'follow', pieceIds: [id('黑炮')] });
const grab4 = choose(viewFor(bigPot, 0), legalActions(bigPot, 0), 'hard', mulberry32(3));
ok(
  '四家局桌上已经躺了三枚：轮到最后一家，hard 用红车收这一墩',
  grab4.kind === 'follow' && picked(grab4) === '红车',
  `${grab4.kind}:${picked(grab4)}`,
);
const mingView = toPlay(createGame({ rules: base, players: 2, mode: 'ming', seed: 53 }), [[id('黑炮'), id('黑士')], [id('卒'), id('卒')]], 0);
apply(mingView, 0, { kind: 'lead', pieceIds: [id('黑炮')] });
ok('明棋里出过的牌面是公开的，暗棋才扣', viewFor(mingView, 1).trick!.plays[0].pieceIds.join() === String(id('黑炮')));
const mingDiscard = choose(viewFor(mingView, 1), legalActions(mingView, 1), 'greedy', mulberry32(3));
ok(
  '明棋里它看得见那是一张黑炮，压不过就弃最小的',
  mingDiscard.kind === 'discard' && picked(mingDiscard) === '卒',
  `${mingDiscard.kind}:${picked(mingDiscard)}`,
);

console.log('\nAI 不许有固定套路：同分的走法要随机挑（网页的电脑座位走的就是这个 choose）');

/** 全程用某个档位打一局，记它每次抽签点了哪一摞、每次分牌挑了哪种拿法 */
function aiChoices(level: Level, games: number): { stacks: number[]; ways: string[] } {
  const stacks: number[] = [];
  const ways: string[] = [];
  for (let g = 0; g < games; g++) {
    const state = createGame({ rules: base, players: 4, mode: 'kou', seed: 77000 + g * 31 });
    const rng = mulberry32(state.seed ^ 0x9e3779b9);
    let guard = 0;
    while (state.phase !== 'over' && guard++ < 3000) {
      const seat = currentActor(state)!;
      const actions = legalActions(state, seat);
      const action = choose(viewFor(state, seat), actions, level, rng);
      if (action.kind === 'draw') stacks.push(action.stackIdx);
      if (action.kind === 'allocate') ways.push(action.way);
      apply(state, seat, action);
    }
  }
  return { stacks, ways };
}

for (const level of ['greedy', 'hard'] as Level[]) {
  const { stacks, ways } = aiChoices(level, 20);
  const spread = new Set(stacks).size;
  ok(
    `${level} 抽签摊开在 8 摞上（20 局抽了 ${stacks.length} 次，踩过 ${spread} 个不同摞号）`,
    spread >= 5 && stacks.filter((p) => p === 0).length < stacks.length,
    stacks.join(','),
  );
  // 处置人那三种拿法也一样：只会被网页的电脑永远选「层层轮流分」，那分牌就成了套路
  ok(
    `${level} 分牌三种拿法都选过（${ways.join(',').slice(0, 60)}…）`,
    new Set(ways).size === 3,
    [...new Set(ways)].join('|'),
  );
}
const easyStacks = aiChoices('easy', 20).stacks;
ok(
  'easy 本来就是随机选，改同分逻辑没把它改死',
  new Set(easyStacks).size >= 5,
  easyStacks.join(','),
);
console.log('\n跨局驱动：上一局赢家担任下一局起抽人');
const matchImport = await import('../core/match.ts');
const { nextDrawer, openMatch, recordGame, winners } = matchImport;

/** 打出一局真局，再把收牌数摆成想要的名次（只用来验跨局那几条判定） */
function played(won: number[], drawer: number): GameState {
  const state = createGame({ rules: base, players: won.length, mode: 'kou', seed: 61, drawer });
  playOut(state);
  state.won = [...won];
  return state;
}

const soloWin = played([19, 13], 0);
ok('唯一赢家 → 下一局他起抽', winners(soloWin).join() === '0' && nextDrawer(soloWin) === 0);
const tieGame = played([16, 16], 1);
ok('并列 → 沿用这一局的起抽人，签不换手', winners(tieGame).length === 2 && nextDrawer(tieGame) === 1);
const nothing = played([0, 0], 1);
ok('一张没收到也算并列：不加冕、签不动', winners(nothing).length === 0 && nextDrawer(nothing) === 1);
const appoint = createGame({ rules: base, players: 4, mode: 'ming', seed: 62, drawer: 2 });
ok('指定起抽人：摆摞阶段认他', appoint.drawer === 2 && appoint.draft!.drawer === 2);
playOut(appoint);
ok('打完一局 state.drawer 还在（驱动层不用翻抽签记录）', appoint.drawer === 2 && appoint.draft === null);
let earlyThrow = '';
try {
  nextDrawer(createGame({ rules: base, players: 2, mode: 'ming', seed: 63 }));
} catch (e) {
  earlyThrow = String((e as Error).message);
}
ok('没打完就想定下一局起抽人 → 直接报错', earlyThrow.includes('还没打完'), earlyThrow);

const book = openMatch(4);
const chainGames = 60;
let want = -1;
let chainBad = '';
for (let g = 0; g < chainGames; g++) {
  const state = createGame({
    rules: base,
    players: 4,
    mode: 'ming',
    seed: 3000 + g * 13,
    ...(g === 0 ? {} : { drawer: want }),
  });
  if (g > 0 && state.drawer !== want) chainBad = `第 ${g + 1} 局起抽人成了 ${state.drawer}，应为 ${want}`;
  playOut(state);
  recordGame(book, state);
  want = nextDrawer(state);
}
ok(`${chainGames} 局连环：赢家起抽的链条一局没断`, chainBad === '', chainBad);
ok(
  `总账收牌 ${book.cards.reduce((a, b) => a + b, 0)} 枚 = ${TOTAL} × ${chainGames}`,
  book.cards.reduce((a, b) => a + b, 0) === TOTAL * chainGames,
);
ok(
  `局数守恒：games ${book.games} = 起抽人次 ${book.draws.reduce((a, b) => a + b, 0)} = 加冕 ${book.titles.reduce((a, b) => a + b, 0)} + 并列 ${book.ties}`,
  book.games === chainGames &&
    book.draws.reduce((a, b) => a + b, 0) === chainGames &&
    book.titles.reduce((a, b) => a + b, 0) + book.ties === chainGames,
);
ok(
  `起抽夺冠率不超过起抽次数：${book.draws.map((n, seat) => `${seatName(seat)} ${book.drawWins[seat]}/${n}`).join('  ')}｜累计夺冠 ${book.titles.reduce((a, b) => a + b, 0)} 局`,
  book.drawWins.every((w, seat) => w <= (book.draws[seat] ?? 0)) &&
    book.drawWins.reduce((a, b) => a + b, 0) <= book.titles.reduce((a, b) => a + b, 0),
);

console.log('\n换人数那本账：只发新本，不伸缩老本（口径钉在 openMatch，桌那一头钉在 net.test.ts）');
{
  // 一句「重开」要真重开，就得保证发下来的新本一格不多一格不少：
  // 洞（undefined）和串位（人数比本子多）都会把后面的 recordGame 变成 NaN
  for (const n of [2, 4]) {
    const b = openMatch(n);
    ok(
      `${n} 人的新本子：四条账目各 ${n} 个数，局数和并列都是 0`,
      [b.draws, b.drawWins, b.titles, b.cards].every(
        (a) => a.length === n && a.every((x) => Number.isFinite(x)),
      ) && b.games === 0 && b.ties === 0,
      JSON.stringify(b),
    );
  }
  // 4 人局那一局整本记进 4 位的本子：新座位（P3、P4）落得进格子，各项加总跟牌局对得上
  const b = openMatch(4);
  const one = played([11, 9, 13, 7], 3);
  recordGame(b, one);
  ok(
    '4 人局记满一本：局数 1、起抽人次 1、收牌 40 枚、夺冠那位是 P3',
    b.games === 1 &&
      b.draws.reduce((a, c) => a + c, 0) === 1 &&
      b.draws[3] === 1 &&
      b.cards.reduce((a, c) => a + c, 0) === 40 &&
      b.titles[2] === 1 &&
      b.ties === 0,
    JSON.stringify([b.games, b.draws, b.titles, b.cards]),
  );
  let hole = '';
  for (const a of [b.draws, b.drawWins, b.titles, b.cards])
    if (a.some((n) => typeof n !== 'number')) hole = JSON.stringify(a);
  ok('记过一局之后本子里没有一处不是数', hole === '', hole);
}

console.log('\n守恒与收敛（每种局面各 200 局）');
for (const players of [2, 4]) {
  for (const mode of ['ming', 'kou'] as const) {
    let bad = '';
    for (let g = 0; g < 200; g++) {
      const state = createGame({ rules: base, players, mode, seed: 5000 + g * 31 });
      playOut(state);
      const total = state.won.reduce((a, b) => a + b, 0) + state.hands.reduce((a, h) => a + h.length, 0);
      if (total !== TOTAL) bad = `收牌+手牌 = ${total}，应为 ${TOTAL}`;
      if (state.phase !== 'over') bad = `没走到 end：${state.phase}`;
    }
    ok(`${players} 人 ${mode}：牌数守恒且能终局`, bad === '', bad);
  }
}

console.log('\n座位不该有必胜优势（各 400 局，收牌占比 15%~35%）');
for (const mode of ['ming', 'kou'] as const) {
  const games = 400;
  const won = [0, 0, 0, 0];
  let total = 0;
  const tally = [0, 0, 0, 0];
  for (let g = 0; g < games; g++) {
    const state = createGame({ rules: base, players: 4, mode, seed: 900 + g * 17 });
    playOut(state);
    tally[finalRank(state)[0]]++;
    state.won.forEach((w, i) => (won[i] += w));
    total += state.won.reduce((a, b) => a + b, 0);
  }
  const shares = won.map((w) => w / total);
  const rates = tally.map((t) => t / games);
  ok(
    `4人 ${mode}：收牌占比 ${shares.map((s) => (s * 100).toFixed(0) + '%').join(' ')}｜胜率 ${rates.map((s) => (s * 100).toFixed(0) + '%').join(' ')}`,
    shares.every((s) => s > 0.15 && s < 0.35) && rates.every((s) => s > 0.1 && s < 0.4),
  );
}

console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
