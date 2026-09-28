/**
 * 联机层测试：桌（权威状态、令牌、代打、落盘）+ 打码快照 + 手写 WebSocket 服务端。
 * 线上一句字节怎么走那道门（gate）也在这一节测：三种下场——递到桌前、回句人话、只请这一条连接下桌。
 * 全部在 Node 里跑，不碰浏览器、不碰真网络，靠假时钟和假连接把整局打完。
 */
import { createServer, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { pendingSeats, type Action, type GameState } from '../core/game.ts';
import { openMatch } from '../core/match.ts';
import { loadRules } from '../node/load_rules.ts';
import { gate, intFlag, setupFrom, type Verdict } from '../node/room.ts';
import { Table, IDLE_MS, NICK_MAX, TAKEOVER_MS, type TableSetup } from '../net/table.ts';
import {
  checkHost,
  fullWire,
  hydrate,
  snapshotFor,
  type ToClient,
  type ToHost,
  type WirePiece,
  type WireState,
} from '../net/wire.ts';
import { WsServer } from '../net/ws.ts';
import { layout, type Board, type TableView } from '../web/board.ts';

let failures = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const rules = loadRules();

/** 假时钟：30 秒代打这种事，等真 30 秒就没人跑测试了 */
class Clock {
  t = 1_000;
  now = () => this.t;
  step(ms: number): void {
    this.t += ms;
  }
}

type StatePush = Extract<ToClient, { t: 'state' }> & { seat: number };

/** 桌发出去的每一份快照都收在这儿，按座位分堆 */
interface Inbox {
  all: { seat: number; msg: ToClient }[];
  count(seat: number): number;
  last(seat: number): StatePush;
}

function makeTable(setup: Partial<TableSetup> = {}, clock = new Clock()): {
  table: Table;
  inbox: Inbox;
  clock: Clock;
  logs: string[];
} {
  const all: { seat: number; msg: ToClient }[] = [];
  const logs: string[] = [];
  const full: TableSetup = { rules, players: 2, mode: 'kou', level: 'hard', seed: 7, ...setup };
  const table = new Table(
    full,
    (seat, msg) => {
      all.push({ seat, msg });
    },
    (line) => logs.push(line),
    clock.now,
  );
  const inbox: Inbox = {
    all,
    count(seat) {
      return all.filter((o) => o.seat === seat && o.msg.t === 'state').length;
    },
    last(seat) {
      for (let i = all.length - 1; i >= 0; i--) {
        const o = all[i]!;
        if (o.seat === seat && o.msg.t === 'state') return { ...o.msg, seat } as StatePush;
      }
      throw new Error(`座位 ${seat} 还没收到过快照`);
    },
  };
  return { table, inbox, clock, logs };
}

/**
 * 坐下并且按过开始的那张桌：绝大多数用例要演的是牌局，不是候场厅。
 * 候场那道闸门自己单开一组测。
 */
function openedTable(setup: Partial<TableSetup> = {}, seats = [0, 1]): {
  table: Table;
  inbox: Inbox;
  clock: Clock;
  logs: string[];
} {
  const h = makeTable(setup);
  for (const s of seats) h.table.join(s, '');
  const r = h.table.start(setup.hostSeat ?? 0);
  if (!r.ok) throw new Error(`开局没成：${r.why}`);
  return h;
}

/** 快照里按 id 找那张牌；id 不连续也不至于查错 */
function pieceOf(view: WireState, id: number): WirePiece | undefined {
  return view.pieces.find((p) => p.id === id);
}

/** 把摆牌阶段一路走完：抽签 → 分牌 */
function finishDraft(table: Table): void {
  const state = table.state;
  let guard = 0;
  while (state.phase === 'draft') {
    if (++guard > 20) throw new Error('摆牌阶段走不完');
    const who = pendingSeats(state)[0]!;
    table.act(who, table.legalFor(who)[0]!);
  }
}

/** 此刻这一手里出的那几张牌 */
function playedIds(action: Action): number[] {
  return 'pieceIds' in action ? [...action.pieceIds] : [];
}

/** 快照要演的那一手，测试里就按「谁·什么」这一个串来看 */
function keyOf(push: StatePush): string {
  return push.last ? `${push.last.seat}:${push.last.action.kind}` : '—';
}

/** 表现层自己攒的那份 view 的空壳，和 app.ts 的 freshView 同一个模子（TableView 少一个字都会编译不过） */
function blankView(players: number, mine: number): TableView {
  return {
    mine,
    piles: Array.from({ length: players }, () => [] as number[]),
    sel: new Set(),
    hint: new Set(),
    justWon: new Set(),
    freeze: null,
    deal: false,
    holdDown: new Set(),
    peek: new Set(),
    hover: null,
    pick: null,
    lift: null,
    spread: false,
  };
}

/** 照 app.ts 里 rebuildPiles 那个口径摊收牌摞：不在手里、不在桌上的那些，按 won 的数目分给各家 */
function pilesOf(state: GameState): number[][] {
  const loose = new Set(state.pieces.map((p) => p.id));
  for (const ids of [...state.hands, ...(state.draft?.stacks ?? [])]) for (const id of ids) loose.delete(id);
  const trick = state.trick;
  for (const ids of [...(trick?.plays ?? []), ...(trick?.discards ?? [])].map((p) => p.pieceIds))
    for (const id of ids) loose.delete(id);
  const pool = [...loose].sort((a, b) => a - b);
  let at = 0;
  return state.won.map((n) => pool.slice(at, (at += n)));
}

// ───────────────────────── 候场厅这道闸门 ─────────────────────────

{
  // 房主没按开始之前：谁都不许动牌，桌也一律不催
  const { table, inbox, clock, logs } = makeTable();
  const state = table.state;
  table.join(0, '');
  table.join(1, '');
  const before = JSON.stringify(fullWire(state));
  const drawer = state.drawer;
  const r = table.act(drawer, table.legalFor(drawer)[0]!);
  ok('候场时递上来的动作一律拒', !r.ok && r.why === '这桌还在候场，等房主按开始');
  ok('被拒之后牌面一个字没动', JSON.stringify(fullWire(state)) === before);
  clock.step(TAKEOVER_MS * 10);
  table.tick();
  ok('候场时等满五分钟也没人代打', state.draft!.stackIdx === -1 && !logs.some((l) => l.includes('替他打')));
  ok('候场时座位表上没有电脑位：真人位要等开局那一刻才定', table.seatInfo().every((s) => !s.ai && !s.human));
  ok('候场时坐下的人不算排队：候场厅就该数他坐着', table.seatInfo().every((s) => !s.queued));
  ok('候场时坐下也不播报「先由电脑打」：那话得等开打了才说得出', !logs.some((l) => l.includes('这一局先由电脑打')));
  ok('候场那份快照一张牌都没出', inbox.last(0).view.phase === 'draft' && inbox.last(0).status === 'waiting');
  ok('候场那份快照不给合法着法', inbox.last(0).acts.length === 0 && inbox.last(1).acts.length === 0);
  ok('不是房主按不动开始', !table.start(1).ok);
  ok('房主一按就开局', table.start(0).ok && table.lobby().status === 'playing');
  ok('开局那份快照不带要演的手', inbox.last(1).last === null && inbox.last(1).status === 'playing');
  ok('开局以后才动得了牌', table.act(state.drawer, table.legalFor(state.drawer)[0]!).ok);
  const mid = JSON.stringify(fullWire(state));
  const again = table.start(0);
  ok('开打了房主自己也按不动下一局：那一按得等这一局打完', !again.ok && again.why === '这一局正在打');
  ok('那一按也没把牌桌换新', JSON.stringify(fullWire(state)) === mid && table.lobby().gameNo === 1);
}

{
  // 开局以后才进来的人：椅子给他留着，这一局先由电脑打，下一局开局才归他
  const { table, inbox, clock } = makeTable({ players: 4 });
  const state = table.state;
  table.join(0, '');
  table.start(0);
  ok('开局那一刻定下的真人位', table.seatInfo()[0]!.human && !table.seatInfo()[0]!.queued);
  ok('没坐人的位子这一局由电脑补', table.seatInfo().slice(1).every((s) => s.ai && !s.human));
  const late = table.join(2, '');
  ok('中途入座的 welcome 说清桌正在打', late.ok && late.msg?.t === 'welcome' && late.msg.status === 'playing');
  ok('中途坐下这一局不算他的', table.seatInfo()[2]!.queued && table.seatInfo()[2]!.ai);
  ok('排队那位那份快照一颗着法都不给', inbox.last(2).acts.length === 0);
  const lr = table.act(2, table.legalFor(2)[0]!);
  ok('这一局他递什么都拒', !lr.ok && lr.why === '你来得晚了，这一局先由电脑打，下一局归你');
  ok('拒完牌面没动', state.draft!.stackIdx === -1);
  playToEnd(table, clock);
  ok('一局打完桌自己退回候场厅', state.phase === 'over' && table.lobby().status === 'waiting');
  table.start(0);
  ok('下一局开局，排队那位不再排', table.seatInfo().every((s) => !s.queued));
  ok('他的位子这一局归他打', table.seatInfo()[2]!.human && !table.seatInfo()[2]!.ai);
  // 真轮到他那一手才验递得上：排队那道闸门挡不挡人，得看在场的牌上
  let his = false;
  let why = '';
  for (let i = 0; i < 10 && !his; i++) {
    const seat = pendingSeats(table.state).find((s) => !table.seatInfo()[s]!.queued);
    if (seat === undefined) {
      clock.step(TAKEOVER_MS + 1);
      table.tick();
      continue;
    }
    const r = table.act(seat, table.legalFor(seat)[0]!);
    if (seat === 2) {
      his = r.ok;
      why = `${r.ok} ${r.why ?? ''}`;
    }
  }
  ok('下一局真轮到他，那一手递得上', his, why);
}

{
  // 掉线又回来的：这一局就交还，不用等下一局——他开局时就算过真人位
  const { table, clock } = makeTable();
  table.join(0, '');
  const join1 = table.join(1, '');
  const token1 = join1.msg?.t === 'welcome' ? join1.msg.token : '';
  table.start(0);
  table.leave(1);
  ok('掉线那位还算这一局的真人位', table.seatInfo()[1]!.human && !table.seatInfo()[1]!.queued);
  clock.step(TAKEOVER_MS + 1);
  table.tick();
  ok('掉线满 30 秒交给电脑打', table.seatInfo()[1]!.ai);
  table.join(1, token1);
  ok('人一回来就把牌权交还', !table.seatInfo()[1]!.ai && !table.seatInfo()[1]!.queued);
}

{
  // 让座：椅子还回候场厅，令牌一并抹掉，这桌才减得下人
  const { table } = makeTable({ players: 4 });
  table.join(0, '');
  table.join(2, '');
  table.join(3, '');
  ok('房主不能让座', !table.stand(0).ok && table.stand(0).why === '房主不能让座，这桌得有人开局');
  ok('没坐过的人让不了座', !table.stand(1).ok);
  ok('P4 让了座', table.stand(3).ok);
  ok('让完那把椅子彻底空了', !table.seatInfo()[3]!.taken && !table.seatInfo()[3]!.online);
  ok('还坐着两个人时减不到 2 人', !table.changeSetup(0, { players: 2 }).ok);
  ok('还坐着两个人时减不到 3 人', !table.changeSetup(0, { players: 3 }).ok);
  ok('P3 也让了', table.stand(2).ok);
  ok('人都站开了就减得下来', table.changeSetup(0, { players: 2 }).ok && table.lobby().players === 2);
  ok('减完只剩两把椅子，牌也照新人数重洗', table.state.players === 2 && table.seatInfo().length === 2);
  ok('房主那把椅子还在他名下', table.seatInfo()[0]!.taken && table.seatInfo()[0]!.online);
  ok('开打以后不让让座', table.start(0).ok && !table.stand(1).ok);
}

{
  // 候场厅里改配置：谁改得动、改完哪些跟着变
  const { table, inbox } = makeTable({ players: 4 });
  const first = table.state;
  table.join(0, '');
  table.join(1, '');
  ok('不是房主改不了配置', !table.changeSetup(1, { mode: 'ming' }).ok);
  ok('人数不在档位上改不了', !table.changeSetup(0, { players: 3 }).ok && table.lobby().players === 4);
  ok('递个跟现在一样的配置过去，什么也不动', table.changeSetup(0, { players: 4 }).ok && table.state === first);
  ok('只改电脑水平不动牌面', table.changeSetup(0, { level: 'easy' }).ok && table.state === first && table.lobby().level === 'easy');
  ok('坐过的两位还坐着，没坐的那两把没被算成电脑位', table.seatInfo().slice(0, 2).every((s) => s.taken && s.online) && !table.seatInfo()[3]!.ai);
  ok('改成明棋要重洗一副', table.changeSetup(0, { mode: 'ming' }).ok && table.state !== first && table.lobby().mode === 'ming');
  ok('重洗的这副照样 32 枚', table.state.pieces.length === 32);
  ok('改完座位表跟着涨缩，坐着的人不用重坐', table.seatInfo().length === 4 && table.seatInfo().slice(0, 2).every((s) => s.taken && s.online));
  ok('候场那份快照里的新配置也发给了客户端', inbox.last(0).view.mode === 'ming');
  table.join(2, '');
  ok('人数往下减时有人坐着就不让减', !table.changeSetup(0, { players: 2 }).ok);
  table.start(0);
  ok('开打了改不了配置', !table.changeSetup(0, { mode: 'kou' }).ok);
  ok('开局那一刻没人坐的位子交给电脑补', table.seatInfo()[3]!.ai);
  ok('开局把排队的都清了', table.seatInfo().every((s) => !s.queued));
}

// ───────────────────────── 自动入座挑的那把椅子 ─────────────────────────

{
  // 扫码／链接进来那句 seat:-1 归桌挑（客户端各挑各的，两台手机撞同一个码一定撞同一把）
  const { table } = makeTable({ players: 4 });
  ok('一张空桌：绕开房主位，挑头一把没人坐过的', table.freeSeat() === 1, `${table.freeSeat()}`);
  table.join(1, '');
  ok('头一把被占了就往后挪', table.freeSeat() === 2, `${table.freeSeat()}`);
  table.join(2, '');
  table.join(3, '');
  ok('非房主位坐满了就不硬挤（回 null，界面退回让人自己挑）', table.freeSeat() === null, `${table.freeSeat()}`);
  ok('让了座那把跟着回到可挑的清单里', table.stand(2).ok && table.freeSeat() === 2);

  {
    // 房主位留给开桌那位：它空着也不自动给，那是「坐下 · 当房主」那一次真有意义的选择
    const two = makeTable({ players: 2 });
    ok('两人群桌只剩房主位空着：不自动给', two.table.freeSeat() === 1);
    two.table.join(1, '');
    // 客人先坐下只算代持（settleHost 那条老规矩）：真正要钉的是「家」那把没被自动发出去
    ok(
      '客人先坐下只算代持，「家」那把还空着、也不再自动给',
      two.table.lobby().hostSeat === 1 && !two.table.seatInfo()[0]!.taken && two.table.freeSeat() === null,
    );
    two.table.join(0, '');
    ok('开桌那位一坐回家那把，房主位当场交回', two.table.lobby().hostSeat === 0);
  }
  {
    // 掉线那把椅子还在原主人名下：自动入座不许把他人的位子发出去
    const back = makeTable({ players: 4 });
    const j = back.table.join(1, '');
    const tk = j.msg?.t === 'welcome' ? j.msg.token : '';
    back.table.leave(1);
    ok('掉线那把还挂着「有主」', back.table.seatInfo()[1]!.taken && !back.table.seatInfo()[1]!.online);
    ok('自动入座绕开掉线那把', back.table.freeSeat() === 2);
    ok('凭令牌照旧坐得回原来那把（那条路不走自动入座）', back.table.join(1, tk).ok);
  }
  {
    // 房主位不在第 1 把（命令行 --host-seat 指过、或候场厅里交接过）时也照样绕开
    const shifted = makeTable({ players: 4, hostSeat: 2 });
    ok('房主位挪到第 3 把：跳的还是那把', shifted.table.freeSeat() === 0, `${shifted.table.freeSeat()}`);
    shifted.table.join(0, '');
    shifted.table.join(1, '');
    shifted.table.join(3, '');
    ok('只剩房主位空着时不自动给', shifted.table.freeSeat() === null);
  }
}

// ───────────────────────── 一句话过闸：不合形的进不了桌 ─────────────────────────

{
  const pass = (raw: unknown): ToHost | string => checkHost(raw, 4, rules);
  const why = (raw: unknown): string => {
    const r = pass(raw);
    return typeof r === 'string' ? r : '';
  };
  const held = (raw: unknown): ToHost | null => {
    const r = pass(raw);
    return typeof r === 'string' ? null : r;
  };

  ok('候场厅那一句问座位表认', held({ t: 'lobby' })?.t === 'lobby');
  ok('按开始认', held({ t: 'start' })?.t === 'start');
  ok('让座认', held({ t: 'stand' })?.t === 'stand');
  ok('寻同网桌那句认', held({ t: 'find' })?.t === 'find');
  ok('寻桌那句不多带野字段', JSON.stringify(held({ t: 'find', 顺手: '抹掉' })) === '{"t":"find"}');
  ok('清账重开那句认', held({ t: 'reset' })?.t === 'reset');
  ok('清账那句不多带野字段', JSON.stringify(held({ t: 'reset', 顺手: '抹掉' })) === '{"t":"reset"}');
  ok('探活那句原样递（连它带的时间戳一起）', JSON.stringify(held({ t: 'ping', at: 1234 })) === '{"t":"ping","at":1234}');
  ok('带整数座位的入座认', held({ t: 'join', seat: 2, token: 'tk', nick: 'AB' })?.t === 'join');
  ok('没报代号也算一句完整的入座', held({ t: 'join', seat: 0, token: '' })?.t === 'join');
  ok('seat 写成 -1 认得（「给我挑一把空椅」，扫码进来那一路）', held({ t: 'join', seat: -1, token: '' })?.t === 'join');
  ok('那句 -1 不多带野字段，座位仍是一个数', JSON.stringify(held({ t: 'join', seat: -1, token: '', 顺手: '抹掉' })) === '{"t":"join","seat":-1,"token":""}');
  ok('改配置挑得到的组合认', held({ t: 'setup', players: 2, mode: 'kou', level: 'easy' })?.t === 'setup');
  ok('出牌那一手照原样的那几张认', JSON.stringify(held({ t: 'act', action: { kind: 'lead', pieceIds: [7, 3, 7] } })) === '{"t":"act","action":{"kind":"lead","pieceIds":[7,3,7]}}');
  ok('摸签认到摞就够（那张由桌来翻）', JSON.stringify(held({ t: 'act', action: { kind: 'draw', stackIdx: 3 } })) === '{"t":"act","action":{"kind":"draw","stackIdx":3}}');
  ok('触屏摸签带的那张认', held({ t: 'act', action: { kind: 'draw', stackIdx: 1, pieceId: 9 } })?.t === 'act');
  ok('分牌挑哪种切法都认', held({ t: 'act', action: { kind: 'allocate', way: 'stacks-right' } })?.t === 'act');
  ok('不出一张的那句认', JSON.stringify(held({ t: 'act', action: { kind: 'noop' } })) === '{"t":"act","action":{"kind":"noop"}}');
  ok('认下来的那句里不多带野字段', JSON.stringify(held({ t: 'start', 顺手: '抹掉' })) === '{"t":"start"}');
  ok(
    '改配置那句带的野字段也不跟着往下递',
    JSON.stringify(held({ t: 'setup', players: 2, 顺手: '抹掉' })) === '{"t":"setup","players":2}',
  );

  // 这几句都是实测能把桌打穿的：过不了闸就是它把整桌救下来
  ok('座位写成字符串就坐不下（椅子占上却收不到快照）', why({ t: 'join', seat: '1', token: '' }).length > 0);
  ok('座位是小数坐不下', why({ t: 'join', seat: 1.5, token: '' }).length > 0);
  ok('座位超出这桌的椅子数坐不下', why({ t: 'join', seat: 4, token: '' }).length > 0);
  ok('座位是 -2 坐不下（负数只认 -1 那一句「挑一把空椅」）', why({ t: 'join', seat: -2, token: '' }).length > 0);
  ok('座位是 -9 也坐不下', why({ t: 'join', seat: -9, token: '' }).length > 0);
  ok('令牌不是字坐不下', why({ t: 'join', seat: 1, token: 7 }).length > 0);
  ok('人数不在档位上改不动', why({ t: 'setup', players: 3 }).length > 0);
  ok('人数写成字符串改不动', why({ t: 'setup', players: '2' }).length > 0);
  ok('没听过的玩法进不了桌', why({ t: 'setup', mode: 'zzz' }).length > 0);
  ok('没听过的档位进不了桌', why({ t: 'setup', level: 'unheard' }).length > 0);
  ok('一手缺字段的不递到桌前（原来这一句能把房主进程打死）', why({ t: 'act', action: {} }).length > 0);
  ok('一手是 null 的不递到桌前', why({ t: 'act', action: null }).length > 0);
  ok('没听过的着手不收', why({ t: 'act', action: { kind: 'zoom' } }).length > 0);
  ok('lead 少一张不收', why({ t: 'act', action: { kind: 'lead' } }).length > 0);
  ok('出零张不收（引擎压根不认这一手）', why({ t: 'act', action: { kind: 'lead', pieceIds: [] } }).length > 0);
  ok('牌 id 掺进字不收', why({ t: 'act', action: { kind: 'lead', pieceIds: [1, 'x'] } }).length > 0);
  ok('牌 id 是小数不收', why({ t: 'act', action: { kind: 'lead', pieceIds: [1.2] } }).length > 0);
  ok('抽负数那一摞不收', why({ t: 'act', action: { kind: 'draw', stackIdx: -1 } }).length > 0);
  ok('抽的那一摞写成字符串不收', why({ t: 'act', action: { kind: 'draw', stackIdx: '0' } }).length > 0);
  ok('切法没听过不收', why({ t: 'act', action: { kind: 'allocate', way: 'middle' } }).length > 0);
  ok('探活的时间戳是 NaN 不收', why({ t: 'ping', at: Number.NaN }).length > 0);
  ok('没听过的话不收', why({ t: 'nope' }).length > 0);
  ok('一个数组不是话', why([1, 2]).length > 0);
  ok('null 不是话', why(null).length > 0);
  ok('一个字不是话', why('x').length > 0);
  ok('一个数不是话', why(42).length > 0);
}

// ───────────────────────── 线上来的字节过那道门：三种下场 ─────────────────────────

{
  // 上一节测的是闸本身，这一节测的是「收到字节 → 闸 → 该怎么办」这条缝：
  // 原来这句判断写在 WebSocket 的回调里，一句看不懂的话能把整个房主进程带走（全桌掉线），
  // 单拎成 gate 才有地方断言：抛错只关这一条线，认下来的那句才递到桌前。
  // 闸要是自己抛（兜底被拆掉那种），这句得当场记一条 ✗：不然整套连红字都打不出来，
  // 那把刀只量得到退出码，等于没闸。
  const v = (text: string, seats = 4): Verdict => {
    try {
      return gate(text, seats, rules);
    } catch (e) {
      ok('看不懂的那句该由 gate 咽下，不是抛出来', false, String((e as Error).message));
      return { close: '' };
    }
  };
  ok('合形的一句：原样递到桌前', (() => { const r = v('{"t":"start"}'); return 'msg' in r && r.msg.t === 'start'; })());
  ok('问座位表那句递得到', (() => { const r = v('{"t":"lobby"}'); return 'msg' in r && r.msg.t === 'lobby'; })());
  ok('寻同网桌那句递得到（不用先有椅子）', (() => { const r = v('{"t":"find"}'); return 'msg' in r && r.msg.t === 'find'; })());
  ok('出牌那一手整个原样递（连牌 id 一起）', (() => {
    const r = v('{"t":"act","action":{"kind":"lead","pieceIds":[7,3]}}');
    return 'msg' in r && JSON.stringify(r.msg) === '{"t":"act","action":{"kind":"lead","pieceIds":[7,3]}}';
  })());

  const close = (text: string): string => {
    const r = v(text);
    return 'close' in r ? r.close : '';
  };
  const reject = (text: string): string => {
    const r = v(text);
    return 'reject' in r ? r.reject : '';
  };

  // 这三句都是能把房主打死的原话：JSON 本身就抛在 JSON.parse 里
  ok('半截 JSON：关这一条线，不是全桌', close('{"t":"act","action":').includes('看不懂'));
  ok('一个字节都没有：同样只关这一条线', close('').includes('看不懂'));
  ok('不是 JSON 的一句闲话：也只关这一条线', close('把桌删了').includes('看不懂'));

  ok('合 JSON 不合形：回一句人话，线留着', reject('{"t":"nope"}').length > 0);
  ok('空对象回绝话', reject('{}').length > 0);
  ok('数组也算合 JSON：走回绝那条，不拆线', reject('[1,2]').length > 0 && close('[1,2]') === '');
  ok('座位超出这桌的椅子数：回绝话', reject('{"t":"join","seat":7,"token":""}').length > 0);
  ok('人数不在档位上：回绝话', reject('{"t":"setup","players":3,"mode":"kou","level":"easy"}').length > 0);
  ok('缺字段的野写法：回绝话而不是抛', reject('{"t":"act","action":{}}').length > 0);

  // 撞进 catch 的那一路：闸里真抛了（rules 一被读就炸，替 checkHost 撞上没见过的形状那一类 bug）
  // 也要只关这一条线，还带上为什么——不然终端上只剩「有人掉线了」
  const bomb = {
    get modes(): never {
      throw new Error('撞上了没见过的形状');
    },
    get playerCounts(): never {
      throw new Error('撞上了没见过的形状');
    },
  };
  const exploded = (() => {
    try {
      return gate('{"t":"setup","players":2,"mode":"kou","level":"easy"}', 2, bomb);
    } catch {
      return null;
    }
  })();
  ok('闸里抛出来的一句话：gate 自己咽下，只给一句 close', exploded !== null && 'close' in exploded);
  ok('close 那句带上为什么（终端上看得见是哪句字节闹的）', exploded !== null && 'close' in exploded && exploded.close.includes('没见过的形状'));
}

// ───────────────────────── 打完那一局的账：谁来结、结几回 ─────────────────────────

{
  // 局末停在候场厅，房主先在候场厅改了玩法再按开始：中间那一局不能凭空没了
  const { table, clock } = makeTable({ mode: 'kou' });
  table.join(0, '');
  table.join(1, '');
  table.start(0);
  finishDraft(table);
  const state1 = playToEnd(table, clock);
  const tie = state1.won[0] === state1.won[1];
  const top = tie ? -1 : state1.won[0]! > state1.won[1]! ? 0 : 1;
  ok('这一局确实打完了', state1.phase === 'over' && table.lobby().status === 'waiting');
  ok('局末那一刻这一局就记进账了（结算卡上那份累计得带着它）', table.book.games === 1 && table.gameNo === 1);
  ok('改玩法那一趟不会把它再结一遍', table.changeSetup(0, { mode: 'ming' }).ok && table.book.games === 1);
  ok('账上收的枚数就是刚打完那局', table.book.cards[0]! + table.book.cards[1]! === 32);
  ok('局号跟着账走：这副新牌是第 2 局', table.gameNo === 2);
  if (tie) ok('并列局不给人加冕', table.book.ties === 1 && table.book.titles.every((t) => t === 0));
  else ok('夺冠那位记上了', table.book.titles[top] === 1 && table.book.titles[1 - top] === 0);
  ok('新局还是两把椅子、32 枚', table.state.players === 2 && table.state.pieces.length === 32);
  if (!tie) ok('起抽人照旧往上一局的赢家传', table.state.drawer === top);
  ok('只改代打档位不该再结一遍', table.changeSetup(0, { level: 'easy' }).ok && table.book.games === 1 && table.gameNo === 2);
  ok('再按开始才结下一笔（没打完的这局不算）', table.start(0).ok && table.book.games === 1);
}

{
  // 换人数是另一码事：那本账本来就要重开，上一局赢家指的也不是那把椅子了
  const { table, clock, logs } = makeTable({ mode: 'ming', players: 4 });
  for (const s of [0, 1, 2, 3]) table.join(s, '');
  table.start(0);
  finishDraft(table);
  playToEnd(table, clock);
  // 打到第二局才减人：只打一局的话局号本来就还是 1，「局号跟着账回 1」这一步压根没演到
  table.start(0);
  finishDraft(table);
  playToEnd(table, clock);
  ok('换人数前那两局已经记上了', table.book.games === 2 && table.gameNo === 2);
  ok(
    'P3、P4 还坐着，减人这一趟挡在门口',
    !table.changeSetup(0, { players: 2 }).ok && table.book.games === 2 && table.state.players === 4,
  );
  table.stand(2);
  table.stand(3);
  ok('四个人改成两个人', table.changeSetup(0, { players: 2 }).ok && table.state.players === 2);
  ok(
    '换成两把椅子那本账跟着重开',
    table.book.games === 0 && table.gameNo === 1 && table.book.draws.every((d) => d === 0) &&
      table.book.cards.every((c) => c === 0) &&
      table.book.draws.length === 2,
    JSON.stringify([table.book.games, table.gameNo, table.book.draws, table.book.cards]),
  );
  ok(
    '重开之后四条账目都只剩两把椅子（打完那局不会串进新本子）',
    [table.book.draws, table.book.drawWins, table.book.titles, table.book.cards].every((a) => a.length === 2),
    JSON.stringify([table.book.drawWins, table.book.titles, table.book.cards]),
  );
  ok('候场厅里念得出来：人数变了，账是从重开的', logs.some((l) => l.includes('跨局那本账从重开')), logs.join('｜'));
  ok('新局里没有人还排着上一局的队', table.seatInfo().every((s) => !s.queued));
  // 重开不是只把老账抹了就算：新本子得接得住重开之后的那局，一位不落、一位不多
  table.start(0);
  finishDraft(table);
  playToEnd(table, clock);
  ok(
    '重开之后这一局的账记满了两把椅子：一局、32 枚、没有第三位',
    table.book.games === 1 &&
      table.gameNo === 1 &&
      table.book.cards.reduce((a, c) => a + c, 0) === 32 &&
      table.book.cards.length === 2 &&
      table.book.draws.reduce((a, c) => a + c, 0) === 1,
    JSON.stringify([table.book.games, table.gameNo, table.book.draws, table.book.cards]),
  );
}

{
  // 换人数时那把「人走了、凭令牌还得回来」的椅子：掉线计时得跟着椅子挪，不然是把永远收不回的椅子
  const { table, clock } = makeTable({ mode: 'kou', players: 4 });
  const r1 = table.join(1, '');
  table.join(0, '');
  const tok1 = r1.msg?.t === 'welcome' ? r1.msg.token : '';
  table.leave(1);
  ok(
    '后面那两把椅子空着，四个人减到两个减得下来',
    table.changeSetup(0, { players: 2 }).ok && table.seatInfo().length === 2,
  );
  ok('P2 那把椅子还记在他名下：令牌没丢、人也没连上', table.seatInfo()[1]!.taken && !table.seatInfo()[1]!.online);
  clock.step(IDLE_MS + 1);
  ok('满两分钟那一秒桌动了手（宿主该落一次盘）', table.tick());
  ok('那把椅子已经还给这桌', !table.seatInfo()[1]!.taken && !table.seatInfo()[1]!.online);
  ok('还给桌之后旧令牌不再挡人，凭它照样坐得回', table.join(1, tok1).ok);
}

// ───────────────────────── 清账重开：账归零，椅子一把不动 ─────────────────────────

{
  // 这本账活在桌那边，重启也照 `table.json` 接得回来：页面上没有第二个入口，
  // 「怎么这桌已经第 4 局了」就只能干瞪眼，所以候场厅得有一颗把账扔回 0 的
  const { table, inbox, clock, logs } = makeTable({ mode: 'ming' });
  const r1 = table.join(1, '');
  table.join(0, '');
  const tok1 = r1.msg?.t === 'welcome' ? r1.msg.token : '';
  table.start(0);
  finishDraft(table);
  playToEnd(table, clock);
  table.start(0);
  finishDraft(table);
  playToEnd(table, clock);
  ok('清之前那两局确实压在账上', table.book.games === 2 && table.gameNo === 2, `${table.gameNo}｜${table.book.games}`);
  ok('不是房主清不动，账照旧', !table.resetBook(1).ok && table.book.games === 2);
  ok(
    '房主清了：局号回 1，四条账目全归零',
    table.resetBook(0).ok &&
      table.gameNo === 1 &&
      table.book.games === 0 &&
      table.book.draws.every((d) => d === 0) &&
      table.book.cards.every((c) => c === 0) &&
      table.book.titles.every((t) => t === 0),
    JSON.stringify(table.book),
  );
  ok('牌面重摊了：不再是打完那一份', table.state.phase !== 'over' && table.state.pieces.length === 32);
  ok('候场厅里念得出来：这本是从零重新起的', logs.some((l) => l.includes('跨局那本归零')), logs.join('｜'));
  ok('椅子一把没动：他那把还记在他名下', table.seatInfo()[1]!.taken && table.seatInfo()[1]!.online && tok1.length > 0);
  ok(
    '下去的快照跟着归零（客户端不许留着老账）',
    inbox.last(1).book.games === 0 && inbox.last(1).gameNo === 1,
    JSON.stringify([inbox.last(1).gameNo, inbox.last(1).book.games]),
  );
  const twin = Table.load(table.save(), () => {}, () => {}, clock.now);
  ok('清完落盘、重启接回的还是清了的那本', twin.gameNo === 1 && twin.book.games === 0, JSON.stringify([twin.gameNo, twin.book.games]));
  ok('凭旧令牌还坐得回来：清的是账，不是座位', table.join(1, tok1).ok);
  // 归零不是把本子换成一张不会写字的白纸：清完接着打，这一局得照样落得进去
  table.start(0);
  finishDraft(table);
  playToEnd(table, clock);
  ok(
    '清完接着打完这一局：账上一笔、局号还是第 1 局、32 枚不落别人头上',
    table.book.games === 1 &&
      table.gameNo === 1 &&
      table.book.cards.reduce((a, c) => a + c, 0) === 32 &&
      table.book.cards.length === 2,
    JSON.stringify([table.gameNo, table.book.games, table.book.cards]),
  );
}

{
  // 开打之中不清：那一局的账还没落地，这会儿归零会让打完的人白打
  const { table } = makeTable({ mode: 'kou' });
  table.join(0, '');
  table.join(1, '');
  table.start(0);
  finishDraft(table);
  const r = table.resetBook(0);
  ok(
    '这一局正在打，清不动也不碰账',
    !r.ok && table.gameNo === 1 && (r.why ?? '').includes('正在打'),
    `${r.ok}｜${r.why ?? ''}`,
  );
}

// ───────────────────────── 那本账只有一本：随快照下去，存档里跟着走 ─────────────────────────

{
  // 客户端只画桌这本：它自己攒一本的话，改人数、重连、中途入座随便哪条路都会跟桌对不上号
  const { table, inbox, clock } = makeTable({ mode: 'kou' });
  table.join(0, '');
  table.join(1, '');
  table.start(0);
  finishDraft(table);
  ok('一局没打完：下去的账本是空的', inbox.last(1).book.games === 0);
  playToEnd(table, clock);
  ok('打完那一刻：下去的账本已经记上这一局', inbox.last(1).book.games === 1 && table.book.games === 1);
  ok('候场厅里改成四个人', table.changeSetup(0, { players: 4 }).ok && table.state.players === 4);
  table.join(2, '');
  table.join(3, '');
  ok('换人数之后下去的那份跟着重开，客户端不再留着老账', inbox.last(3).book.games === 0 && table.book.games === 0);
}

{
  // 入座那句话排在快照前面：客户端拿到快照时已经知道自己坐的是哪把椅子
  const { table, inbox } = makeTable({ mode: 'ming' });
  table.join(0, '');
  table.join(1, '');
  const mine = inbox.all.filter((o) => o.seat === 1);
  ok('新坐下的那位先收到 welcome，再收到快照', mine[0]?.msg.t === 'welcome' && mine[1]?.msg.t === 'state');
  ok('welcome 说的就是这把椅子', mine[0]?.msg.t === 'welcome' && mine[0].msg.seat === 1);
  ok('一条连接入座，桌只对它说这两句', mine.length === 2);
}

{
  // 存档得接上同一条随机流、同一串快照号：光存牌面，重启后下一副是把老牌重放一遍，
  // 还开着的那页更会从此一份不演——它只认比手上号新的快照
  const a = makeTable({ mode: 'ming', seed: 11 });
  a.table.join(0, '');
  a.table.join(1, '');
  a.table.start(0);
  finishDraft(a.table);
  playToEnd(a.table, a.clock);
  const seqSaved = a.inbox.last(1).seq;
  const json = a.table.save();
  a.table.start(0);
  const nextSeed = a.table.state.seed;
  // 只认流位，一把椅子都不坐：按下开始洗出来的那一副，得和没重启那桌的下一副严丝合缝
  const twin = Table.load(json, () => {}, () => {}, a.clock.now);
  twin.start(0);
  ok('重启后接着开的那局，种子跟没重启时是同一个', twin.state.seed === nextSeed, `${twin.state.seed} 对上 ${nextSeed}`);
  ok('刚打完那一局不会在重启后补记成两笔', twin.book.games === 1);

  // 坐回来每人要发一张令牌，那是在这条流上又走一步，所以这一路只对号、不对种子
  const got: { seat: number; msg: ToClient }[] = [];
  const restored = Table.load(
    json,
    (seat, msg) => got.push({ seat, msg }),
    () => {},
    a.clock.now,
  );
  restored.join(0, '');
  const first = got[got.length - 1]?.msg;
  ok(
    '重启后头一份快照的号接着往上走',
    !!first && first.t === 'state' && first.seq > seqSaved,
    `${first && first.t === 'state' ? first.seq : '-'} 对上 ${seqSaved}`,
  );

  // 他磁盘上躺着的那份老存档没这三个字段，账本里也还没记打完的这一局（老代码到按开始才记）：
  // 照那个口径接回来，别把整桌崩在 undefined 上
  const legacyJson = JSON.stringify({
    ...JSON.parse(json) as object,
    seq: undefined,
    booked: undefined,
    rngSteps: undefined,
    book: openMatch(2),
  });
  const legacy = Table.load(legacyJson, () => {}, () => {}, a.clock.now);
  ok(
    '老存档接回来：打完那一局还压在账外',
    legacy.state.phase === 'over' && legacy.state.players === 2 && legacy.book.games === 0,
  );
  legacy.join(0, '');
  legacy.start(0);
  ok('老存档那一局照旧在按开始那一刻补记，不多不少', legacy.book.games === 1, JSON.stringify(legacy.book));
}

// ───────────────────────── 命令行那几行参数：认不下就当场说 ─────────────────────────

{
  const shout = (argv: string[]): string => {
    try {
      setupFrom(argv, rules);
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  };
  const quiet = setupFrom([], rules);
  ok(
    '一行参数不给：默认两人、扣棋、hard、房主坐 P1',
    quiet.players === 2 && quiet.mode === 'kou' && quiet.level === 'hard' && quiet.hostSeat === 0 && Number.isInteger(quiet.seed),
  );
  const given = setupFrom(['--players', '4', '--mode=ming', '--level=easy', '--seed=7', '--host-seat', '3'], rules);
  ok('--名 值 和 --名=值 两种写法都认', given.players === 4 && given.mode === 'ming' && given.level === 'easy' && given.seed === 7 && given.hostSeat === 3);
  ok('空着等值（--players=）当没给，照默认来', setupFrom(['--players='], rules).players === 2);
  ok('--players=abc 说清是哪三个字，不抱着 NaN 开桌', shout(['--players=abc']).includes('abc'));
  ok('--players=3 不是这桌的档位', shout(['--players=3']).includes('2 或 4'));
  ok('--mode=明 认不出这种玩法', shout(['--mode=明']).includes('mode'));
  ok('--level=zzz 认不出这档', shout(['--level=zzz']).includes('level'));
  ok('--host-seat=9 超出一把椅子都没有', shout(['--host-seat=9']).length > 0);
  ok('--seed=-1 负数不接', shout(['--seed=-1']).length > 0);
  ok('--players=1.5 也不算整数', shout(['--players=1.5']).includes('players'));
  ok('--port 那行同样由这道闸兜：写歪了抛，不抛给 node 的 listen', (() => { try { intFlag(['--port=abc'], 'port', 5200, 1, 65535); return false; } catch { return true; } })());
  ok('端口不给就用默认值，给了 0 也算出界', intFlag([], 'port', 5200, 1, 65535) === 5200 && (() => { try { intFlag(['--port=0'], 'port', 5200, 1, 65535); return false; } catch { return true; } })());
}

// ───────────────────────── 一秒一次的表：动了手才要落盘 ─────────────────────────

{
  const { table, clock } = makeTable({ mode: 'kou' });
  table.join(0, '');
  table.join(1, '');
  table.start(0);
  ok('全桌都在想牌：这一秒一个字没改，别惊动硬盘', !table.tick());
  finishDraft(table);
  table.leave(0);
  table.leave(1);
  ok('两位刚下桌，还没到代打那三十秒：这一秒不动手', !table.tick());
  clock.step(TAKEOVER_MS);
  ok('到点那一下判了代打：那一秒动了手', table.tick() && table.seatInfo().every((s) => s.ai));
  const lines = table.state.log.length;
  ok('电脑替掉线那位落一手：这一秒同样算动了手', table.tick() && table.state.log.length > lines);
  let moved = 0;
  for (let i = 0; i < 600 && table.state.phase !== 'over'; i++) if (table.tick()) moved++;
  ok(
    '纯靠这一秒一次的表也能把一局走完',
    table.state.phase === 'over' && table.state.won[0]! + table.state.won[1]! === 32,
    `动手 ${moved} 秒，桌上收了 ${table.state.won[0]}+${table.state.won[1]} 枚`,
  );
  ok('一局打完桌自己退回候场厅', table.lobby().status === 'waiting');
}

// ───────────────────────── 打码快照 ─────────────────────────

{
  const { table } = openedTable({ mode: 'kou' });
  const state = table.state;
  finishDraft(table);
  const leader = pendingSeats(state)[0]!;
  const other = leader === 0 ? 1 : 0;
  const played = table.legalFor(leader)[0]!;
  table.act(leader, played);
  const ids = playedIds(played);
  const sealed = ids.filter((id) => !state.revealed.has(id));
  const view = snapshotFor(state, other, state.log.length);
  const own = snapshotFor(state, leader, state.log.length);
  ok('暗棋：首出这几张确实还扣着', ids.length > 0 && sealed.length === ids.length);
  ok('暗棋：别人刚出的牌，快照里只剩 id、没有牌名', sealed.every((id) => pieceOf(view, id)?.label === undefined));
  ok(
    '暗棋：自己刚出的那套亮给自己看（网页里鼠标压上去能看见，联机不能少这一口）',
    ids.every((id) => pieceOf(own, id)?.label !== undefined),
  );
  ok(
    '暗棋：出牌人自己的快照照样看不见对家手里的牌',
    state.hands[other].every((id) => pieceOf(own, id)?.label === undefined),
  );
  ok(
    '自己那 16 枚一律亮着',
    state.hands[other].every((id) => pieceOf(view, id)?.label !== undefined && pieceOf(view, id)?.tier !== undefined),
  );
  ok(
    '隐藏牌的 tier／color／point 一个都不许漏（给了 tier 等于没打码）',
    view.pieces.filter((p) => p.label === undefined).every((p) => p.tier === undefined && p.color === undefined && p.point === undefined),
  );
  ok('没公开的牌在快照里就是个光 id', Object.keys(pieceOf(view, sealed[0]!)!).join() === 'id');

  // 客户端拿这份快照还原出来的状态，偷偷读隐藏牌必须炸
  const back = hydrate(view);
  const hiddenId = sealed[0]!;
  let boom = '';
  try {
    void back.byId.get(hiddenId)!.label;
  } catch (e) {
    boom = String((e as Error).message);
  }
  ok('还原后的状态一读隐藏牌就抛错', boom.includes(String(hiddenId)), boom);
  ok('还原后的状态读自己看得见的牌正常', back.byId.get(state.hands[other][0]!)!.label.length > 0);
  let rolled = '';
  try {
    void back.rng();
  } catch (e) {
    rolled = String((e as Error).message);
  }
  ok('线上还原的状态不许掷骰子', rolled.includes('随机数'), rolled);
}

{
  // 明棋：出牌即亮，别家的快照里就该带牌名
  const { table } = openedTable({ mode: 'ming' });
  const state = table.state;
  finishDraft(table);
  const leader = pendingSeats(state)[0]!;
  const other = leader === 0 ? 1 : 0;
  const played = table.legalFor(leader)[0]!;
  table.act(leader, played);
  const ids = playedIds(played);
  const view = snapshotFor(state, other, state.log.length);
  ok('明棋：刚出的那几张当场对家看得见牌名', ids.length > 0 && ids.every((id) => pieceOf(view, id)?.label !== undefined));
  ok('明棋：刚落桌的牌进了 revealed 名单', ids.every((id) => state.revealed.has(id)));
}

// ───────────────────────── 快照摆得上版面 ─────────────────────────

/**
 * 浏览器那一头每一帧都是 layout(还原出来的状态)：打码留下的空位一旦被读到就抛错，
 * 牌名没到却画成正面就是一张空白牌。整局走一遍，两种玩法各查一遍。
 */
function sweepLayout(mode: 'ming' | 'kou'): void {
  const { table, clock } = openedTable({ mode });
  const state = table.state;
  const board: Board = { w: 900, h: 620 };
  let frames = 0;
  let bad = '';
  const once = (): void => {
    for (const seat of [0, 1]) {
      const raw = snapshotFor(state, seat, state.log.length);
      const labeled = new Set(raw.pieces.filter((p) => p.label !== undefined).map((p) => p.id));
      try {
        const back = hydrate(raw);
        const view = blankView(state.players, seat);
        view.piles = pilesOf(back);
        const trick = back.trick;
        if (trick) {
          view.freeze = trick.plays.map((p) => ({ seat: p.player, ids: [...p.pieceIds], pledge: false, best: false }));
          // 网页里鼠标压上来，自己那一套扣着的牌就亮给自己看——快照要是不带牌名，这儿就成空白牌了
          const own = [...trick.plays, ...trick.discards].find((p) => p.player === seat);
          if (own) view.peek = new Set(own.pieceIds);
        }
        for (const [id, placed] of layout(back, view, board)) {
          if (!placed.down && !labeled.has(id)) bad = `P${seat + 1} 把没牌名的第 ${id} 号画成了正面`;
        }
        frames++;
      } catch (e) {
        bad = `P${seat + 1} 排版读到了打码的空位：${String((e as Error).message)}`;
      }
    }
  };
  once();
  let guard = 0;
  while (state.phase !== 'over' && !bad) {
    if (++guard > 600) throw new Error('整局打不完');
    const who = pendingSeats(state);
    if (who.length === 0) {
      clock.step(TAKEOVER_MS + 1);
      table.tick();
      once();
      continue;
    }
    const seat = who[0]!;
    table.act(seat, table.legalFor(seat)[0]!);
    once();
  }
  ok(`${mode === 'kou' ? '扣棋' : '明棋'}：整局每一份快照都排得出版面`, bad === '' && frames >= 20, bad || `只排了 ${frames} 帧`);
}

sweepLayout('kou');
sweepLayout('ming');

// ───────────────────────── 越权与非法动作 ─────────────────────────

{
  const { table } = openedTable();
  const state = table.state;
  const who = pendingSeats(state)[0]!;
  const notYours = who === 0 ? 1 : 0;
  const before = JSON.stringify(fullWire(state));
  const r = table.act(notYours, { kind: 'draw', stackIdx: 0 });
  ok('不该你出的时候出手，直接拒', !r.ok && r.why === '这会儿不该你出');
  ok('被拒之后状态一个字没动', JSON.stringify(fullWire(state)) === before);

  const fake: Action = { kind: 'draw', stackIdx: 99 };
  const r2 = table.act(who, fake);
  ok('乱指一摞抽牌也是拒', !r2.ok && r2.why === '这手不合法');
  ok('桌不会替你落子', state.draft!.stackIdx === -1);

  // 触屏摸签那条路：客户端会点名那张牌，牌不在那一摞里就不许抽
  const bogus: Action = { kind: 'draw', stackIdx: 0, pieceId: state.draft!.stacks[1]![0]! };
  const r3 = table.act(who, bogus);
  ok('点名一张不在那摞里的牌，被拒', !r3.ok && r3.why === '那张不在这一摞里');
  ok('被拒之后那一摞一张没少', state.draft!.stackIdx === -1 && state.draft!.stacks[0]!.length === rules.draft.stackSize);
  const good: Action = { kind: 'draw', stackIdx: 0, pieceId: state.draft!.stacks[0]![0]! };
  ok('点名那一摞里确实有的那张，桌认', table.act(who, good).ok && state.draft!.stackIdx === 0);

  const d = pendingSeats(state)[0]!;
  ok('分牌递个没这名的方式，被拒', !table.act(d, { kind: 'allocate', way: '乱分' } as unknown as Action).ok);
  ok('分牌认到具体方式', table.act(d, { kind: 'allocate', way: 'layered' }).ok && state.phase !== 'draft');
}

{
  // 发牌之后：递一张不在自己手里的牌
  const { table } = openedTable({ mode: 'ming' });
  const state = table.state;
  finishDraft(table);
  const leader = pendingSeats(state)[0]!;
  const other = leader === 0 ? 1 : 0;
  const notMine = state.hands[other].find((id) => !state.hands[leader]!.includes(id))!;
  const r = table.act(leader, { kind: 'lead', pieceIds: [notMine] });
  ok('把别人的牌当自己的出，被拒', !r.ok);
  ok('被拒之后手里还是那 16 枚', state.hands[leader].length === 16 && !state.trick);
}

{
  // 同一套牌换个先后递上来，应当认作同一手
  const { table } = openedTable({ mode: 'ming' });
  finishDraft(table);
  const state = table.state;
  const leader = pendingSeats(state)[0]!;
  const group = table.legalFor(leader).find((a) => 'pieceIds' in a && a.pieceIds.length > 1);
  if (group && 'pieceIds' in group) {
    const flipped = { ...group, pieceIds: [...group.pieceIds].reverse() } as Action;
    ok('同一套牌倒着递，桌认', table.act(leader, flipped).ok);
  } else {
    const single = table.legalFor(leader).find((a) => 'pieceIds' in a && a.pieceIds.length === 1);
    ok('这局起手没有成组可出，改用单张验证同一手认得回', !!single && table.act(leader, single).ok);
  }
}

// ───────────────────────── 刚落的那一手 ─────────────────────────

{
  // 客户端照 last 演拍子：每一手只跟着那一份快照发一次，别家拿到的也是同一手
  const { table, inbox } = openedTable({ mode: 'kou' });
  const state = table.state;
  ok('入座、开局那几份都不带要演的手', inbox.last(0).last === null && inbox.last(1).last === null);
  const drawer = state.drawer;
  const draw = table.legalFor(drawer)[0]!;
  table.act(drawer, draw);
  const push = inbox.last(0);
  const want = draw.kind === 'draw' ? draw.stackIdx : -1;
  ok('抽签这一手原样发给两位', push.last !== null && push.last.seat === drawer && push.last.action.kind === 'draw');
  ok(
    '抽签带的是哪一摞',
    push.last !== null && push.last.action.kind === 'draw' && push.last.action.stackIdx === want,
  );
  const other = drawer === 0 ? 1 : 0;
  ok('两位拿到的是同一份 seq', inbox.last(other).seq === push.seq);
  const d = pendingSeats(state)[0]!;
  table.act(d, { kind: 'allocate', way: 'layered' });
  ok('分牌那一手发的是方式，不是整桌牌', inbox.last(0).last?.action.kind === 'allocate');
  const firstLead = pendingSeats(state)[0]!;
  table.act(firstLead, table.legalFor(firstLead)[0]!);
  // 落了三四手（抽签、分牌、首出），每手给两个座位各发一份，多出来的就是重演
  ok('一手只跟着那一份快照发出去', inbox.all.filter((o) => o.msg.t === 'state' && (o.msg as StatePush).last).length === 6);
  ok('最新那一份演的就是刚落的首出', keyOf(inbox.last(0)) === `${firstLead}:lead`, keyOf(inbox.last(0)));
  // 离席也会推一份新的，但那不是「谁落了一手」——这条专治 last 忘了清
  table.leave(other);
  ok('有人离席推的那一份也不带要演的手', inbox.last(drawer).last === null);
}

{
  // 掉线时错过的那几手不补演：回来那份 last 必须是空的，不然整桌牌回放一遍
  const { table, inbox } = makeTable({ mode: 'ming' });
  const state = table.state;
  table.join(0, '');
  const welcome1 = table.join(1, '');
  const token1 = welcome1.msg?.t === 'welcome' ? welcome1.msg.token : '';
  table.start(0);
  finishDraft(table);
  table.leave(1);
  const who = pendingSeats(state)[0]!;
  table.act(who, table.legalFor(who)[0]!);
  table.join(1, token1);
  const got = inbox.last(1);
  ok('重连那一份不带要演的手', got.last === null);
  ok('重连那份的牌面就是桌此刻的牌面', got.view.won.join() === state.won.join());
}

// ───────────────────────── 令牌与重连 ─────────────────────────

{
  const { table } = makeTable();
  const a = table.join(0, '');
  const token0 = a.msg?.t === 'welcome' ? a.msg.token : '';
  ok('第一次入座发令牌', token0.length > 8);
  const b = table.join(1, '');
  const token1 = b.msg?.t === 'welcome' ? b.msg.token : '';
  ok('空椅子随便坐', b.ok);
  const taken = table.join(0, '瞎猜的');
  ok('拿不到令牌就抢不回别人的椅子', !taken.ok && taken.why === '这把椅子坐了人');
  const bad = table.join(9, '');
  ok('没有第 10 号位', !bad.ok && bad.why!.includes('10'));
  ok('两个令牌照不一样', token0 !== token1);

  table.leave(1);
  const back = table.join(1, token1);
  ok('掉线后用令牌坐回原位', back.ok && back.msg?.t === 'welcome' && back.msg.seat === 1);
  const dup = table.join(1, '');
  ok('没令牌的人抢不回掉线者的椅子', !dup.ok);
  ok('座位表里两位都算在线', table.seatInfo().filter((s) => s.online).length === 2);
}

{
  // 掉线期间别人把牌打完几手，回来收到的那份必须和桌上的对得上
  const { table, inbox, clock } = makeTable({ mode: 'ming' });
  const state = table.state;
  table.join(0, '');
  const join1 = table.join(1, '');
  const token1 = join1.msg?.t === 'welcome' ? join1.msg.token : '';
  table.start(0);
  finishDraft(table);
  table.leave(1);
  const quiet = inbox.count(1);
  let moved = 0;
  for (let i = 0; i < 16 && state.phase !== 'over'; i++) {
    if (pendingSeats(state).includes(0)) {
      table.act(0, table.legalFor(0)[0]!);
      moved++;
    } else {
      clock.step(TAKEOVER_MS + 1);
      table.tick();
    }
  }
  ok('掉线这几手里另一位确实动了牌', moved >= 2 && state.won.reduce((a, b) => a + b, 0) > 0);
  ok('掉线期间一份快照也不发', inbox.count(1) === quiet);
  table.join(1, token1);
  const got = inbox.last(1).view;
  ok(
    '重连拿回的手牌张数和桌上的完全一致',
    got.hands.map((h) => h.length).join() === state.hands.map((h) => h.length).join(),
  );
  ok('重连拿回的收牌数一致', got.won.join() === state.won.join());
  ok('重连这一份里自己的牌全亮着', state.hands[1].every((id) => pieceOf(got, id)?.label !== undefined));
  ok('重连这一份里 phase／leader 跟桌一致', got.phase === state.phase && got.leader === state.leader);
}

// ───────────────────────── 候场期的椅子会过期 ─────────────────────────

{
  // 他换了张 Wi-Fi 就再也没回来：那把「掉线了，凭令牌坐得回来」的椅子不能永远占着，
  // 屏幕上少一把能坐的椅子，房主那颗开始也就永远点不出来
  const { table, inbox, clock, logs } = makeTable({ players: 4, mode: 'ming' });
  const w0 = table.join(0, '', 'AAA1').msg;
  const w1 = table.join(1, '', 'BBB2').msg;
  const t0 = w0?.t === 'welcome' ? w0.token : '';
  const t1 = w1?.t === 'welcome' ? w1.token : '';
  table.join(2, '', 'CCC3');
  table.leave(1);
  clock.step(IDLE_MS - 1);
  table.tick();
  ok('候场期掉线差一毫秒不到，椅子还归他', table.seatInfo()[1]!.taken && table.seatInfo()[1]!.nick === 'BBB2');
  ok('还连着的那两位两分钟到了也不许收', table.seatInfo()[0]!.online && table.seatInfo()[2]!.online);
  clock.step(2);
  table.tick();
  ok(
    '候场期掉线满两分钟：令牌、代号、连同一身的下标一起归零',
    table.seatInfo()[1]!.taken === false && table.seatInfo()[1]!.nick === '' && table.seatInfo()[1]!.online === false,
    JSON.stringify(table.seatInfo()[1]),
  );
  ok('收椅子有一句日志，念得出是哪一把', logs.some((l) => l.includes('还给这桌')), logs.join('｜'));
  ok('桌真等的那段时长，和日志里念的「两分钟」是同一件事', IDLE_MS === 120_000, `IDLE_MS=${IDLE_MS}`);
  ok('收完立刻广播一份，屏幕上那一行自己会变', inbox.last(0).seats[1]!.taken === false);
  const reold = table.join(1, t1);
  ok('旧令牌不作数了，但那把椅子谁都能坐', reold.ok && reold.msg?.t === 'welcome' && reold.msg.token !== t1);
  // 认回来那把还在的人不受牵连
  ok('另外两把椅子纹丝不动', table.seatInfo()[2]!.taken && table.join(0, t0).ok);
}

{
  // 房主那位走了再没回来：房主位得交给还坐在这桌的人，不然那颗开始永远点不出来
  const { table, clock, logs } = makeTable({ players: 2 });
  table.join(0, '', 'HOST1');
  table.join(1, '', 'GUEST2');
  ok('开局前房主位在 P1', table.lobby().hostSeat === 0);
  table.leave(0);
  clock.step(IDLE_MS + 1);
  table.tick();
  ok('P1 那把被收走了', table.seatInfo()[0]!.taken === false);
  ok('房主位交给了还连着的 P2', table.lobby().hostSeat === 1, logs.join('｜'));
  ok('交接写了一句，终端上看得见', logs.some((l) => l.includes('接过了房主位')), logs.join('｜'));
  ok('新房主按得动开始', table.start(1).ok && table.lobby().status === 'playing');
}

{
  // 一台设备都不剩时别硬派房主：那把椅子留在原地，屏幕上念「空房主位，谁先坐下谁当房主」
  const { table, clock } = makeTable({ players: 2 });
  table.join(0, '', 'ONLY01');
  table.leave(0);
  clock.step(IDLE_MS + 1);
  table.tick();
  ok(
    '一个活人都不剩：房主位留在原地当空位',
    table.lobby().hostSeat === 0 && table.seatInfo()[0]!.taken === false && table.seatInfo().every((s) => !s.online),
  );
}

{
  // 开打中那把椅子还等着人回来接着打，两分钟到了也不许收；一局打完回到候场厅才起算
  const { table, clock, logs } = makeTable({ players: 2 });
  table.join(0, '', 'HOST0');
  const w1 = table.join(1, '', 'BACK1').msg;
  const tk1 = w1?.t === 'welcome' ? w1.token : '';
  table.start(0);
  table.leave(1);
  clock.step(IDLE_MS * 3);
  table.tick();
  ok('开打中掉线满六分钟也不收椅子', table.seatInfo()[1]!.taken && table.seatInfo()[1]!.nick === 'BACK1');
  ok('开打中不该冒出一句「还给这桌」', !logs.some((l) => l.includes('还给这桌')), logs.join('｜'));
  playToEnd(table, clock);
  ok('一局打完桌自己回到候场厅', table.lobby().status === 'waiting');
  clock.step(IDLE_MS - 1);
  table.tick();
  ok('那两分钟从局末这一刻起算，差一毫秒椅子还归他', table.seatInfo()[1]!.taken === true);
  clock.step(2);
  table.tick();
  ok('局末再过两分钟，那把椅子才还给这桌', table.seatInfo()[1]!.taken === false);
  ok('旧令牌坐不回去了', table.join(1, tk1).ok && table.seatInfo()[1]!.nick === '');
}

// ───────────────────────── 超时代打 ─────────────────────────

{
  const { table, clock, logs } = openedTable();
  const state = table.state;
  // 起抽人这一位掉线，另一家在线——只有起抽人那手才是桌该替他动的
  const lazy = state.drawer;
  table.leave(lazy);
  clock.step(TAKEOVER_MS - 1);
  table.tick();
  ok('差一毫秒不到，桌不动手', state.draft!.stackIdx === -1 && !logs.some((l) => l.includes('由电脑替他打')));
  clock.step(2);
  table.tick();
  ok('掉线满 30 秒，起抽人那一手由桌替他抽了', state.draft!.stackIdx >= 0);
  ok('日志里写明白谁被代打了', logs.some((l) => l.includes('由电脑替他打')), logs.join('｜'));
  ok('代打后这一手的决定权按点数落定了', state.draft!.stage === 'allocate' && state.opening !== null);
}

{
  // 在线但在想牌的人，桌一律不催
  const { table, clock, logs } = openedTable();
  const state = table.state;
  clock.step(TAKEOVER_MS * 5);
  table.tick();
  ok('所有人都在线时，两分半也没有人代打', state.draft!.stackIdx === -1 && !logs.some((l) => l.includes('由电脑替他打')));
  ok('座位表里也没人被打上代打标记', table.seatInfo().every((s) => !s.ai));
}

{
  // 回来之后下一手交回给人，不是继续替他打到底
  const { table, clock } = makeTable();
  const state = table.state;
  const join0 = table.join(0, '');
  const join1 = table.join(1, '');
  const tokens = [join0.msg?.t === 'welcome' ? join0.msg.token : '', join1.msg?.t === 'welcome' ? join1.msg.token : ''];
  table.start(0);
  const lazy = state.drawer;
  table.leave(lazy);
  clock.step(TAKEOVER_MS + 1);
  table.tick();
  ok('掉线那位被代打了一手抽签', state.draft!.stackIdx >= 0);
  table.join(lazy, tokens[lazy]!);
  clock.step(TAKEOVER_MS * 3);
  table.tick();
  ok(
    '回来后分牌这一手归他自己，桌不接着替他分',
    state.hands.every((h) => h.length === 0) && !table.seatInfo()[lazy]!.ai,
  );
}

// ───────────────────────── 日志截断 ─────────────────────────

{
  const { table, inbox } = openedTable({ mode: 'kou' });
  const state = table.state;
  finishDraft(table);
  const leader = pendingSeats(state)[0]!;
  const other = leader === 0 ? 1 : 0;
  const before = state.log.length;
  const lead = table.legalFor(leader)[0]!;
  table.act(leader, lead);
  const names = playedIds(lead).map((id) => state.byId.get(id)!.label);
  const pushed = inbox.last(other);
  const hidden = state.log.slice(before);
  ok('暗棋一墩进行中，线上日志只到开局那行', pushed.view.log.length === before, `实际 ${pushed.view.log.length}／应为 ${before}`);
  ok('截断位置也告诉客户端了', pushed.maskFrom === before);
  ok('这一墩的日志行一行都没上线', hidden.length > 0 && !hidden.some((l) => pushed.view.log.includes(l)));
  ok('藏起来的正是写了牌名的那几行', names.length > 0 && hidden.some((l) => names.some((n) => l.includes(n))));
  table.act(other, table.legalFor(other)[0]!);
  const done = inbox.last(other);
  ok('一墩翻开结算，日志全量补回来', done.view.log.length === state.log.length && done.maskFrom === -1);
  ok('补回来的正是刚才藏起来那几行', hidden.every((l) => done.view.log.includes(l)));
}

// ───────────────────────── 整局 + 落盘 ─────────────────────────

function playToEnd(table: Table, clock: Clock): GameState {
  const state = () => table.state;
  let guard = 0;
  while (state().phase !== 'over') {
    if (++guard > 600) throw new Error('整局打不完');
    const who = pendingSeats(state()).filter((s) => !table.seatInfo()[s]!.queued);
    if (who.length === 0) {
      // 排队那位和还没醒的电脑位都归桌自己动：推一时钟，让 tick 替他们落子
      clock.step(TAKEOVER_MS + 1);
      table.tick();
      continue;
    }
    const seat = who[0]!;
    table.act(seat, table.legalFor(seat)[0]!);
  }
  return state();
}

{
  // 一把椅子都没人坐：房主照样按得下开始，缺的全归电脑补，不用全桌干等
  const { table, clock, logs } = openedTable({ mode: 'kou' }, []);
  const state = table.state;
  ok('没人入座也能开局', table.lobby().status === 'playing' && logs.some((l) => l.includes('2 个位子由电脑补')), logs.join('｜'));
  ok('空椅子一开局就判给电脑，不必再等满 30 秒', table.seatInfo().every((s) => s.ai && !s.human));
  table.tick();
  ok('代打的电脑当场就能动手', state.draft!.stackIdx >= 0 || state.phase !== 'draft');
  let guard = 0;
  while (state.phase === 'draft') {
    if (++guard > 40) break;
    clock.step(TAKEOVER_MS + 1);
    table.tick();
  }
  ok('两把空椅子也能把摆牌走完', state.phase !== 'draft');
  playToEnd(table, clock);
  const total = state.won.reduce((a, b) => a + b, 0);
  ok('整局打完 phase 落在 over', state.phase === 'over');
  ok('打完 32 枚一枚不少', total === 32, `收到 ${total} 枚`);
  ok('收牌只比总数，两家都在 0～32 之间', state.won.every((w) => w >= 0 && w <= 32));
  ok('空椅子也各自被记上了代打', table.seatInfo().every((s) => s.ai));
}

{
  const { table, clock } = makeTable({ mode: 'ming' });
  const state = table.state;
  const tokenOf = [table.join(0, ''), table.join(1, '')].map((r) => (r.msg?.t === 'welcome' ? r.msg.token : ''));
  ok('两把椅子都坐定', tokenOf.every((t) => t.length > 8));
  ok('没按开始之前这桌还在候场', table.lobby().status === 'waiting');
  table.start(0);
  finishDraft(table);
  playToEnd(table, clock);
  const json = table.save();
  const again = Table.load(json, () => {}, () => {}, () => clock.t);
  const a = fullWire(state);
  const b = fullWire(again.state);
  ok('落盘再读回，整桌状态一字不差', JSON.stringify(a.pieces) === JSON.stringify(b.pieces) && JSON.stringify(a) === JSON.stringify(b));
  ok('读回的是同一个起抽人', again.state.drawer === state.drawer);
  ok('一局打完落的那份盘，读回来就在候场厅里', again.lobby().status === 'waiting');
  // 候场期没有「这一局」要接：旧令牌留着只会把椅子占成「这把有主」，谁坐下都进不来
  const wiped = again.seatInfo().every((s) => !s.taken && !s.online && !s.human);
  const back1 = again.join(1, tokenOf[1]!);
  ok('候场桌读回来椅子全空着：旧令牌不作数，谁都能坐', wiped && back1.ok);
  ok('第一个坐下的人接过房主位（开局那颗不能悬在一把空椅子上）', again.lobby().hostSeat === 1);
  const next = again.start(1);
  ok('他这一按就开得了下一局', next.ok && again.gameNo === 2);
  ok('下一局的起抽人是上一局的赢家', again.state.drawer === (state.won[0]! > state.won[1]! ? 0 : 1) || state.won[0] === state.won[1]);
  ok('下一局重新发牌，手里是空的', again.state.hands.every((h) => h.length === 0) && again.state.phase === 'draft');
}

{
  // 开打中的那半局才真需要令牌：人回来接着打，椅子不能被别人坐走
  const { table, clock } = makeTable({ mode: 'kou' });
  const tokenOf = [table.join(0, ''), table.join(1, '')].map((r) => (r.msg?.t === 'welcome' ? r.msg.token : ''));
  table.start(0);
  const again = Table.load(table.save(), () => {}, () => {}, clock.now);
  ok('开打中的桌读回来还在打', again.lobby().status === 'playing');
  ok('重启后乱猜的令牌挤不进去', !again.join(1, '瞎猜的').ok);
  ok('重启后旧令牌坐得回原位', again.join(1, tokenOf[1]!).ok);
  ok('房主位没被抢：那位还坐在这桌', again.lobby().hostSeat === 0);
  ok('排队那位按不动开始', !again.start(1).ok);
}

{
  // 房主位跟着活人走：跑命令那位没坐对椅子、或者半路人走了，这桌都得还能开局
  const { table } = makeTable({ players: 4, mode: 'ming' });
  table.join(0, '');
  table.join(1, '');
  ok('房主还连着就不抢位', table.lobby().hostSeat === 0);
  ok('不是房主那位按不动开始', !table.start(1).ok && !table.changeSetup(1, { level: 'easy' }).ok);
  table.leave(0);
  table.join(2, '');
  ok('房主掉线后，下一个坐下的人接过房主位', table.lobby().hostSeat === 2);
  ok('接过位的那位改得动配置', table.changeSetup(2, { level: 'easy' }).ok);
  ok('也按得动开始', table.start(2).ok);
  // 空椅子由电脑补，电脑永远不是房主：只有真人递得上入座，房主位只在那之间挪
  // 这儿 P2 还连着（这一局归他打），所以补位的是走了的 P1 和没人坐过的 P4
  ok('两个空位这一局归电脑，房主位还在人坐的那把', table.seatInfo().filter((s) => s.ai).length === 2 && table.lobby().hostSeat === 2);
  const host = table.seatInfo()[2]!;
  ok('房主位那把是真人位，不是电脑位', host.human && !host.ai);
}

{
  // 房主位的「家」钉在第一把椅子上：代持那位再活跃，原房主一回来就得交回去
  const { table } = makeTable({ players: 4, mode: 'ming' });
  const back0 = table.join(0, '');
  const token0 = back0.msg?.t === 'welcome' ? back0.msg.token : '';
  table.join(1, '');
  table.leave(0);
  table.join(2, '');
  ok('原房主没回来时，代持那位说了算', table.lobby().hostSeat === 2 && table.changeSetup(2, { level: 'easy' }).ok);
  table.join(0, token0);
  ok('原房主凭令牌一回来，房主位就交回他', table.lobby().hostSeat === 0);
  ok('交回去之后代持那位改不动配置了', !table.changeSetup(2, { level: 'hard' }).ok);
  ok('原房主自己改得动', table.changeSetup(0, { level: 'hard' }).ok);
  table.leave(0);
  table.join(3, '');
  ok('原房主又走了，房主位再交给坐下那位', table.lobby().hostSeat === 3);
  table.leave(3);
  table.join(0, token0);
  ok('他坐回第一把，房主位又归他', table.lobby().hostSeat === 0);
  // 开打了就不折腾：那一局正打着，房主位得钉在按下开始的人那把椅子上
  table.start(0);
  table.leave(0);
  table.join(1, '');
  ok('开打中原房主那把空出来也不收回房主位', table.lobby().hostSeat === 0 && table.lobby().status === 'playing');
}

{
  // 座位行上要认人：代号由客户端报，桌只存、只截断、不自己编
  const { table, inbox } = makeTable({ mode: 'ming' });
  const t0 = table.join(0, '', '7K2Q').msg;
  const token0 = t0?.t === 'welcome' ? t0.token : '';
  const t1 = table.join(1, '', '  3XB9  ').msg;
  const token1 = t1?.t === 'welcome' ? t1.token : '';
  ok('代号跟着座位表走，前后空格削掉', table.seatInfo()[0]!.nick === '7K2Q' && table.seatInfo()[1]!.nick === '3XB9');
  ok('客户端那份座位表里也带着代号', inbox.last(0).seats[1]!.nick === '3XB9');
  table.join(0, token0, '');
  ok('没带代号的那一句不抹掉原来的', table.seatInfo()[0]!.nick === '7K2Q');
  table.join(1, token1, '超长超长超长超长超长超长超长超长超长超长');
  ok('代号长到过头就截断', table.seatInfo()[1]!.nick.length === NICK_MAX, table.seatInfo()[1]!.nick);
  table.stand(1);
  ok('让了座代号也一起还回去', table.seatInfo()[1]!.nick === '' && table.seatInfo()[1]!.taken === false);
}

{
  // 一个标签页连着换椅子：旧那把不许还挂着「有人」，不然屏幕上四行都是同一个人
  const { table, inbox } = makeTable({ players: 4, mode: 'ming' });
  table.join(0, '', 'DJGF');
  table.join(1, '', 'DJGF', 0);
  ok('换到第 2 把，第 1 把就彻底空了', table.seatInfo()[0]!.taken === false && table.seatInfo()[0]!.nick === '');
  ok('换过来那把带着代号、也连着', table.seatInfo()[1]!.nick === 'DJGF' && table.seatInfo()[1]!.online);
  ok('房主位跟着人挪到第 2 把', table.lobby().hostSeat === 1);
  ok('挪完那份快照里第 1 把就是空的', inbox.last(1).seats[0]!.taken === false);
  table.join(2, '', 'K7QM');
  const r = table.join(2, '瞎猜的', 'DJGF', 1);
  ok(
    '目标那把坐不下，原来那把就不该一起赔进去',
    !r.ok && table.seatInfo()[1]!.online === true && table.seatInfo()[1]!.nick === 'DJGF',
  );
  // 旧那把真的回了候场厅：谁都能坐，而「家」那把一坐回人，房主位就又收回第 1 把
  const w0 = table.join(0, '', 'P4NT').msg;
  const token0 = w0?.t === 'welcome' ? w0.token : '';
  ok('旧那把谁都能坐', table.seatInfo()[0]!.nick === 'P4NT' && table.seatInfo()[0]!.online);
  ok('家那把一坐回人，房主位收回第 1 把', table.lobby().hostSeat === 0);
  table.start(0);
  table.join(3, '', 'P4NT', 0);
  ok(
    '开打中换椅子：旧那把只算掉线，令牌还留着',
    table.seatInfo()[0]!.taken === true && table.seatInfo()[0]!.online === false,
  );
  ok('新那把这一局归电脑打', table.seatInfo()[3]!.queued === true);
  ok('凭旧令牌还坐得回第 1 把', table.join(0, token0, 'P4NT').ok);
}

{
  // 候场桌读回来椅子全空、房主位还指着第 4 把；减人减到 2 人，那把椅子就不存在了——收回来，别在屏幕上念「房主 P4」
  const { table, clock } = makeTable({ players: 4, mode: 'ming' });
  table.join(3, '');
  const again = Table.load(table.save(), () => {}, () => {}, clock.now);
  ok('读回来椅子空了，房主位还指着第 4 把', again.seatInfo().every((s) => !s.taken) && again.lobby().hostSeat === 3);
  ok('空椅子不挡减人', again.changeSetup(3, { players: 2 }).ok);
  ok('减完房主位收回第一把', again.lobby().hostSeat === 0);
  again.join(1, '');
  ok('收回来的空房主位照样交给下一个坐下的', again.lobby().hostSeat === 1);
}

{
  // 中途坐下的人跟着桌报数：他那份快照里的「第几局」不能从 1 数起
  const { table, inbox, clock } = openedTable({ mode: 'ming' });
  const state = table.state;
  finishDraft(table);
  playToEnd(table, clock);
  ok('这一局确实打完了', state.phase === 'over');
  ok('一局打完桌自己退回候场厅', table.lobby().status === 'waiting' && inbox.last(1).status === 'waiting');
  table.start(0);
  const push = inbox.last(1);
  ok('开下一局那份快照报的是第 2 局', push.gameNo === 2 && push.view.phase === 'draft');
  ok('开下一局不是谁落了一手，没有要演的手', push.last === null);
}

{
  // 房主不坐 P1 时也认得是谁的桌子
  const { table } = makeTable({ hostSeat: 1 });
  ok('房主坐 P2 时 P1 按不动开始', !table.start(0).ok);
  ok('P2 按得下', table.start(1).ok && table.lobby().status === 'playing');
}

// ───────────────────────── WebSocket 服务端 ─────────────────────────

interface RawClient {
  sock: Socket;
  head: string;
  texts: string[];
  opcodes: number[];
  /** 连接被对端掐了没：这些负向用例全指着它 */
  closed: boolean;
  send(text: string): void;
  sendRaw(buf: Buffer): void;
  close(): void;
}

/** 手搓一个客户端：帧自己掩码，这样服务端「不掩码就拒」那条才有对证；headers 用来补 Origin 这类握手头 */
function rawClient(port: number, path = '/', headers: string[] = []): Promise<RawClient> {
  return new Promise((res, rej) => {
    const sock = netConnect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: x\r\n${headers.join('\r\n')}${headers.length ? '\r\n' : ''}Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    const client: RawClient = {
      sock,
      head: '',
      texts: [],
      opcodes: [],
      closed: false,
      send: (text) => sock.write(maskFrame(0x1, Buffer.from(text, 'utf8'))),
      sendRaw: (buf) => sock.write(buf),
      close: () => sock.destroy(),
    };
    let body = Buffer.alloc(0);
    let frag: Buffer[] | null = null;
    sock.once('close', () => {
      client.closed = true;
    });
    sock.on('data', (chunk: Buffer) => {
      if (!client.head.includes('\r\n\r\n')) {
        client.head += chunk.toString('latin1');
        const at = client.head.indexOf('\r\n\r\n');
        if (at < 0) return;
        // 握手和第一帧可能挤在同一个包里：切掉头，剩下的接着进解析循环
        body = Buffer.from(client.head.slice(at + 4), 'latin1');
        setTimeout(() => res(client), 0);
      } else body = Buffer.concat([body, chunk]);
      for (;;) {
        if (body.length < 2) return;
        const fin = (body[0] & 0x80) !== 0;
        const opcode = body[0] & 0x0f;
        const masked = (body[1] & 0x80) !== 0;
        let len = body[1] & 0x7f;
        let at = 2;
        if (len === 126) {
          if (body.length < 4) return;
          len = body.readUInt16BE(2);
          at = 4;
        } else if (len === 127) {
          if (body.length < 10) return;
          len = body.readUInt32BE(6);
          at = 10;
        }
        if (masked || body.length < at + len) return;
        const payload = body.subarray(at, at + len);
        body = body.subarray(at + len);
        if (opcode === 0x1) {
          if (frag) {
            frag.push(payload);
            if (fin) {
              client.texts.push(Buffer.concat(frag).toString('utf8'));
              frag = null;
            }
          } else if (fin) client.texts.push(payload.toString('utf8'));
          else frag = [payload];
        } else client.opcodes.push(opcode);
      }
    });
    sock.on('error', rej);
  });
}

function maskFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const key = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const n = payload.length;
  let head: number[];
  if (n < 126) head = [(fin ? 0x80 : 0) | opcode, 0x80 | n];
  else if (n < 65536) head = [(fin ? 0x80 : 0) | opcode, 0x80 | 126, (n >> 8) & 0xff, n & 0xff];
  else {
    const hi = Math.floor(n / 0x100000000);
    const lo = n >>> 0;
    head = [
      (fin ? 0x80 : 0) | opcode,
      0x80 | 127,
      (hi >>> 24) & 0xff,
      (hi >>> 16) & 0xff,
      (hi >>> 8) & 0xff,
      hi & 0xff,
      (lo >>> 24) & 0xff,
      (lo >>> 16) & 0xff,
      (lo >>> 8) & 0xff,
      lo & 0xff,
    ];
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from(head), key, masked]);
}

async function withServer(
  run: (port: number, srv: Server, ws: WsServer, state: { open: number; closed: number; texts: string[] }) => Promise<void>,
): Promise<void> {
  const counter = { open: 0, closed: 0, texts: [] as string[] };
  const ws = new WsServer({
    onOpen: () => counter.open++,
    onMessage: (c, text) => {
      counter.texts.push(text);
      c.send(`回声：${text}`);
    },
    onClose: () => counter.closed++,
  });
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('棋墩墩房主');
  });
  srv.on('upgrade', (req, socket, head) => ws.handle(req, socket, head));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  try {
    await run(port, srv, ws, counter);
  } finally {
    ws.stop();
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

await withServer(async (port, _srv, _ws, counter) => {
  const c = await rawClient(port);
  ok(
    '握手回 101，Sec-WebSocket-Accept 按 RFC6455 算得对',
    /^HTTP\/1\.1 101 /.test(c.head) && c.head.includes('s3pPLMBiTxaQ9kYGzzhZRbK+xOo='),
    c.head.split('\r\n')[0] ?? '',
  );
  ok('连接记进来了', counter.open === 1);
  c.send('你好');
  await nap(80);
  ok('服务端把消息原样回了一帧', c.texts.includes('回声：你好'), c.texts.join('｜'));
  c.close();
  await nap(60);
  ok('客户端断开后 onClose 也走了', counter.closed === 1);
});

await withServer(async (port) => {
  // 一条消息拆两帧发：首帧带文本操作码、fin 空着，第二帧才是接续帧
  const c = await rawClient(port);
  c.sendRaw(maskFrame(0x1, Buffer.from('分片', 'utf8'), false));
  c.sendRaw(maskFrame(0x0, Buffer.from('二号', 'utf8'), true));
  await nap(80);
  ok('分片拼回完整消息', c.texts.includes('回声：分片二号'), c.texts.join('｜'));
  c.close();
});

await withServer(async (port) => {
  // 上来就是接续帧（没有开头那一段）= 协议错，当场掐
  const c = await rawClient(port);
  c.sendRaw(maskFrame(0x0, Buffer.from('凭空来的分片', 'utf8'), true));
  await nap(60);
  ok('平白多出来的接续帧被断开', c.closed);
  c.close();
});

await withServer(async (port) => {
  // 服务端只认文本帧：二进制帧当场掐
  const c = await rawClient(port);
  c.sendRaw(maskFrame(0x2, Buffer.from([1, 2, 3])));
  await nap(60);
  ok('二进制帧直接被断开', c.closed);
  c.close();
});

await withServer(async (port) => {
  // 客户端帧不掩码 = 协议错，服务端要立刻掐
  const c = await rawClient(port);
  c.sendRaw(Buffer.concat([Buffer.from([0x81, 0x04]), Buffer.from('abcd')]));
  await nap(60);
  ok('不掩码的客户端帧被断开', c.closed);
  c.close();
});

await withServer(async (port) => {
  // 长消息：126 那档（两字节长度）和 127 那档（八字节长度）都得能收
  const c = await rawClient(port);
  const mid = '中'.repeat(200);
  c.send(mid);
  await nap(120);
  ok('126 档长度的帧收得下', c.texts.includes(`回声：${mid}`));
  // 90000 字节才越过 65535，两字节的长度栏装不下，走八字节那一档
  const big = '大'.repeat(30000);
  c.send(big);
  await nap(200);
  ok('127 档长度的帧收得下', c.texts.includes(`回声：${big}`), `收到 ${c.texts.length} 帧`);
  c.close();
});

await withServer(async (port) => {
  // 超过上限的消息长度声明：不必等载荷发完就该掐
  const c = await rawClient(port);
  c.sendRaw(Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0, 0x00, 0x20, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44]));
  await nap(60);
  ok('超上限的消息当场断开', c.closed);
  c.close();
});

await withServer(async (port) => {
  // 心跳：客户端发 ping，服务端按协议回 pong
  const c = await rawClient(port);
  c.sendRaw(maskFrame(0x9, Buffer.from('hi', 'utf8')));
  await nap(60);
  ok('ping 收到 pong', c.opcodes.includes(0x0a), c.opcodes.join(','));
  c.close();
});

await withServer(async (port, srv) => {
  // 升级头不对的 upgrade 请求不该被当成交接完的连接
  const sock = netConnect((srv.address() as { port: number }).port, '127.0.0.1');
  await new Promise<void>((r) => sock.on('connect', r));
  sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: bogus\r\nConnection: Upgrade\r\n\r\n');
  const dead = await new Promise<boolean>((res) => {
    sock.once('close', () => res(true));
    sock.once('error', () => res(true));
    setTimeout(() => res(false), 200);
  });
  ok('不像 WebSocket 的升级请求一律掐掉', dead);
  sock.destroy();
});

await withServer(async (port, _srv, _ws, counter) => {
  // Origin 这道闸：浏览器开 WebSocket 必带，别的页面想悄悄坐上来就靠它挡；命令行客户端不带，得放行
  const none = await rawClient(port);
  ok('不带 Origin 的（命令行、测试）照样握上手', /^HTTP\/1\.1 101 /.test(none.head), none.head.split('\r\n')[0] ?? '');
  const same = await rawClient(port, '/', ['Origin: http://x']);
  ok('Origin 跟 Host 对上就放行', /^HTTP\/1\.1 101 /.test(same.head), same.head.split('\r\n')[0] ?? '');
  // 浏览器不把默认端口写进 Origin：http://x:80 和 Host: x 得算一个地址，不然正经页面被误杀
  const flat = await rawClient(port, '/', ['Origin: http://x:80']);
  ok('Origin 带默认端口、Host 不带：摊平了算同一个', /^HTTP\/1\.1 101 /.test(flat.head), flat.head.split('\r\n')[0] ?? '');
  await nap(60);
  ok('放行那几条一条没被掐', counter.open === 3 && !none.closed && !same.closed && !flat.closed);
  same.close();
  flat.close();
  none.close();

  const foe = await rawClient(port, '/', ['Origin: http://evil.example']);
  ok('Origin 不是这一桌的，握手直接回 403', /^HTTP\/1\.1 403 /.test(foe.head), foe.head.split('\r\n')[0] ?? '');
  const opaque = await rawClient(port, '/', ['Origin: null']);
  ok('Origin 是 null（本地文件、沙箱页）也拒', /^HTTP\/1\.1 403 /.test(opaque.head), opaque.head.split('\r\n')[0] ?? '');
  await nap(60);
  ok('被拒那两条连上没记进连接表', counter.open === 3 && foe.closed && opaque.closed);
  foe.close();
  opaque.close();
});

await withServer(async (port, _srv, _ws, counter) => {
  // 判死之后：对端已经不可信了，那之后攒着的字节一个都不该再解
  const c = await rawClient(port);
  c.sendRaw(Buffer.concat([maskFrame(0x1, Buffer.from('起头', 'utf8'), false), maskFrame(0x2, Buffer.from('插一脚', 'utf8'))]));
  await nap(80);
  ok('分片没完就另起一帧：当场掐', c.closed);
  ok('掐了之后那一帧没被当成消息递上去', !counter.texts.some((t) => t.includes('插一脚')), counter.texts.join('｜'));
  c.close();
});

await withServer(async (port, _srv, _ws, counter) => {
  // 单帧有 1 MB 上限，分片拼起来却没人管过：六分片各 200 KB 拼出 1.2 MB，内存就该在这儿收住
  const c = await rawClient(port);
  const seg = Buffer.alloc(200 * 1024, 0x61);
  c.sendRaw(maskFrame(0x1, seg, false));
  for (let i = 0; i < 5; i++) c.sendRaw(maskFrame(0x0, seg, i === 4));
  await nap(150);
  ok('分片拼起来超限就掐', c.closed);
  ok('拼过头那一条没被递上去', counter.texts.length === 0, `收到 ${counter.texts.length} 条`);
  c.close();
});

function nap(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
