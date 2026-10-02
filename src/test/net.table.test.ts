/**
 * 联机层测试（拆分后）：共享夹具从 net.harness.ts 来。
 * 原 net.test.ts 一拆三：桌的生命周期 / 宿主与账 / 形闸·快照·WS 服务端。
 */
import { pendingSeats, type Action } from '../core/game.ts';
import { Table, IDLE_MS, NICK_MAX, TAKEOVER_MS } from '../node/table.ts';
import { fullWire } from '../net/wire.ts';
import {
  finishDraft,
  makeTable,
  ok,
  openedTable,
  pieceOf,
  playToEnd,
  playedIds,
  rules,
  failures,
  type StatePush,
} from './net.harness.ts';

/** 快照要演的那一手，测试里就按「谁·什么」这一个串来看 */
function keyOf(push: StatePush): string {
  return push.last ? `${push.last.seat}:${push.last.action.kind}` : '—';
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
  // 三档加进来之后，「减不到」只发生在真坐不下那位身上：三把椅子装得下这两位，那就改得动
  ok('三把椅子坐得下这两位，减到 3 人就改得动', table.changeSetup(0, { players: 3 }).ok && table.lobby().players === 3);
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
  ok('人数不在档位上改不了', !table.changeSetup(0, { players: 5 }).ok && table.lobby().players === 4);
  ok('那句回绝话也走同一个出口：档位加了 3 就不用改口', table.changeSetup(0, { players: 5 }).why === '这桌只能 2、3 或 4 人');
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
    // 位只往「没人拿着」那把上走：代持那位还连着，坐回「家」那把也不把他踢下去
    ok(
      '开桌那位坐回「家」那把：客人还连着，位就不抢',
      two.table.lobby().hostSeat === 1 && two.table.seatInfo()[0]!.taken,
    );
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
  // 房主位只往「没人拿着」那把上走：代持那位还连着，谁坐回「家」那把都不把他踢下去。
  // 还回去只剩一条路——代持那位自己让座（`stand` 那条），这一整块钉的就是这两句
  const { table, logs } = makeTable({ players: 4, mode: 'ming' });
  const back0 = table.join(0, '');
  const token0 = back0.msg?.t === 'welcome' ? back0.msg.token : '';
  table.join(1, '');
  table.leave(0);
  table.join(2, '');
  ok('原房主没回来时，代持那位说了算', table.lobby().hostSeat === 2 && table.changeSetup(2, { level: 'easy' }).ok);
  table.join(0, token0);
  ok('原房主凭令牌坐回「家」那把，也不从还连着的人手上抢位', table.lobby().hostSeat === 2);
  ok('代持那位照样改得动配置', table.changeSetup(2, { level: 'hard' }).ok);
  ok('坐回「家」那把的那位改不动：他这会儿不是房主', !table.changeSetup(0, { level: 'greedy' }).ok);
  ok('他也按不动开始', !table.start(0).ok);
  table.leave(0);
  table.join(3, '');
  ok('桌上还站着代持那位，后来坐下的人也接不走', table.lobby().hostSeat === 2);
  ok('代持那位让座，房主位当场还回「家」那把', table.stand(2).ok && table.lobby().hostSeat === 0);
  ok('还位这一句在终端上也念得出', logs.some((l) => l.includes('把房主位还回了')), logs.join('｜'));
  table.join(0, token0);
  ok(
    '坐回「家」那把的就是真房主：他还是让不成座',
    !table.stand(0).ok && table.stand(0).why === '房主不能让座，这桌得有人开局',
  );
  ok('位回家之后，开局那颗归家那把按', table.start(0).ok && table.lobby().status === 'playing');
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
  // 旧那把真的回了候场厅：谁都能坐。而「家」那把坐回人也不把房主位从这个标签页手上抢走
  const w0 = table.join(0, '', 'P4NT').msg;
  const token0 = w0?.t === 'welcome' ? w0.token : '';
  ok('旧那把谁都能坐', table.seatInfo()[0]!.nick === 'P4NT' && table.seatInfo()[0]!.online);
  ok('家那把坐回了人，房主位还在那个标签页手上', table.lobby().hostSeat === 1);
  table.start(1);
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


console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
