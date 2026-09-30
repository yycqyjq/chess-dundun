/**
 * 同网找桌的测试：一份自我介绍、一块网段的广播地址、一本会老的账、这块网卡该不该报出去、dist 那头怎么端，再加寻呼那一头搬字节的那几手。
 * 全在 Node 里跑：网络的口子拿假 socket 堵住，硬盘上只往 /tmp 里临时建一间假 dist。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Level } from '../ai/agent.ts';
import type { Lobby, SeatInfo, TableStatus } from '../net/wire.ts';
import {
  ANNOUNCE_PORT,
  LIST_REFRESH_MS,
  OFFER_TTL,
  SWEEP_MIN_MS,
  WHOAMI,
  absorb,
  announcePortOf,
  broadcastOf,
  encodeOffer,
  foundLine,
  isMine,
  listFound,
  NO_DISCOVER,
  offerOf,
  parseOffer,
  peerNote,
  prune,
  roomKey,
  roomUrl,
  slotOf,
  sweepDue,
  sweepPorts,
  targetsFor,
  type FoundRoom,
  type RoomCache,
} from '../net/discover.ts';
import { openDiscovery, type Sock } from '../node/discover.ts';
import { lanNets } from '../node/room.ts';
import { fileFor, mimeOf, notFound, sendFile } from '../node/serve.ts';

let failures = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 一份够得着的最小座位表：几把椅子、哪几把有人，其余字段摆个样子 */
function lobby(players: number, flags: Partial<SeatInfo>[] = [], over: Partial<Lobby> = {}): Lobby {
  const seats: SeatInfo[] = Array.from({ length: players }, (_, seat) => ({
    seat,
    name: `P${seat + 1}`,
    online: false,
    taken: false,
    ai: true,
    human: false,
    queued: false,
    nick: '',
    ...flags[seat],
  }));
  return {
    players,
    hostSeat: 0,
    homeSeat: 0,
    gameNo: 1,
    mode: 'kou',
    level: 'hard' as Level,
    seats,
    status: 'waiting' as TableStatus,
    ...over,
  };
}

/** 一条答话（可改几个字段），拿来喂 parseOffer */
function say(patch: Partial<Record<keyof FoundRoom | 'evil', unknown>>): string {
  const o = { t: WHOAMI, ...offerOf(lobby(2), 5300) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'ip') continue;
    o[k] = v;
  }
  return JSON.stringify(o);
}

console.log('\n自我介绍：一张桌只报公开得出来的那几句');
{
  const free = offerOf(lobby(4), 5200);
  ok('一把椅子没坐，空位就是座位数', free.free === 4 && free.port === 5200, JSON.stringify(free));
  const full = offerOf(lobby(2, [{ online: true }, { online: true }]), 5200);
  ok('坐满了，空位归零', full.free === 0, JSON.stringify(full));
  // 掉了线但那把椅子还认得他：对候场厅来说这不是空位，别报成「还空一把」引人去坐有主的椅子
  const gone = offerOf(lobby(2, [{ taken: true, nick: 'K2' }]), 5200);
  ok('掉线了、椅子有主，也不报成空位', gone.free === 1, JSON.stringify(gone));
  const queued = offerOf(lobby(2, [{ online: true, queued: true }]), 5200);
  ok('中途坐下、这一局还归电脑，照样占着一把', queued.free === 1, JSON.stringify(queued));
  const playing = offerOf(lobby(2, [], { status: 'playing', gameNo: 3 }), 5200);
  ok('开打中报的是开打中、第几局也跟着报', playing.status === 'playing' && playing.gameNo === 3);
}

console.log('\n一句答话来回：原样出去、原样回来，认不下的当场拒');
{
  const f = parseOffer(encodeOffer(offerOf(lobby(4, [{ online: true }]), 5300)), '192.168.1.31');
  const want = { ip: '192.168.1.31', port: 5300, players: 4, gameNo: 1, mode: 'kou', level: 'hard', status: 'waiting', free: 3 };
  ok('自己报的、自己听得回', JSON.stringify(f) === JSON.stringify(want), JSON.stringify(f));
  ok(
    '地址由 ip 和端口现拼，不照抄线上来的字符串',
    roomUrl({ ip: '10.1.2.3', port: 5199 }) === 'http://10.1.2.3:5199/',
  );

  const bad = (name: string, text: string, from = '192.168.1.31'): void =>
    ok(name, typeof parseOffer(text, from) === 'string', text);
  bad('玩法写着没听过的拒', say({ mode: 'zzz' }));
  bad('电脑档位写着没听过的拒', say({ level: 'impossible' }));
  bad('状态写着没听过的拒', say({ status: 'paused' }));
  bad('端口 22 那种不谈', say({ port: 22 }));
  bad('端口大到出格拒', say({ port: 70000 }));
  bad('端口写成字拒', say({ port: '5300' }));
  bad('端口写成分数拒', say({ port: 5300.5 }));
  bad('座位数 0 拒', say({ players: 0 }));
  bad('座位数 9 拒', say({ players: 9 }));
  bad('空位比座位还多拒', say({ free: 5 }));
  bad('空位写成负数拒', say({ free: -1 }));
  bad('第 0 局拒', say({ gameNo: 0 }));
  bad('局号写成字拒', say({ gameNo: '3' }));
  bad('没头没尾的一句拒', JSON.stringify({ port: 5300, players: 2 }));
  bad('不是 JSON 的字节拒（也不抛）', 'hello');
  bad('空字节拒', '');
  // 多一字段不拦：报料那一版比这版新是常事，拦了等于老房主认不了新房主。
  // 要紧的是它带不进来——清单里只可能有校验过那八格，下面一条盯着这个。
  const stray = parseOffer(say({ evil: 1 }), '192.168.1.31');
  ok('野字段不影响认话', typeof stray !== 'string', say({ evil: 1 }));
  ok('认下来的那份里没有野字段那一格', !('evil' in (stray as object)));
  bad('话不是自家这块网里来的拒', encodeOffer(offerOf(lobby(2), 5300)), '8.8.8.8');
  bad('来源写成花样的拒', encodeOffer(offerOf(lobby(2), 5300)), '192.168.1.31/x');
  bad('来源是网口的拒', encodeOffer(offerOf(lobby(2), 5300)), '::1');
}

console.log('\n往哪儿发：广播地址自己算，槽按 http 端口落');
{
  ok('192.168.1.7 /24 的广播是 .255', broadcastOf('192.168.1.7', '255.255.255.0') === '192.168.1.255');
  ok('10.0.3.9 /16 的广播是 10.0.255.255', broadcastOf('10.0.3.9', '255.255.0.0') === '10.0.255.255');
  ok('172.16.5.5 /20 也算得出来', broadcastOf('172.16.5.5', '255.255.240.0') === '172.16.15.255');
  ok('/32 没有广播地址可发', broadcastOf('192.168.1.7', '255.255.255.255') === null);
  ok('/31 也没有：算出来是别机器的单播地址', broadcastOf('192.168.1.7', '255.255.255.254') === null);
  ok('零散掩码不认（算出来的地址谁也不收）', broadcastOf('192.168.1.7', '255.0.255.0') === null);
  ok('公网地址不发广播', broadcastOf('8.8.8.8', '255.255.255.0') === null);
  ok('掩码写歪了不猜', broadcastOf('192.168.1.7', 'abc') === null);
  ok('掩码段数不对不猜', broadcastOf('192.168.1.7', '255.255') === null);
  ok('IP 写成三段不猜', broadcastOf('192.168.1', '255.255.255.0') === null);
  ok('10/8 那种掩码算得出来（自家最宽的一块私网）', broadcastOf('10.30.1.2', '255.0.0.0') === '10.255.255.255');
  ok('掩码写成公网的也算不出广播', broadcastOf('192.168.1.7', '0.0.0.0') === null);

  const t = targetsFor([
    { ip: '192.168.1.7', mask: '255.255.255.0' },
    { ip: '192.168.1.9', mask: '255.255.255.0' },
    { ip: '10.30.1.2', mask: '255.255.0.0' },
  ]);
  ok('发往自己那块网段的定向广播', t.includes('192.168.1.255') && t.includes('10.30.255.255'), t.join(','));
  ok('两块网卡同网段，也只发一份定向广播（去重）', t.filter((x) => x === '192.168.1.255').length === 1, t.join(','));
  ok('全网广播和回环都在（一台机器两张桌靠回环）', t.includes('255.255.255.255') && t.includes('127.0.0.1'), t.join(','));
  ok('一张网卡都没有，也还剩回环和全网两条', targetsFor([]).length === 2, targetsFor([]).join(','));

  ok('dev 5199 落在第 7 槽', slotOf(5199) === 7 && announcePortOf(5199) === ANNOUNCE_PORT + 7);
  ok('host 5200 落在第 0 槽：同一台机器上两张桌各守一口', slotOf(5200) === 0 && announcePortOf(5200) === ANNOUNCE_PORT);
  const ports = sweepPorts();
  ok(
    '寻的一侧一口不漏问遍这八槽',
    ports.length === 8 && ports[0] === ANNOUNCE_PORT && ports[7] === ANNOUNCE_PORT + 7,
    ports.join(','),
  );
}

console.log('\n这本账会老：谁报得勤算谁，听不见的抹掉');
{
  const cache: RoomCache = new Map();
  const one = { ...offerOf(lobby(2), 5301), ip: '192.168.1.41' };
  const two = { ...offerOf(lobby(4, [{ online: true }]), 5302), ip: '192.168.1.42' };
  absorb(cache, [one, two], 1000);
  ok('两条各占一格', cache.size === 2, [...cache.keys()].join(','));
  absorb(cache, [one], 2500);
  ok('同一张桌报两回，只刷新时间不加条', cache.size === 2 && cache.get(roomKey(one))!.at === 2500, `${cache.size}`);
  prune(cache, 1000 + OFFER_TTL - 1);
  ok('还没到 TTL 的一条都不抹（另一条才报到 2500）', cache.size === 2);
  prune(cache, 1000 + OFFER_TTL + 1);
  ok('过了 TTL 先把没再报的那条抹了', cache.size === 1 && cache.has(roomKey(one)), [...cache.keys()].join(','));
  prune(cache, 2500 + OFFER_TTL + 1);
  ok('谁也不报了，这本账就该空', cache.size === 0, [...cache.keys()].join(','));

  const book: RoomCache = new Map();
  const mine = { ips: ['192.168.1.7'], port: 5200 };
  const mk = (patch: Partial<FoundRoom>): FoundRoom => ({ ...offerOf(lobby(4), 0), ip: '192.168.1.99', ...patch });
  absorb(book, [mk({ port: 5301, status: 'playing', free: 2 }), mk({ port: 5302, free: 1 }), mk({ port: 5303, free: 3 })], 100);
  const list = listFound(book, 200, mine);
  ok('三条都在', list.length === 3, JSON.stringify(list.map((f) => f.port)));
  ok('正在打的沉底', list[2]!.port === 5301, JSON.stringify(list.map((f) => f.port)));
  ok('空位多的在前', list[0]!.port === 5303 && list[1]!.port === 5302, JSON.stringify(list.map((f) => f.port)));
  const aged = listFound(book, 100 + OFFER_TTL + 1, mine);
  ok('摆出来那份也顺手把老的抹了', aged.length === 0 && book.size === 0);

  const self: RoomCache = new Map();
  absorb(
    self,
    [mk({ ip: '127.0.0.1', port: 5200 }), mk({ ip: '192.168.1.7', port: 5200 }), mk({ ip: '192.168.1.50', port: 5200 })],
    100,
  );
  const others = listFound(self, 200, mine);
  ok(
    '自己绕回来的那两条不列（本机网卡、回环各一条）',
    others.length === 1 && others[0]!.ip === '192.168.1.50',
    JSON.stringify(others.map((f) => f.ip)),
  );
  ok('别的机器上同样端口的照列（那是正经另一桌）', isMine(mk({ ip: '192.168.1.60', port: 5200 }), mine.ips, mine.port) === false);
  ok('同端口、又是本机网口才算自己', isMine(mk({ ip: '192.168.1.7', port: 5200 }), mine.ips, mine.port) === true);
  ok('同一台机器上端口不同的不是自己', isMine(mk({ ip: '192.168.1.7', port: 5199 }), mine.ips, mine.port) === false);

  ok('三秒内不必再来一轮', sweepDue(1000, 3999) === false && sweepDue(1000, 4000) === true);
  // 列表页站着不动也五秒一轮：间隔宽过宿主那道闸，好几台设备同时站在这页上才不会一起刷这块网
  ok('列表页那一轮不越过宿主那道闸：间隔只会更稀，不会更密', LIST_REFRESH_MS >= SWEEP_MIN_MS, `${LIST_REFRESH_MS} vs ${SWEEP_MIN_MS}`);
  ok('列表页那一轮也不是按分钟算的（桌会老，太稀就看不见刚开的桌）', LIST_REFRESH_MS <= OFFER_TTL, `${LIST_REFRESH_MS} vs ${OFFER_TTL}`);
  const line = foundLine(mk({ players: 4, mode: 'ming', gameNo: 2, free: 1 }));
  ok('一句情况念得出：人数玩法局号空位', line === '4 人 · 明棋 · 等开局 · 第 2 局 · 还空 1 把', line);
  ok('坐满了说人话', foundLine(mk({ free: 0 })).includes('坐满了'));
  ok('正在打的写在前面', foundLine(mk({ status: 'playing' })).includes('正在打 · 第 1 局'));
  ok('寻到了就不念 AP 隔离那句', peerNote([mk({})], '').includes('同网寻到 1 张桌'));
  ok('空清单有原因，念原因', peerNote([], '这台机器的寻呼关着') === '这台机器的寻呼关着');
  ok('空清单没原因，念下一步', peerNote([], '').includes('AP 隔离'));
  // 宿主那句兜底（room.ts 的 find）用的就是这一句，冒烟里对的是同一串字
  ok('寻呼关着那句：说清为什么，也说出下一步', NO_DISCOVER.includes('--no-discover') && NO_DISCOVER.includes('手动'), NO_DISCOVER);
  ok('关着那句经 peerNote 原样端到人面前', peerNote([], NO_DISCOVER) === NO_DISCOVER);
}

console.log('\n搬字节那一头：口令答一句、答话归一本账、野字节不吭');
{
  /** 一只假 socket：网络那两头（听、发）都收在这儿，测试自己敲 */
  class Fake implements Sock {
    sends: { text: string; port: number; addr: string }[] = [];
    closed = 0;
    /** 绑好之后有没有把广播打开（2026-09-29 那把 EACCES 就是缺这一步） */
    broadcast: boolean | null = null;
    /** bind 和 setBroadcast 的先后：反了就是 EBADF */
    order: string[] = [];
    /** 递一句「发不出去」：广播发不动时那句真原因也得有闸 */
    fail: string | null = null;
    private msg: ((m: Buffer, r: { address: string; port: number }) => void) | null = null;
    private err: ((e: Error) => void) | null = null;
    on(ev: 'message', cb: (m: Buffer, r: { address: string; port: number }) => void): void;
    on(ev: 'error', cb: (e: Error) => void): void;
    on(
      ev: 'message' | 'error',
      cb: ((m: Buffer, r: { address: string; port: number }) => void) | ((e: Error) => void),
    ): void {
      if (ev === 'message') this.msg = cb as (m: Buffer, r: { address: string; port: number }) => void;
      else this.err = cb as (e: Error) => void;
    }
    bind(_port: number, _address: string, cb?: () => void): void {
      this.order.push('bind');
      cb?.(); // 真 socket 是 'listening' 之后回调，假的一拍到位
    }
    setBroadcast(flag: boolean): void {
      this.order.push('setBroadcast');
      this.broadcast = flag;
    }
    send(msg: Buffer, port: number, address: string, cb?: (err?: Error | null) => void): void {
      this.sends.push({ text: msg.toString('utf8'), port, addr: address });
      if (this.fail) cb?.(new Error(this.fail));
    }
    close(): void {
      this.closed++;
    }
    /** 外面敲上门：一句字节从哪个地址哪个口来的 */
    hear(text: string, address = '192.168.1.31', port = 41735): void {
      this.msg?.(Buffer.from(text), { address, port });
    }
    snap(e: Error): void {
      this.err?.(e);
    }
    /** 已经发出去的那句口令有几条 */
    queries(from = 0): number {
      return this.sends.slice(from).filter((s) => s.text === WHOAMI).length;
    }
  }

  const answer = encodeOffer(offerOf(lobby(4, [{ online: true }]), 5300));
  const opt = (httpPort = 5300, slot?: number) => ({
    httpPort,
    slot,
    nets: [{ ip: '192.168.1.7', mask: '255.255.255.0' }],
    answer: () => answer,
    log: () => {},
  });
  /** 等回音那一段在测试里不等：假 socket 的账当场就能看见 */
  const nowait = (): Promise<void> => Promise.resolve();

  const a = new Fake();
  const da = openDiscovery(opt(), a, nowait);
  a.hear(WHOAMI);
  ok('听见口令就答一句，原路送回那个口', a.sends.length === 1 && a.sends[0]!.text === answer && a.sends[0]!.port === 41735, JSON.stringify(a.sends));
  a.hear('not a word');
  a.hear('{"t":"别的程序"}');
  a.hear(say({ mode: 'zzz' }));
  ok('不是口令、也不是像样的答话：一个字都不回', a.sends.length === 1, JSON.stringify(a.sends));

  const before = a.sends.length;
  const r1 = await da.find();
  ok('按一颗就朝八槽发口令', a.queries(before) === 8 * 3, `${a.queries(before)}`);
  ok('发往回环和定向广播两头', a.sends.slice(before).some((s) => s.addr === '127.0.0.1') && a.sends.slice(before).some((s) => s.addr === '192.168.1.255'));
  ok('上一轮还没寻到过：清单是空的', r1.rooms.length === 0, JSON.stringify(r1));
  a.hear(encodeOffer(offerOf(lobby(2), 5400)), '192.168.1.80');
  const sent = a.sends.length;
  const r2 = await da.find();
  ok('三秒内再按不再发一个包', a.sends.length === sent, `${a.sends.length}`);
  ok('回话讲明白这是上一轮的账', r2.why.includes('刚寻过一轮'), r2.why);
  ok('上一轮听见的照端出来', r2.rooms.length === 1 && roomUrl(r2.rooms[0]!) === 'http://192.168.1.80:5400/', JSON.stringify(r2.rooms));

  const b = new Fake();
  const db = openDiscovery(opt(), b, nowait);
  b.hear(answer, '127.0.0.1');
  b.hear(answer, '192.168.1.7');
  const same = await db.find();
  ok('自己那张桌（回环、本机网卡各绕回来一次）都不列', same.rooms.length === 0, JSON.stringify(same.rooms));
  b.hear(encodeOffer(offerOf(lobby(2), 5399)), '192.168.1.7');
  const near = await db.find();
  ok('同一台机器上端口不同的算另一张桌', near.rooms.length === 1 && near.rooms[0]!.port === 5399, JSON.stringify(near.rooms));

  const c = new Fake();
  const dc = openDiscovery(opt(5300, 3), c, nowait);
  ok('守的口 = 底座 ＋ 那一槽', dc.port === ANNOUNCE_PORT + 3, `${dc.port}`);
  const d = new Fake();
  const dd = openDiscovery(opt(5200), d, nowait);
  ok('没给槽就按 http 端口落（5200 → 底座本身）', dd.port === ANNOUNCE_PORT, `${dd.port}`);
  ok('答话里报的端口就是这张桌的 http 端口', JSON.parse(answer).port === 5300);

  const e = new Fake();
  const de = openDiscovery(opt(), e, nowait);
  e.snap(new Error('EADDRINUSE'));
  const dead = await de.find();
  ok('寻呼口断了：不抛、清单空、给一句人话', dead.rooms.length === 0 && dead.why.includes('寻呼口占不住'), dead.why);
  const sends = e.sends.length;
  e.hear(WHOAMI);
  ok('断了之后既不再答话，也不再发包', e.sends.length === sends, `${e.sends.length}`);
  de.close();
  ok('close 之后收字节不炸', (e.hear(WHOAMI), e.sends.length === sends));

  const f = new Fake();
  const df = openDiscovery(opt(), f, nowait);
  df.close();
  ok('close 关掉那只 socket 一次', f.closed === 1);
  const pre = f.sends.length;
  const after = await df.find();
  ok('关了以后再按：回一句空的，不再发包', f.sends.length === pre && after.rooms.length === 0, JSON.stringify(after));

  // 2026-09-29：真机器上「找同网的桌」永远一张空清单，量出来是 dgram 默认不开广播——
  // 那两个广播目标发出去就 EACCES，只剩回环绕回自己，`isMine` 一抹就没桌可列了。下面这两条钉的就是那一步。
  const g = new Fake();
  openDiscovery(opt(), g, nowait);
  ok('绑好就把广播打开（不开的话广播那两路一个包都出不去）', g.broadcast === true, `setBroadcast ${String(g.broadcast)}`);
  ok('开广播排在 bind 之后（bind 之前调是 EBADF）', g.order.join(',') === 'bind,setBroadcast', g.order.join(','));

  const h = new Fake();
  h.fail = 'send EACCES 192.168.1.255:41732';
  const noGo = await openDiscovery(opt(), h, nowait).find();
  ok(
    '广播真发不出去：说一句真原因，别拿「这块网不让设备之间互访」顶',
    noGo.rooms.length === 0 && noGo.why.includes('send EACCES') && !noGo.why.includes('互访'),
    noGo.why,
  );

  const j = new Fake();
  const clean = await openDiscovery(opt(), j, nowait).find();
  ok('发得出去就不给这句假原因', clean.rooms.length === 0 && clean.why === '', JSON.stringify(clean));
}

console.log('\n端 dist 那一小段：这串 URL 该落到哪个文件、落到之后怎么端出去');
{
  /** 假 dist 摆在一间屋子里：屋子还有一张 dist 外的文件，「出不出得去」那句才量得准 */
  const home = mkdtempSync(join(tmpdir(), 'cd-serve-'));
  const dist = join(home, 'dist');
  try {
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(home, 'secretx'), '屋外那张文件真在：闸拆了就该被翻出来');
    writeFileSync(join(dist, 'index.html'), '<html></html>');
    writeFileSync(join(dist, 'app.js'), '//');
    // 歪转义那两句撞的就是 serve.ts 里那句 catch：闸要是自己抛，得当场记一条 ✗，
    // 不然整套连红字都打不出来，这把刀只量得到退出码。
    const nullFor = (url: string): boolean => {
      try {
        return fileFor(url, dist) === null;
      } catch (e) {
        ok('歪转义不该把 fileFor 抛穿', false, String((e as Error).message));
        return false;
      }
    };
    ok('根路径就是 index.html', fileFor('/', dist) === join(dist, 'index.html'));
    ok('空路径也算它', fileFor('', dist) === join(dist, 'index.html'));
    ok('带查询串的认得（build 出来的资源都带 hash）', fileFor('/app.js?v=7', dist) === join(dist, 'app.js'));
    ok('斜杠堆几个都落回 dist 里', fileFor('///app.js', dist) === join(dist, 'app.js'));
    ok('转义写歪的一句：回 null，不当场抛', nullFor('/%25zz'));
    ok('半截 UTF-8 也一样', nullFor('/%e0%a0'));
    // 这三句是那道穿越闸的全部：屋外那张文件真读得动，闸一拆就回得出路径
    ok('../ 出得去就回 null', fileFor('/../secretx', dist) === null);
    ok('一路往上再绕回来也不给', fileFor('/assets/../../secretx', dist) === null);
    ok('转义过的 ../ 也不给', fileFor('/%2e%2e%2fsecretx', dist) === null);
    ok('屋外那张真在硬盘上（不然上面三条是白测）', readFileSync(join(home, 'secretx'), 'utf8').length > 0);
    ok('dist 里没有的文件回 null', fileFor('/nope.png', dist) === null);
    ok('拿目录当文件也不给', fileFor('/assets', dist) === null);
    ok('把 dist 自己的绝对路径塞进来也不给', fileFor(dist, dist) === null);
    ok('后缀认得 css', mimeOf('/a/b/c.css').startsWith('text/css'));
    ok('后缀认得 woff2', mimeOf('/f.woff2') === 'font/woff2');
    ok('没后缀不瞎猜', mimeOf('/a/b/noext') === 'application/octet-stream');
    // 端出去那一半：状态码、类型、还有「读不出来那一路不许把宿主抛穿」
    type Res = Parameters<typeof sendFile>[0];
    const record = (fn: (res: Res) => void) => {
      const hit = { code: 0, headers: {} as Record<string, string>, body: '', ends: 0, threw: '' };
      const res = {
        writeHead(code: number, headers: Record<string, string>) {
          hit.code = code;
          Object.assign(hit.headers, headers);
          return res;
        },
        end(body?: unknown) {
          hit.ends += 1;
          hit.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
          return res;
        },
      } as unknown as Res;
      try {
        fn(res);
      } catch (e) {
        hit.threw = String((e as Error).message ?? e);
      }
      return hit;
    };
    const ok200 = record((res) => sendFile(res, join(dist, 'index.html')));
    ok(
      '读得出来的文件：200、正文是文件自己那几字节、end 只调一次',
      ok200.threw === '' && ok200.code === 200 && ok200.body === '<html></html>' && ok200.ends === 1,
      JSON.stringify(ok200),
    );
    ok('类型跟着后缀走（.html 别端成下载）', ok200.headers['content-type'] === 'text/html; charset=utf8', JSON.stringify(ok200.headers));
    ok(
      '每份都带 no-store：build 一换 index.html，浏览器拿旧的就把新页面挡在外面',
      ok200.headers['cache-control'] === 'no-store',
      JSON.stringify(ok200.headers),
    );
    const bin = join(dist, 'raw.bin');
    writeFileSync(bin, 'bin-body');
    const okBin = record((res) => sendFile(res, bin));
    ok(
      '后缀认不出的文件照样端得出去，类型给 octet-stream：宁可下载，也别拿 text/plain 把别的类型糊过去',
      okBin.code === 200 && okBin.body === 'bin-body' && okBin.headers['content-type'] === 'application/octet-stream',
      JSON.stringify(okBin),
    );
    const gone = record((res) => sendFile(res, join(dist, 'gone.js')));
    ok(
      '文件这会儿读不出来那一路不许把宿主抛穿（这一抛是整个房主进程没了、全桌掉线）',
      gone.threw === '',
      JSON.stringify(gone),
    );
    ok(
      '读不出来的文件回 500、正文那句念得出人话：那是「这会儿读不出来」，不是「没这个文件」',
      gone.code === 500 && gone.headers['content-type'] === 'text/plain; charset=utf8' && gone.body === '这个文件这会儿读不出来',
      JSON.stringify(gone),
    );
    ok('500 那句写完就收：end 只调一次，不许接着往下再端一遍 200', gone.ends === 1, JSON.stringify(gone));
    const dir = record((res) => sendFile(res, dist));
    ok('拿目录当文件端出去也不许抛（EISDIR 也算读不出来）', dir.threw === '' && dir.code === 500, JSON.stringify(dir));
    const nf = record(notFound);
    ok(
      '认不出那串 URL：404＋一句「没这个文件」，一句就完事',
      nf.code === 404 && nf.body === '没这个文件' && nf.headers['content-type'] === 'text/plain; charset=utf8' && nf.ends === 1,
      JSON.stringify(nf),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log('\n这块网卡该不该报出去：筛选四条 + 谁排最前，全在一张假网卡表上判');
{
  type Nics = Parameters<typeof lanNets>[0];
  type Net = NonNullable<NonNullable<Nics>[string]>[number];
  /** 一块网卡上的一条地址：internal 那一路是回环，得单独摆 */
  const v4 = (ip: string, mask: string, internal = false): Net => ({
    family: 'IPv4',
    address: ip,
    netmask: mask,
    cidr: `${ip}/${mask}`,
    scopeid: undefined,
    mac: 'a1:b2:c3:d4:e5:f6',
    internal,
  });
  const v6 = (ip: string): Net => ({ family: 'IPv6', address: ip, netmask: 'ffff::', cidr: null, scopeid: 0, mac: 'a1:b2:c3:d4:e5:f6', internal: false });

  const ips = (nics: Record<string, Net[] | undefined>): string[] => lanNets(nics).map((n) => n.ip);

  ok(
    '回环那张（internal）不报：别人照着敲只能敲到自己',
    ips({ lo0: [v4('127.0.0.1', '255.0.0.0', true)] }).length === 0,
  );
  ok(
    '169.254 那张不报：那是没配上 DHCP 时自己编的，出不了这块网卡',
    ips({ en0: [v4('169.254.12.34', '255.255.0.0')] }).length === 0,
  );
  ok('v6 那条不报：寻呼那两头吃的是点分四段', ips({ en0: [v6('fe80::1%en0')] }).length === 0);
  ok(
    '翻来覆去要摘的那串名字都不报：VPN／网桥／容器上的地址到不了别的设备',
    ips({
      utun4: [v4('10.8.0.6', '255.255.255.0')],
      awdl0: [v4('169.254.9.9', '255.255.0.0')],
      bridge0: [v4('192.168.99.1', '255.255.255.0')],
      docker0: [v4('172.17.0.1', '255.255.0.0')],
      'br-9f2c': [v4('172.18.0.1', '255.255.0.0')],
      vmnet1: [v4('192.168.100.1', '255.255.255.0')],
      en0: [v4('192.168.1.7', '255.255.255.0')],
    }).join(',') === '192.168.1.7',
  );
  ok('一块网卡压根没列（undefined）不抛，也别塞进结果', (() => { try { return ips({ en0: undefined, en1: [v4('10.0.0.5', '255.0.0.0')] }).join(',') === '10.0.0.5'; } catch { return false; } })());
  ok(
    '一张干净的路由器网卡：IP 和掩码一起给，掩码得是那块网卡上抄来的，寻呼算广播地址吃的就是这两样',
    JSON.stringify(lanNets({ en0: [v4('192.168.1.7', '255.255.0.0')] })) === '[{"ip":"192.168.1.7","mask":"255.255.0.0"}]',
  );
  ok(
    '一块网卡上两条地址都报，谁先谁后按这块网卡自己的顺序',
    ips({ en0: [v4('192.168.1.7', '255.255.255.0'), v4('192.168.1.8', '255.255.255.0')] }).join(',') === '192.168.1.7,192.168.1.8',
  );
  ok(
    '二维码就该画那张：wlan 与 en0 并列最前，并列时按名字排',
    ips({ wlan0: [v4('10.0.0.9', '255.255.255.0')], en0: [v4('192.168.1.7', '255.255.255.0')] }).join(',') === '192.168.1.7,10.0.0.9',
  );
  ok(
    '连着路由器的那张多半是 wlan：wlan1 排在内置口 en5 之前',
    ips({ en5: [v4('6.6.6.6', '255.0.0.0')], wlan1: [v4('5.5.5.5', '255.0.0.0')] }).join(',') === '5.5.5.5,6.6.6.6',
  );
  ok(
    '往后排的是序号大的那张内置口：en1 在 en2 前，eth0 垫底',
    ips({ eth0: [v4('4.4.4.4', '255.0.0.0')], en2: [v4('3.3.3.3', '255.0.0.0')], en1: [v4('2.2.2.2', '255.0.0.0')], en0: [v4('1.1.1.1', '255.0.0.0')] }).join(',') === '1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4',
  );
  ok(
    '序号写到两位也别按字典序排：en2 在 en10 前',
    ips({ en10: [v4('8.8.8.8', '255.0.0.0')], en2: [v4('7.7.7.7', '255.0.0.0')] }).join(',') === '7.7.7.7,8.8.8.8',
  );
  ok(
    '认不出的名字一律排到最后（不摘掉，只是不占头一份）',
    ips({ ath0: [v4('9.9.9.9', '255.0.0.0')], en1: [v4('8.8.8.8', '255.0.0.0')] }).join(',') === '8.8.8.8,9.9.9.9',
  );
  ok(
    '空着不递就是问本机：回的那几项每条都是点分四段带掩码，一条筛过的都不许漏',
    lanNets().every((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n.ip) && /^\d+\.\d+\.\d+\.\d+$/.test(n.mask) && !n.ip.startsWith('169.254.')),
  );
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条没过`);
process.exit(failures === 0 ? 0 : 1);
