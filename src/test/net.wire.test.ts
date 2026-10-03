/**
 * 联机层测试（拆分后）：共享夹具从 net.harness.ts 来。
 * 原 net.test.ts 一拆三：桌的生命周期 / 宿主与账 / 形闸·快照·WS 服务端。
 */
import { createServer, type Server } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { parseRules, pendingSeats } from '../core/game.ts';
import { buildPieceSet } from '../core/pieces.ts';
import { gate, type Verdict } from '../node/room.ts';
import { TAKEOVER_MS } from '../node/table.ts';
import { checkHost, hydrate, snapshotFor, type ToHost } from '../net/wire.ts';
import { WsServer } from '../node/ws.ts';
import { draftShape, layout, type Board } from '../web/board.ts';
import {
  blankView,
  finishDraft,
  ok,
  openedTable,
  pieceOf,
  pilesOf,
  playedIds,
  rules,
  failures,
} from './net.harness.ts';

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
  ok('散桌那句认', held({ t: 'disband' })?.t === 'disband');
  ok('散桌那句不多带野字段', JSON.stringify(held({ t: 'disband', 顺手: '抹掉' })) === '{"t":"disband"}');
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
  ok('人数 3 现在过闸（三人档进桌）', held({ t: 'setup', players: 3 })?.t === 'setup');
  ok('人数不在档位上改不动，那句念 2、3 或 4', why({ t: 'setup', players: 5 }).includes('2、3 或 4'));
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
  ok('人数不在档位上：回绝话', reject('{"t":"setup","players":5,"mode":"kou","level":"easy"}').length > 0);
  ok('3 人这一档现在原样递到桌前', (() => {
    const r = v('{"t":"setup","players":3,"mode":"kou","level":"easy"}');
    return 'msg' in r && r.msg.t === 'setup';
  })());
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
  // ─── 既定取舍的检测闸（不是防线，是账本）──────────────────────────
  // 联机暗棋的扣牌保密建立在「同桌可信」上——README「威胁边界」那段签过字的两笔账：
  // ① 快照带着牌局原始 seed（为的是「按种子复现这一副牌」，状态栏/战报/报错都念它）；
  // ② 未开牌只剩 id，而 id→牌名是公开规则表的固定函数（pieces.ts 按职级连续编号）。
  // 合起来：任何连得上这桌的人，拿快照里的公开字段就能把别家扣牌逐张还原。
  // 这里钉住现状——哪天要放到公网、让陌生人可坐，这两条会红，提醒你
  // 直接上「服务端权威、增量下发视图」，别做摘 seed 那种半吊子（单做挡不住 ②）。
  const { table } = openedTable({ mode: 'kou' });
  const state = table.state;
  finishDraft(table);
  const foe = 1;
  const view = snapshotFor(state, 0, state.log.length);

  ok(
    '既定取舍①：快照里带着牌局原始 seed（要摘它＝改协议，先读 README 威胁边界那段）',
    view.seed === state.seed,
    `view.seed=${view.seed} vs state.seed=${state.seed}`,
  );

  // ②的重放腿：攻击者只用快照里公开的 rules 就能造出 id→牌名表——不碰 seed、不碰 label
  const publicRules = parseRules(view.rules);
  const idName = new Map(buildPieceSet(publicRules.ranks).map((p) => [p.id, p.label]));
  const foeHand = state.hands[foe]!;
  const decoded = foeHand.map((id) => idName.get(id));
  const truth = foeHand.map((id) => state.byId.get(id)!.label);
  ok(
    '既定取舍②：对手扣牌的 id 用快照自带的规则表逐张还原成牌名（同桌可信才挡得住）',
    decoded.length === truth.length && decoded.every((name, i) => name !== undefined && name === truth[i]),
    `还原前 3 张：${decoded.slice(0, 3).join('/')}｜真值：${truth.slice(0, 3).join('/')}`,
  );
  ok(
    '这条检测闸的前提没变：对手的牌在快照里确实只剩光 id（label 没漏）',
    foeHand.every((id) => pieceOf(view, id)?.label === undefined),
    '',
  );
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
function sweepLayout(mode: 'ming' | 'kou', players = 2): void {
  const { table, clock } = openedTable({ mode, players }, Array.from({ length: players }, (_, i) => i));
  const state = table.state;
  // 和 app.ts 那一头同一个写法：桌面的摞数／层数由这一档的状态给（3 人 10 摞 × 3），别写死一份
  const board: Board = { w: 900, h: 620, ...draftShape(state) };
  let frames = 0;
  let bad = '';
  const once = (): void => {
    for (const seat of Array.from({ length: state.players }, (_, i) => i)) {
      const raw = snapshotFor(state, seat, state.log.length);
      const labeled = new Set(raw.pieces.filter((p) => p.label !== undefined).map((p) => p.id));
      try {
        const back = hydrate(raw);
        const view = blankView(state.players, seat);
        view.piles = pilesOf(back);
        const trick = back.trick;
        if (trick) {
          view.freeze = trick.plays.map((p) => ({ seat: p.seat, ids: [...p.pieceIds], pledge: false, best: false }));
          // 网页里鼠标压上来，自己那一套扣着的牌就亮给自己看——快照要是不带牌名，这儿就成空白牌了
          const own = [...trick.plays, ...trick.discards].find((p) => p.seat === seat);
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
  ok(`${mode === 'kou' ? '扣棋' : '明棋'} ${players} 人：整局每一份快照都排得出版面`, bad === '' && frames >= 20, bad || `只排了 ${frames} 帧`);
}

sweepLayout('kou');
sweepLayout('ming');
// 3 人档那一副牌少两枚、一摞三层：打码和排版在联机那一头也得各走一整局
sweepLayout('kou', 3);
sweepLayout('ming', 3);


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

// ───────────────────────── 纯度闸：src/net 只许是浏览器那头读得了的 ─────────────────────────

{
  // 桌与 WS 服务端已经搬去 src/node（Node 专用）；src/net 剩下的必须保持纯净，
  // 别哪天顺手从这儿 import 一个 node: 模块，把浏览器打包那一头带崩。
  const names = readdirSync('src/net').filter((f) => f.endsWith('.ts'));
  const hits: string[] = [];
  for (const name of names) {
    const text = readFileSync(`src/net/${name}`, 'utf8');
    if (/from ['"]node:/.test(text)) hits.push(`${name} 引了 node: 模块`);
    if (/\bBuffer\b/.test(text)) hits.push(`${name} 用了 Buffer`);
    if (/\bprocess\./.test(text)) hits.push(`${name} 用了 process.`);
  }
  ok('src/net 里每个文件都不引 node: 模块（浏览器那头读得了）', names.length > 0 && !hits.some((h) => h.includes('node:')), hits.join('｜'));
  ok('src/net 里每个文件都不碰 Buffer', !hits.some((h) => h.includes('Buffer')), hits.join('｜'));
  ok('src/net 里每个文件都不碰 process.', !hits.some((h) => h.includes('process.')), hits.join('｜'));
}

console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`);
process.exit(failures === 0 ? 0 : 1);
