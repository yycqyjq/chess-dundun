/**
 * 同网找桌的测试：一份自我介绍、一块网段的广播地址、一本会老的账，再加寻呼那一头搬字节的那几手。
 * 全在 Node 里跑：网络的口子拿假 socket 堵住，硬盘上只往 /tmp 里临时建一间假 dist。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Level } from '../ai/agent.ts';
import type { Lobby, SeatInfo, TableStatus } from '../net/wire.ts';
import {
  ANNOUNCE_PORT,
  OFFER_TTL,
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
import { fileFor, mimeOf } from '../node/serve.ts';

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
    bind(): void {}
    send(msg: Buffer, port: number, address: string): void {
      this.sends.push({ text: msg.toString('utf8'), port, addr: address });
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
}

console.log('\n端 dist 那一小段：这串 URL 该落到哪个文件');
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
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条没过`);
process.exit(failures === 0 ? 0 : 1);
