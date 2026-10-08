/**
 * 联机层测试（拆分后）：共享夹具从 net.harness.ts 来。
 * 原 net.test.ts 一拆三：桌的生命周期 / 宿主与账 / 形闸·快照·WS 服务端。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rulesFor } from '../core/game.ts';
import { nextDrawer, openMatch } from '../core/match.ts';
import { buildPieceSet } from '../core/pieces.ts';
import { mulberry32 } from '../core/rng.ts';
import {
  canonicalSave,
  claimSave,
  hasFlag,
  intFlag,
  lockPathOf,
  lockVerdict,
  openRoom,
  orphanWatch,
  setupFrom,
  type Room,
  type SaveLock,
} from '../node/room.ts';
import { Table, IDLE_MS } from '../node/table.ts';
import { aliveSeats, type ToClient } from '../net/wire.ts';
import { finishDraft, makeTable, ok, playToEnd, roundTripWhy, rules, failures } from './net.harness.ts';

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
  // 起抽人往下传这一条，上面那一局说了不算，得连说六局：
  // 「换牌面前不先结打完那一局」那一刀拆掉的是换牌面那趟里的 settleOver，起抽人没人传，
  // 就退给 createGame 拿这局自己的种子掷——单看一局撞中上一局赢家是二分之一的运气。
  // 2026-10-02 椅子令牌改走 node:crypto 之后，那条流少走了两步（入座不再占流位），
  // 那一局恰好撞中，刀当场磨绿：判据蹭在随机流位上，源码那头一改它就哑。
  // 每局换一个 setup.seed、每一局都翻一次玩法（走的正是那一趟换牌面），六局全撞中的概率是 1/64。
  let misses = 0;
  for (let round = 0; round < 6; round++) {
    const { table, clock } = makeTable({ mode: 'kou', seed: 101 + round * 37 });
    table.join(0, '');
    table.join(1, '');
    table.start(0);
    finishDraft(table);
    const want = nextDrawer(playToEnd(table, clock));
    table.changeSetup(0, { mode: 'ming' });
    if (table.state.drawer !== want) misses++;
  }
  ok('连翻六局牌面，起抽人局局接的是上一局那一位（不是新牌面上掷出来的）', misses === 0, `六局里 ${misses} 局接错`);
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
  // 开桌那位先坐「家」那把，客人才坐下：房主位不从他手上跳走，下面那句才量的是掉线计时
  table.join(0, '');
  const r1 = table.join(1, '');
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

// ───────────────────────── 落定那份规则：三档各往线上和硬盘上走一遍 ─────────────────────────

{
  // 快照和存档带下去的都是 `GameState.rules`，也就是**按人数落定之后**那一份，还原这一头还要再过一次
  // `parseRules`（那道门是给手写的 rules.json 设的）。落定要是留着整张档位清单，2 人那一档就会被拿去查
  // 3 人档的「一摞 3 张」，当场自己拒自己——网页每份快照读不回、host 重启接不回这一桌。
  // 这一段排在「清账重开」之前是有原因的：往后那几处的 `Table.load` 是裸调用，这一趟闸一拆就当场抛，
  // 整套死在第一句就一句 ✗ 都打不出来（刀架只会报「红了 0 条」），所以这儿自己接住，先把红字打出来。
  let wire = '';
  let disk = '';
  for (const n of rules.playerCounts) {
    const want = rulesFor(rules, n);
    const h = makeTable({ mode: 'kou', players: n });
    for (const s of Array.from({ length: n }, (_, i) => i)) h.table.join(s, '');
    h.table.start(0);
    const why = roundTripWhy(h.table.state);
    if (why && !wire) wire = `${n} 人那一档：${why}`;
    try {
      const back = Table.load(h.table.save(), () => {}, () => {}, h.clock.now);
      const bad =
        back.state.players !== n
          ? `人数接回来变成 ${back.state.players}`
          : back.state.rules.draft.stackSize !== want.draft.stackSize
            ? `一摞张数接回来变成 ${back.state.rules.draft.stackSize}`
            : back.state.pieces.length !== buildPieceSet(want.ranks).length
              ? `牌堆接回来是 ${back.state.pieces.length} 枚`
              : '';
      if (bad && !disk) disk = `${n} 人那一档：${bad}`;
    } catch (e) {
      if (!disk) disk = `${n} 人那一档：${String((e as Error).message)}`;
    }
  }
  ok('三档的快照各转一圈都接得回来：落定那份不再带着整张档位清单', wire === '', wire);
  ok('三档的存档各接一次：人数、一摞张数、牌堆枚数回来还是自己那一档', disk === '', disk);
}

// ───────────────────────── 清账重开：账归零，椅子一把不动 ─────────────────────────

{
  // 这本账活在桌那边，重启也照 `table.json` 接得回来：页面上没有第二个入口，
  // 「怎么这桌已经第 4 局了」就只能干瞪眼，所以候场厅得有一颗把账扔回 0 的
  const { table, inbox, clock, logs } = makeTable({ mode: 'ming' });
  // 同一个顺序：开桌那位先坐家那把，这位客人坐下之后位不再跳
  table.join(0, '');
  const r1 = table.join(1, '');
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

// ───────────────────────── 散桌：只剩一个活人时，人走桌也跟着没 ─────────────────────────

{
  // 「这桌还有几个人」得有个准数：掉线那把椅子令牌还留着、电脑补的位压根没连着，两个都不算活人；
  // 候场厅那颗「返回」要不要先问一句、桌那头让不让散，都看这一数
  ok('两个人连着就是两个：这时候谁都不该替全桌做主', aliveSeats([{ online: true }, { online: true }]) === 2);
  ok('掉线那把不算活人（椅子还挂着令牌，可人不在这条线上）', aliveSeats([{ online: true }, { online: false }]) === 1);
  ok('一把椅子都没人连着就是 0', aliveSeats([{ online: false }, { online: false }]) === 0);
  ok('电脑补的位在这一数里压根不占一格（座位表没给 online 的那几把）', aliveSeats([{ online: true }]) === 1);
}

{
  // 候场厅那颗「返回」落在这张桌上的样子：只剩房主一个活人，退出就该连椅子一起收，
  // 别在局域网里空挂一张没人坐、账还压着的桌——下一台设备寻到它，看见的是「这桌已经第 3 局」
  const { table, clock, logs } = makeTable({ mode: 'ming' });
  // 开桌那位先坐家那把：下面整段量的都是「房主一个活人时散不散得动」，不是位落在哪把
  table.join(0, '');
  const r1 = table.join(1, '');
  const tok1 = r1.msg?.t === 'welcome' ? r1.msg.token : '';
  table.start(0);
  finishDraft(table);
  playToEnd(table, clock);
  table.start(0);
  finishDraft(table);
  playToEnd(table, clock);
  ok(
    '散之前：两局压在账上、两个活人连着',
    table.book.games === 2 && aliveSeats(table.seatInfo()) === 2,
    `${table.book.games}｜${aliveSeats(table.seatInfo())}`,
  );
  const crowd = table.disband(0);
  ok(
    '还连着别人：房主也散不动，要散得等别人先走',
    !crowd.ok && (crowd.why ?? '').includes('还有 1 个活人连着') && table.book.games === 2,
    `${crowd.ok}｜${crowd.why ?? ''}`,
  );
  ok('挡下来什么都没动：他那把椅子还记在他名下', table.seatInfo()[1]!.taken && table.seatInfo()[1]!.online);
  table.leave(1);
  ok('那位走了才轮到散：这桌只剩一个活人', aliveSeats(table.seatInfo()) === 1);
  // 这一问排在人走之后：桌上还连着两个人时，非房主那句会被「还有别人」那道闸一起挡下，看不出是房主闸救的
  ok('不是房主散不动，账照旧', !table.disband(1).ok && table.book.games === 2);
  const gone = table.disband(0);
  ok(
    '房主散了：局号回 1，四条账目全归零',
    gone.ok && table.gameNo === 1 && table.book.games === 0 && table.book.cards.every((c) => c === 0) && table.book.titles.every((t) => t === 0),
    `${gone.ok}｜${JSON.stringify(table.book)}`,
  );
  ok('椅子一把不剩：令牌也跟着收（不像清账那样留着人）', table.seatInfo().every((s) => !s.taken && !s.online), JSON.stringify(table.seatInfo()));
  ok('散了也重摊牌面：不再是打完那一份', table.state.phase !== 'over' && table.state.pieces.length === 32);
  ok('候场厅里念得出来：这桌散了', logs.some((l) => l.includes('这桌散了')), logs.join('｜'));
  const twin = Table.load(table.save(), () => {}, () => {}, clock.now);
  ok(
    '散完落盘、重启接回来的还是散了的那张桌',
    twin.gameNo === 1 && twin.book.games === 0 && twin.seatInfo().every((s) => !s.taken),
    JSON.stringify([twin.gameNo, twin.book.games]),
  );
  // 散完这张桌还得是一张能用的桌：归零不是把它换成一张不会开局的照片
  table.start(0);
  finishDraft(table);
  playToEnd(table, clock);
  ok(
    '散完接着打：账上一笔、局号还是第 1 局、32 枚不落别人头上',
    table.book.games === 1 &&
      table.gameNo === 1 &&
      table.book.cards.reduce((a, c) => a + c, 0) === 32 &&
      table.book.cards.length === 2,
    JSON.stringify([table.gameNo, table.book.games, table.book.cards]),
  );
  const back = table.join(1, tok1);
  ok(
    '旧令牌回来只是个新人：坐得下，发的却是另一把新令牌',
    back.ok && back.msg?.t === 'welcome' && back.msg.token !== tok1 && back.msg.token.length > 0,
    `${back.msg?.t === 'welcome' ? back.msg.token : '‹没发welcome›'}｜${tok1}`,
  );
}

console.log('椅子令牌不许是牌局那条种子的函数');
{
  // 2026-10-02 探针撞的：`seed` 随每一份快照发给桌上的人，而旧写法从桌那把 mulberry32(seed^0x5eed)
  // 上取令牌——外人照那条流往外推，每一把椅子的令牌都算得出来，拿它 join 直接坐上别人的位子。
  const SEED = 0x51a7;
  const tokenOf = (t: Table, seat: number) => {
    const r = t.join(seat, '');
    return r.msg?.t === 'welcome' ? r.msg.token : '';
  };
  const a = makeTable({ seed: SEED }).table;
  const b = makeTable({ seed: SEED }).table;
  const a0 = tokenOf(a, 0);
  const b0 = tokenOf(b, 0);
  const a1 = tokenOf(a, 1);
  ok(
    '同样种子、同样参数的两张桌，第一把椅子的令牌不许一样：一样就等于它是 seed 的函数，而 seed 发给全桌',
    a0 !== b0 && a0.length > 0 && b0.length > 0,
    `${a0}｜${b0}`,
  );
  // 外人那一头：手里只有那条 seed，照流的起点往外推 4096 位，每位在四把椅子都试一遍
  const stream = mulberry32(SEED ^ 0x5eed);
  const guessed = new Set<string>();
  for (let i = 0; i < 4096; i++) {
    const n = stream().toString(36).slice(2, 10);
    for (let s = 0; s < 4; s++) guessed.add(`s${s}-${n}`);
  }
  ok(
    '照那条流算出来的 4096 位撞不中任何一把椅子：撞中就等于谁连得上这条端口谁就能冒充别人',
    !guessed.has(a0) && !guessed.has(a1) && !guessed.has(b0),
    `${a0} ${a1}`,
  );
}

{
  // 打了一半不散：那一局的账还没落地，这会儿收椅子等于让正在出牌的人白打，还让候场厅丢了牌面
  const { table } = makeTable({ mode: 'kou' });
  table.join(0, '');
  table.join(1, '');
  table.start(0);
  finishDraft(table);
  const r = table.disband(0);
  ok(
    '这一局正在打，散不动也不碰椅子',
    !r.ok && (r.why ?? '').includes('正在打') && aliveSeats(table.seatInfo()) === 2 && table.status === 'playing',
    `${r.ok}｜${r.why ?? ''}｜${table.status}`,
  );
  table.leave(1);
  const solo = table.disband(0);
  ok('就算只剩一个活人，那一局没打完照样不散', !solo.ok && aliveSeats(table.seatInfo()) === 1 && table.seatInfo()[1]!.taken);
}

{
  // 散桌的是代持房主位那位（原房主掉了线，房主位跟着活人挪到他手上）：散了之后那颗开局得回「家」那把椅子，
  // 不然这张桌在下一个人坐下之前，按开始的都是一个已经不在这桌上的人
  const { table } = makeTable({ mode: 'kou' });
  table.join(0, '');
  table.leave(0);
  table.join(1, '');
  ok('房主位交到了代持那位手上：他这一个活人散得动', table.disband(1).ok);
  ok('散完房主位回「家」那把：代持那位按不动开局，家那把按得动', !table.start(1).ok && table.start(0).ok);
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
  // 三人档进联机这一头：三把椅子、一副少两枚的牌、摆 10 摞 × 每摞 3 张、分牌只认「层层轮流分」那一种
  const { table, inbox, clock } = makeTable({ mode: 'kou', players: 3 });
  for (const s of [0, 1, 2]) table.join(s, '');
  ok('三人桌只有三把椅子，第四把压根不发', table.seatInfo().length === 3);
  ok('坐满三把就开得起', table.start(0).ok && table.state.players === 3);
  ok('这一桌的牌堆是 30 枚（去掉的那枚红兵、那枚黑卒不在里头）', table.state.pieces.length === 30, `${table.state.pieces.length}`);
  ok('摆的是 10 摞、每摞 3 张', table.state.draft!.stacks.length === 10 && table.state.draft!.stacks.every((st) => st.length === 3));
  const drawer = table.state.draft!.drawer;
  table.act(drawer, { kind: 'draw', stackIdx: 0 });
  // 抽完这一签开口的是「处置人」（draft.decider），不是刚才那位起抽人
  const keeper = table.state.draft!.decider;
  const ways = table.legalFor(keeper).filter((a) => a.kind === 'allocate');
  ok('处置人能挑的拿法只剩一种：层层轮流分', ways.length === 1 && ways[0]!.kind === 'allocate' && 'way' in ways[0] && ways[0].way === 'layered', JSON.stringify(ways));
  ok('整摞轮流拿在这一桌不合法（10 摞分 3 家拿成不等张）', !table.legalFor(keeper).some((a) => 'way' in a && a.way !== 'layered'));
  finishDraft(table);
  ok('分完每家 10 枚、一张没漏', table.state.hands.every((h) => h.length === 10), table.state.hands.map((h) => h.length).join('/'));
  playToEnd(table, clock);
  ok('三人局在桌这一头走得完（两家对打的文案没卡住三位）', table.state.phase === 'over');
  const got = table.state.won.reduce((x, n) => x + n, 0);
  ok('打完那一刻 30 枚全收进某家的牌摞', got === 30, `${got}`);
  ok('三人桌那份快照转一圈回来不炸：落定的规则自己过得了那道门', roundTripWhy(table.state) === '', roundTripWhy(table.state));
  ok('第三把椅子也拿到了快照', inbox.all.some((o) => o.seat === 2 && o.msg.t === 'state'));
}

{
  // 三人桌往硬盘上写那一趟：下去的同样是落定那份规则，接不回来的话 host 重启只会念一句「发不平」重开一桌
  const a = makeTable({ mode: 'kou', players: 3 });
  for (const s of [0, 1, 2]) a.table.join(s, '');
  a.table.start(0);
  finishDraft(a.table);
  let restored: Table | null = null;
  let boom = '';
  try {
    restored = Table.load(a.table.save(), () => {}, () => {}, a.clock.now);
  } catch (e) {
    boom = String((e as Error).message);
  }
  ok('三人桌的存档接得回来', restored !== null, boom);
  ok(
    '接回来那桌还是 3 人档：30 枚、一摞 3 张',
    (restored?.state.pieces.length ?? 0) === 30 && (restored?.state.rules.draft.stackSize ?? 0) === 3,
    `${restored?.state.pieces.length} 枚、一摞 ${restored?.state.rules.draft.stackSize}`,
  );
}

{
  // 候场厅里从四人减到三人：多出来的那把椅子要还给桌，坐过的人不带着牌走
  const { table } = makeTable({ mode: 'kou', players: 4 });
  for (const s of [0, 1, 2, 3]) table.join(s, '');
  ok('四人桌先坐满四把', table.seatInfo().length === 4);
  ok('第四把还坐着人时减不下来', !table.changeSetup(0, { players: 3 }).ok);
  ok('P4 让了座就减得动', table.stand(3).ok && table.changeSetup(0, { players: 3 }).ok);
  ok('改完是三人这一档', table.state.players === 3);
  ok('减下来的那把椅子还给了这桌', table.seatInfo().length === 3);
  ok('坐着的三位还在原来那三把椅子上', table.seatInfo().slice(0, 3).every((s) => s.taken && s.online));
  ok(
    '三人那一桌按下开始就是 30 枚',
    (() => {
      const t2 = makeTable({ mode: 'kou', players: 3 });
      for (const s of [0, 1, 2]) t2.table.join(s, '');
      return t2.table.start(0).ok && t2.table.state.pieces.length === 30;
    })(),
  );
  // 快照／存档带下去的是落定那一份，它只说这一档；档位清单得另外从开桌那份取，
  // 不然闸拿 state.rules 认人数，三人桌就再也改不回四人（room.ts 那句 gate 走的就是这条线）
  ok('落定那份规则只说 3 人这一档', table.state.rules.playerCounts.join() === '3');
  ok('档位清单还是开桌那份：2、3、4 都在', table.config.playerCounts.join() === '2,3,4');
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
  // 还开着的那页更会从此一份不演——它只认比手上号新的快照。
  // 存之前要打满两局：头一副用的就是 setup.seed，那条流一步都没走，只打一局就存档时
  // rngSteps 本来就是 0——「存档不写 rngSteps」那一刀拆的是一串 0，谁都看不见（2026-10-02 量到的）。
  const a = makeTable({ mode: 'ming', seed: 11 });
  a.table.join(0, '');
  a.table.join(1, '');
  a.table.start(0);
  finishDraft(a.table);
  playToEnd(a.table, a.clock);
  a.table.start(0);
  finishDraft(a.table);
  playToEnd(a.table, a.clock);
  const seqSaved = a.inbox.last(1).seq;
  const json = a.table.save();
  // 这一句钉的是上面那个前提本身：流位没走过，后面那两句比对种子就是摆设
  ok('打到存档这一刻，那条流确实走过几步', (JSON.parse(json).rngSteps as number) > 0, `rngSteps=${JSON.parse(json).rngSteps}`);
  a.table.start(0);
  const nextSeed = a.table.state.seed;
  // 只认流位，一把椅子都不坐：按下开始洗出来的那一副，得和没重启那桌的下一副严丝合缝
  const twin = Table.load(json, () => {}, () => {}, a.clock.now);
  twin.start(0);
  ok('重启后接着开的那局，种子跟没重启时是同一个', twin.state.seed === nextSeed, `${twin.state.seed} 对上 ${nextSeed}`);
  ok('刚打完那一局不会在重启后补记成两笔', twin.book.games === 2, `账上 ${twin.book.games} 局`);

  // 椅子令牌如今走 node:crypto，不在这条流上取（见 join 那一段）：所以重启后哪怕有人坐回来，
  // 流位也还停在存档那一刻，按下开始洗出来的还是没重启那桌的下一副
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
  restored.start(0);
  ok(
    '坐回来发令牌不占流位：接着开的那局还是同一副牌面',
    restored.state.seed === nextSeed,
    `${restored.state.seed} 对上 ${nextSeed}`,
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
    '一行参数不给：默认两人、扣棋、easy、房主坐 P1',
    quiet.players === 2 && quiet.mode === 'kou' && quiet.level === 'easy' && quiet.hostSeat === 0 && Number.isInteger(quiet.seed),
  );
  const given = setupFrom(['--players', '4', '--mode=ming', '--level=easy', '--seed=7', '--host-seat', '3'], rules);
  ok('--名 值 和 --名=值 两种写法都认', given.players === 4 && given.mode === 'ming' && given.level === 'easy' && given.seed === 7 && given.hostSeat === 3);
  ok('空着等值（--players=）当没给，照默认来', setupFrom(['--players='], rules).players === 2);
  ok('--players=abc 说清是哪三个字，不抱着 NaN 开桌', shout(['--players=abc']).includes('abc'));
  ok('--players=3 现在是档位了，桌开得起', setupFrom(['--players=3'], rules).players === 3);
  ok('--players=5 不是这桌的档位，念的是 2、3 或 4', shout(['--players=5']).includes('2、3 或 4'));
  ok('--mode=明 认不出这种玩法', shout(['--mode=明']).includes('mode'));
  ok('--level=zzz 认不出这档', shout(['--level=zzz']).includes('level'));
  ok('--host-seat=9 超出一把椅子都没有', shout(['--host-seat=9']).length > 0);
  ok('--seed=-1 负数不接', shout(['--seed=-1']).length > 0);
  ok('--players=1.5 也不算整数', shout(['--players=1.5']).includes('players'));
  ok('--port 那行同样由这道闸兜：写歪了抛，不抛给 node 的 listen', (() => { try { intFlag(['--port=abc'], 'port', 5200, 1, 65535); return false; } catch { return true; } })());
  ok('端口不给就用默认值，给了 0 也算出界', intFlag([], 'port', 5200, 1, 65535) === 5200 && (() => { try { intFlag(['--port=0'], 'port', 5200, 1, 65535); return false; } catch { return true; } })());

  // 开关那一档以前只认「整项等于 --名」：--fresh=1 静默不生效，加了开关的人以为桌重开了，
  // 其实接回的是上一桌——这跟「没加这个开关」是两种结果，却一点看不出来
  ok('--fresh 光写算开，写成 --fresh=1／--fresh=yes 也算开', hasFlag(['--fresh'], 'fresh') && hasFlag(['--fresh=1'], 'fresh') && hasFlag(['--fresh=yes'], 'fresh'));
  ok('--fresh=0／false／no 才是关，大小写都算', !hasFlag(['--fresh=0'], 'fresh') && !hasFlag(['--fresh=false'], 'fresh') && !hasFlag(['--fresh=NO'], 'fresh') && !hasFlag(['--fresh=False'], 'fresh'));
  ok('--fresh= 空值算开：写了个等号不是把开关关掉', hasFlag(['--fresh='], 'fresh'));
  const maybe = (() => {
    try {
      return `值=${String(hasFlag(['--fresh=maybe'], 'fresh'))}`;
    } catch (e) {
      return `抛了：${String((e as Error).message)}`;
    }
  })();
  ok('认不出的值（--fresh=maybe）算开：不报错、也不猜成关', maybe === '值=true', maybe);
  ok('那一项根本没写就是关', hasFlag(['--players=4'], 'fresh') === false);
  ok('前缀撞不上名字：--no-discover 不是 --discover，--discover-slot=0 也不是那一档', hasFlag(['--no-discover', '--discover-slot=0'], 'discover') === false && hasFlag(['--no-discover'], 'no-discover') === true);
  ok('带值的写法也撞不上别人的名字：--fresh=1 关不掉 --no-discover 那档', hasFlag(['--fresh=1'], 'no-discover') === false);
}

// ───────────────────────── 一份存档只许一张桌写 ─────────────────────────

const refuse = (fn: () => unknown): string => {
  try {
    fn();
    return '';
  } catch (e) {
    return String((e as Error).message);
  }
};
/** 条上此刻写着什么。整套测里凡是「量一条红字」的句子都不许被一句 ENOENT 打断——打断了后面几十条一起没跑 */
const peekLock = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '‹没有占位条›');
const asLock = (file: string): SaveLock | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SaveLock;
  } catch {
    return null;
  }
};
const lockBody = (held: Partial<SaveLock>): string => JSON.stringify(held);

{
  // 一把尺子量的几档：这台桌能不能占这份存档。判断全在这个纯函数里，好让每种都点得着
  const here = '/repo/table.json';
  const mine: SaveLock = { pid: 1111, port: 5200, save: here };
  const living = (_pid: number): boolean => true;
  const dead = (_pid: number): boolean => false;
  ok('硬盘上没写过那条：能占', lockVerdict(null, mine, living) === 'free');
  ok('那条写的根本不是这一份存档（项目被整个拷了一份）：能占', lockVerdict({ pid: 57898, port: 5199, save: '/elsewhere/table.json' }, mine, living) === 'free');
  ok('写那条的就是自己这个进程、自己这个端口：同一趟里重起桌，算自己的', lockVerdict(mine, mine, living) === 'mine');
  ok('只对上 pid、端口不一样照样拒（同进程两张桌也打得起来才怪）', lockVerdict({ pid: 1111, port: 5199, save: here }, mine, living) === 'taken');
  ok('别人还活着占着：拒', lockVerdict({ pid: 2222, port: 5199, save: here }, mine, living) === 'taken');
  ok('写那条的进程已经没了：让开（前人挨 SIGKILL 走的留条不算闸）', lockVerdict({ pid: 2222, port: 5199, save: here }, mine, dead) === 'free');
}

console.log('占位条上那份存档路径怎么认到底');
{
  // 只干一件事：把那串路径认到那个文件本身。real 是注入的，所以「存档还没落盘」「连目录都没有」这两档都点得着
  const flat = (p: string): string => p;
  ok('认不出花活时至少把相对写法摊成绝对', canonicalSave('table.json', flat) === resolve('table.json'));
  ok('存档已经在硬盘上：认它自己那条到底的（软链那头写的是另一串字）', canonicalSave('/tmp/x/table.json', (p) => (p === '/tmp/x/table.json' ? '/private/tmp/x/table.json' : p)) === '/private/tmp/x/table.json');
  ok('存档还没落盘（新桌第一局）：认父目录的实底，再把文件名接回去', canonicalSave('/tmp/x/table.json', (p) => { if (p === '/tmp/x') return '/private/tmp/x'; throw new Error('ENOENT'); }) === '/private/tmp/x/table.json');
  ok('连父目录都不存在：退回摊平那一条，别抛（那句「目录没建」该由起桌的去念，不是这只手）', canonicalSave('/nope/y/table.json', () => { throw new Error('ENOENT'); }) === resolve('/nope/y/table.json'));
}

{
  const dir = mkdtempSync(join(tmpdir(), 'qdd-lock-'));
  const save = join(dir, 'table.json');
  const lock = lockPathOf(save);
  ok('占位条就躺在存档旁边：存档名加个 .lock，跟存档一起被 .gitignore 盖住', lock === `${save}.lock`, lock);

  const release = claimSave(save, 5199, () => false);
  const written = asLock(lock);
  ok('头一张桌占住了：写进去的是自己这个进程、这个端口、还有这一份存档认到底那一条路径', written?.pid === process.pid && written?.port === 5199 && written?.save === canonicalSave(save), peekLock(lock));
  ok('同一趟里重起桌不算撞：同 pid 同端口照样占得下来', refuse(() => claimSave(save, 5199, () => false)) === '', refuse(() => claimSave(save, 5199, () => false)));

  const clash = refuse(() => claimSave(save, 5200, () => true));
  ok('另一张活桌抢同一份存档：当场拒，不悄悄把人家的账盖了', clash.length > 0, clash || '居然让它占上了');
  ok('那句念得出撞上的是哪份存档、谁占着、往哪儿改', clash.includes(save) && clash.includes('5199') && clash.includes(String(process.pid)) && clash.includes('--save'), clash);
  ok('被拒那一张没把闸抢走：条上写的还是头一张', asLock(lock)?.port === 5199, peekLock(lock));

  writeFileSync(lock, lockBody({ pid: 424242, port: 7000 }));
  ok('读不懂的一条（半截字节、老代码留的没写存档路径的）当没人占：宁可让桌开起来，别拿烂字节把门锁死', refuse(() => claimSave(save, 5201, () => true)) === '', peekLock(lock));

  writeFileSync(lock, lockBody({ pid: 57898, port: 5199, save: join(dir, '别人的那份 table.json') }));
  ok('条上写着另一个进程号、占的却是另一份存档：这一份照开（冒烟在副本里跑就是这一档）', refuse(() => claimSave(save, 5202, () => true)) === '', peekLock(lock));

  writeFileSync(lock, lockBody({ pid: 424242, port: 7000, save: canonicalSave(save) }));
  ok('留条那位早没了：让开，这一张占上并把条换成自己的', refuse(() => claimSave(save, 5200, () => false)) === '' && asLock(lock)?.port === 5200, peekLock(lock));

  writeFileSync(lock, '{ 半截字');
  ok('整条读不出 JSON 的也让开（硬盘写满那一下留的半截字，不该把门永远锁上）', refuse(() => claimSave(save, 5201, () => true)) === '', peekLock(lock));

  writeFileSync(lock, lockBody({ pid: process.pid, port: 7777, save: canonicalSave(save) }));
  const real = refuse(() => claimSave(save, 5199));
  ok('不注入 alive 时也真认得「这个进程还活着」：同进程另一个端口照样拒', real.includes('7777'), real || '放行了');

  writeFileSync(lock, lockBody({ pid: 999999, port: 7777, save: canonicalSave(save) }));
  ok('不注入 alive 也认得死人：那条留条拦不住新桌（真进程号问出来的）', refuse(() => claimSave(save, 5199)) === '', peekLock(lock));

  const mineNow = claimSave(save, 5199, () => false);
  ok('收桌摘闸：摘掉之后这份存档空出来了', (mineNow(), !existsSync(lock)), peekLock(lock));
  ok('再摘一次不抛（close 走两趟也不该炸）', refuse(() => mineNow()) === '');
  const theirs = lockBody({ pid: 888888, port: 6000, save: canonicalSave(save) });
  writeFileSync(lock, theirs);
  mineNow();
  ok('别人的那条不许摘：接管过这张桌的人的闸，拆了等于没闸', peekLock(lock) === theirs, peekLock(lock));
  release();
}

{
  // 真软链走一遍：闸比的是那个文件，不是那串字。macOS 的 /tmp、/var 本身就是软链，
  // 而桌面版交回来的 userData 是认到底那一条、终端上敲的 --save= 是没认的那一条（2026-10-02 就是这么撞上两张桌写同一本账的）
  const dir = mkdtempSync(join(tmpdir(), 'qdd-symlink-'));
  const realDir = join(dir, 'real');
  const linkDir = join(dir, 'link');
  mkdirSync(realDir);
  symlinkSync(realDir, linkDir, 'dir');
  const save = join(realDir, 'table.json');
  const lock = lockPathOf(save);
  const release = claimSave(save, 5199, () => true);
  const viaLink = refuse(() => claimSave(join(linkDir, 'table.json'), 5200, () => true));
  ok('同一份存档换条软链写法照样撞：两张桌不许写同一本账，哪怕路径串得不一样', viaLink.includes('5199'), viaLink || '居然让它占上了——那张桌正在盖别人的账');
  ok('被拒那一张也没把闸抢走：条上写的还是头一张的端口', asLock(lock)?.port === 5199, peekLock(lock));
  release();
}

{
  // 桌面外壳挨强退／崩了那一条：那张桌不许赖在端口和占位条上。2026-10-02 真复现的——`kill -9` 掉外壳，
  // 桌活着、条留着，第二张桌被 claimSave 拒；而从访达点开的那个人没有终端，那句理由他根本看不见，屏幕上什么都不出现。
  const hook = (argv: string[], ppidSeq: number[]) => {
    const arms: number[] = [];
    let gone = 0;
    let cb = (): void => {};
    let asked = 0;
    orphanWatch(
      argv,
      () => {
        gone += 1;
      },
      () => ppidSeq[Math.min(asked++, ppidSeq.length - 1)],
      (ms, fn) => {
        arms.push(ms);
        cb = fn;
      },
    );
    return { gone: () => gone, tick: () => cb(), arms };
  };

  const off = hook([], [100, 1]);
  ok('不带 --watch-parent 就一个字都不装：npm run host 那条路的爹是终端，掀不得', off.arms.length === 0 && off.gone() === 0, off.arms.join());
  off.tick();
  ok('没装就没人问：就算父进程换了也不许自己走（那条路上「父没了」是常态——挂在终端里的人合上 shell 不算收桌）', off.gone() === 0, String(off.gone()));

  const on = hook(['--watch-parent'], [100, 100, 1]);
  ok('装上就一秒问一次：外壳强退之后这张桌别再多赖一分钟', on.arms.length === 1 && on.arms[0] === 1000, on.arms.join());
  on.tick();
  ok('爹还是原来那一位：不走（打到一半的桌不能被一句误判收掉）', on.gone() === 0, String(on.gone()));
  on.tick();
  ok('爹换人了（外壳挨 SIGKILL，macOS 把桌交回 launchd）：走 onGone，也就是 host.ts 那句先存档再退的 quit()', on.gone() === 1, String(on.gone()));

  const offVal = hook(['--watch-parent=0'], [100, 1]);
  ok('--watch-parent=0 是关：跟 --fresh=0 同一套开关口径', offVal.arms.length === 0, offVal.arms.join());
}

{
  // 两个宿主（npm run dev 和 npm run host）走的是同一个 openRoom：闸在那儿，不在各自那份横幅里
  const dir = mkdtempSync(join(tmpdir(), 'qdd-room-'));
  const save = join(dir, 'table.json');
  const lock = lockPathOf(save);
  const first: { room: Room | null; err: string } = { room: null, err: '' };
  try {
    first.room = openRoom(['--no-discover', `--save=${save}`], 5901);
  } catch (e) {
    first.err = String((e as Error).message);
  }
  ok('头一张桌起得来，起桌第一件事就是占住这份存档：条上写的就是这个端口', first.err === '' && asLock(lock)?.port === 5901, first.err || peekLock(lock));
  const clash = refuse(() => openRoom(['--no-discover', `--save=${save}`], 5902));
  ok('第二张桌在同一份存档上起不来：openRoom 当场抛，两句宿主都念这一句', clash.includes('5901') && clash.includes('--save'), clash || '两张桌都起来了');
  ok('被拒那一张没碰头一张的闸：条上写的还是 5901 那一桌', asLock(lock)?.port === 5901, peekLock(lock));
  first.room?.close();
  ok('收桌把占位条一起摘了：下一张不该被一个已经收杆的人挡在门外', !existsSync(lock), peekLock(lock));
  const another = join(dir, 'another.json');
  const second: { room: Room | null; err: string } = { room: null, err: '' };
  try {
    second.room = openRoom(['--no-discover', `--save=${another}`], 5902);
  } catch (e) {
    second.err = String((e as Error).message);
  }
  ok('各用各的存档就互不挡事：加了 --save=另一份文件照样起桌', second.err === '' && existsSync(lockPathOf(another)), second.err);
  second.room?.close();
}

{
  // 存档写不下去（磁盘满、权限不对、存档路径被占成一个目录）：这颗 write 跑在 300ms 合批的 timer 回调里，
  // 从 timer 抛出去就是 uncaughtException 带走全桌——对照 serve.ts「读不出来别让整个进程跟着抛」的口径，
  // 静态服务侧有闸、存档侧不能没有。把存档位建成一个目录：atomicPut 换名那一步必然砸，量四件事：
  // 起桌不炸、那句人话念得出来、半截中转名不留、桌继续跑。
  const dir = mkdtempSync(join(tmpdir(), 'qdd-savefail-'));
  const asFile = join(dir, '存档位');
  mkdirSync(asFile);
  const said: string[] = [];
  const rawLog = console.log;
  const cap = (into: string[]) => (...a: unknown[]): void => void into.push(a.map(String).join(' '));
  console.log = cap(said);
  const first: { room: Room | null; err: string } = { room: null, err: '' };
  try {
    first.room = openRoom(['--no-discover', '--fresh', `--save=${asFile}`], 5903);
  } catch (e) {
    first.err = String((e as Error).message);
  } finally {
    console.log = rawLog;
  }
  ok('存档写不下去，起桌不许当场炸（牌局比硬盘金贵）', first.err === '' && first.room !== null, first.err);
  ok('念得出去哪了：「存档写不下去」那句人话得出来', said.some((l) => l.includes('存档写不下去')), said.join('｜'));
  ok('失败那一下不留半截中转名（半截字节躺在目录里，下回谁看见都以为是份正经存档）', !existsSync(`${asFile}.tmp`), `${asFile}.tmp 还在`);
  ok('本桌继续跑：牌桌照常答话', first.room !== null && first.room.table.lobby().status === 'waiting', first.room ? first.room.table.lobby().status : '没起成');
  // 收桌：write 走 saveOff 早退，不该被上回那次失败卡住；latch 真闩上的话也不该再试写一遍
  const after: string[] = [];
  console.log = cap(after);
  let closed = '';
  try {
    first.room?.close();
  } catch (e) {
    closed = String((e as Error).message);
  } finally {
    console.log = rawLog;
  }
  ok('收桌不被写失败卡住（停落盘 ≠ 停收桌）', closed === '', closed);
  ok('停落盘真闩上了：收桌不再反复试写', !after.some((l) => l.includes('存档写不下去')), after.join('｜'));
  ok('收桌照样把占位条摘了（闸只管占位，跟落不落盘是两码事）', !existsSync(lockPathOf(asFile)), peekLock(lockPathOf(asFile)));
}


console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
