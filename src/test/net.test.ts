/**
 * 联机层测试：桌（权威状态、令牌、代打、落盘）+ 打码快照 + 手写 WebSocket 服务端。
 * 全部在 Node 里跑，不碰浏览器、不碰真网络，靠假时钟和假连接把整局打完。
 */
import { createServer, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { pendingSeats, type Action, type GameState } from '../core/game.ts';
import { loadRules } from '../node/load_rules.ts';
import { Table, TAKEOVER_MS, type TableSetup } from '../net/table.ts';
import { fullWire, hydrate, snapshotFor, type ToClient, type WirePiece, type WireState } from '../net/wire.ts';
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

// ───────────────────────── 打码快照 ─────────────────────────

{
  const { table } = makeTable({ mode: 'kou' });
  const state = table.state;
  table.join(0, '');
  table.join(1, '');
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
  const { table } = makeTable({ mode: 'ming' });
  const state = table.state;
  table.join(0, '');
  table.join(1, '');
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
  const { table, clock } = makeTable({ mode });
  const state = table.state;
  table.join(0, '');
  table.join(1, '');
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
  const { table } = makeTable();
  const state = table.state;
  table.join(0, '');
  table.join(1, '');
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
  const { table } = makeTable({ mode: 'ming' });
  const state = table.state;
  table.join(0, '');
  table.join(1, '');
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
  const { table } = makeTable({ mode: 'ming' });
  table.join(0, '');
  table.join(1, '');
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
  const { table, inbox } = makeTable({ mode: 'kou' });
  const state = table.state;
  table.join(0, '');
  table.join(1, '');
  ok('入座那一份没有要演的手', inbox.last(0).last === null && inbox.last(1).last === null);
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

// ───────────────────────── 超时代打 ─────────────────────────

{
  const { table, clock, logs } = makeTable();
  const state = table.state;
  table.join(0, '');
  table.join(1, '');
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
  const { table, clock, logs } = makeTable();
  const state = table.state;
  table.join(0, '');
  table.join(1, '');
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
  const { table, inbox } = makeTable({ mode: 'kou' });
  const state = table.state;
  table.join(0, '');
  table.join(1, '');
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
    const who = pendingSeats(state());
    if (who.length === 0) {
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
  const { table, clock } = makeTable({ mode: 'kou' });
  const state = table.state;
  // 谁都不入座：两把空椅子各自等满 30 秒交给桌
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
  finishDraft(table);
  playToEnd(table, clock);
  const json = table.save();
  const again = Table.load(json, () => {}, () => {}, () => clock.t);
  const a = fullWire(state);
  const b = fullWire(again.state);
  ok('落盘再读回，整桌状态一字不差', JSON.stringify(a.pieces) === JSON.stringify(b.pieces) && JSON.stringify(a) === JSON.stringify(b));
  ok('读回的是同一个起抽人', again.state.drawer === state.drawer);
  ok('读回后谁都没连着，椅子还留着令牌', again.seatInfo().every((s) => !s.online && !s.ai));
  // 房主进程重启不算换人：令牌还认，各回各的位子
  ok('重启后乱猜的令牌挤不进去', !again.join(1, '瞎猜的').ok);
  ok('重启后旧令牌坐得回原位', again.join(1, tokenOf[1]!).ok);
  const next = again.nextGame(0);
  ok('打完这局能开下一局', next.ok && again.gameNo === 2);
  ok('下一局的起抽人是上一局的赢家', again.state.drawer === (state.won[0]! > state.won[1]! ? 0 : 1) || state.won[0] === state.won[1]);
  ok('下一局重新发牌，手里是空的', again.state.hands.every((h) => h.length === 0) && again.state.phase === 'draft');
}

{
  const { table } = makeTable();
  const r = table.nextGame(0);
  ok('这局没打完就按再来一局，不认', !r.ok && r.why === '这局还没打完');
  const guest = table.nextGame(1);
  ok('不是房主那位按的，一样不认', !guest.ok && guest.why === '只有房主能开下一局');
}

{
  // 中途坐下的人跟着桌报数：他那份快照里的「第几局」不能从 1 数起
  const { table, inbox, clock } = makeTable({ mode: 'ming' });
  const state = table.state;
  table.join(0, '');
  table.join(1, '');
  finishDraft(table);
  playToEnd(table, clock);
  ok('这一局确实打完了', state.phase === 'over');
  table.nextGame(0);
  const push = inbox.last(1);
  ok('开下一局那份快照报的是第 2 局', push.gameNo === 2 && push.view.phase === 'draft');
  ok('开下一局不是谁落了一手，没有要演的手', push.last === null);
}

{
  // 房主不坐 P1 时也认得是谁的桌子
  const { table } = makeTable({ hostSeat: 1 });
  ok('房主坐 P2 时 P1 按不动再来一局', !table.nextGame(0).ok);
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

/** 手搓一个客户端：帧自己掩码，这样服务端「不掩码就拒」那条才有对证 */
function rawClient(port: number, path = '/'): Promise<RawClient> {
  return new Promise((res, rej) => {
    const sock = netConnect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
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

function nap(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
