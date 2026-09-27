/**
 * 这一头那条连接的测试：拿一条假 WebSocket 把 Link 的脾气钉住，不碰浏览器也不碰真网络。
 * 钉的是三件最容易要命的事——
 * 断线时按下的那一手不许排队（排队就会在连回来那一刻递出一手旧牌，桌只会回一句不合法），
 * 握手成功那一下得先认椅子再补发攒下的话（反过来那句会被桌当成「没坐下的人递的」默默丢掉，人就锁死了），
 * 桌上安静不等于断线（对面想牌六秒太正常，先问一声 ping，问而不答才拆线）。
 * 这个文件住在 src/web：它要替 window/location/WebSocket 造假，只有这份 tsconfig 带着 DOM。
 */
import { deviceNick, forget, Link, PROBE_MS, QUIET_MS, recall, remember } from './net.ts';

let failures = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 测试要替浏览器装的这几样，全挂在 globalThis 上；不带 node 的 types，所以一律这么绕 */
const G = globalThis as unknown as Record<string, unknown>;

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  url: string;

  constructor(url: string) {
    this.url = url;
    made.push(this);
  }

  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  /** 替网管把这条线接通 */
  raise(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  /** 替桌发一句话过去 */
  hear(text: string): void {
    this.onmessage?.({ data: text });
  }
}

/** 一台设备的样子：一条假 WebSocket、一份假存储、一个能改的 host */
const made: FakeSocket[] = [];
let host = '192.168.1.7:5199';
const store = new Map<string, string>();
const session = new Map<string, string>();
/** 存储坏了的那台（隐私模式）：一碰就炸，Link 得照样干活 */
let broken = false;

function bag(map: Map<string, string>): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void } {
  return {
    getItem: (k) => {
      if (broken) throw new Error('存储不让碰');
      return map.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (broken) throw new Error('存储不让碰');
      map.set(k, v);
    },
    removeItem: (k) => {
      if (broken) throw new Error('存储不让碰');
      map.delete(k);
    },
  };
}

G.WebSocket = FakeSocket;
G.location = {
  get protocol() {
    return 'http:';
  },
  get host() {
    return host;
  },
};
G.localStorage = bag(store);
G.sessionStorage = bag(session);
G.window = {
  setTimeout: (fn: () => void, ms: number) => Number(setTimeout(fn, ms)),
  clearTimeout: (id: number) => clearTimeout(id),
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 新开一条连接：log 按到的先后记下来，好查「先认椅子还是先补发」。给个假钟就能一秒一秒推时间 */
function make(now?: () => number): { link: Link; sock: () => FakeSocket; log: string[] } {
  const log: string[] = [];
  const link = new Link(
    {
      onMsg: (m) => log.push(`msg:${m.t}`),
      onStatus: (text) => log.push(`status:${text}`),
      onReady: () => {
        // 这一句跑的时候，待发队列里那些话应该一条都还没出去
        log.push(`ready:${made.at(-1)?.sent.length ?? 0}`);
      },
    },
    now,
  );
  return { link, sock: () => made[made.length - 1]!, log };
}

// ---------- 断线那几秒按下的一手 ----------
{
  made.length = 0;
  const { link, sock, log } = make();
  const s = sock();
  ok('一上来就去敲门，路径固定 /ws', s.url === `ws://${host}/ws`, s.url);
  ok('还没连上：递动作回 false', link.send({ t: 'act', action: { kind: 'draw', stackIdx: 0 } }) === false);
  ok('还没连上：问座位表也回 false', link.send({ t: 'lobby' }) === false);
  s.raise();
  ok('握手成功那一下先认椅子：onReady 跑的时候一条都还没发', log.includes('ready:0'), log.join('|'));
  ok('认完椅子才补发攒下的那句', s.sent.length === 1 && JSON.parse(s.sent[0]!).t === 'lobby', s.sent.join());
  ok('断线时按下的那一手压根没排队，回来看不见旧牌面', !s.sent.some((x) => JSON.parse(x).t === 'act'));
  ok('连着的时候递动作：当场就走，回 true', link.send({ t: 'act', action: { kind: 'draw', stackIdx: 1 } }) === true);
  ok('连着时那句动作排在补发之后', JSON.parse(s.sent[1]!).t === 'act');
  link.close();
}

// ---------- 断了以后：退避、抖一下、以及那颗「刷新」 ----------
{
  made.length = 0;
  const { link, sock, log } = make();
  const first = sock();
  first.raise();
  first.hear(JSON.stringify({ t: 'pong', at: 7 }));
  ok('桌来的一句话原样递到宿主手里', log.includes('msg:pong'), log.join('|'));

  first.close();
  ok('断了以后 online 就是假的', link.online === false);
  ok('断了以后按下的那一手不排队', link.send({ t: 'act', action: { kind: 'draw', stackIdx: 0 } }) === false);
  link.send({ t: 'stand' });
  const before = made.length;
  link.retry();
  ok('那颗「刷新」当场重开一条，不等下一轮退避', made.length === before + 1 && link.online === false);
  const second = sock();
  second.raise();
  ok(
    '新那条连上后补发的是让座那句，不含断线时那手牌',
    second.sent.length === 1 && JSON.parse(second.sent[0]!).t === 'stand',
    second.sent.join(),
  );
  // 旧那条排的重连要是没撤掉，这会儿会再多开一条，越连越快
  await sleep(900);
  ok('重连只有一条在跑：retry 把旧那轮的等待撤了', made.length === 2, `一共开了 ${made.length} 条`);
  link.close();
}

// ---------- 桌上安静：那是对面在想牌，不是断了 ----------
{
  made.length = 0;
  let clock = 1_700_000_000_000;
  const { link, sock, log } = make(() => clock);
  const s = sock();
  s.raise();
  const pings = () => s.sent.filter((x) => JSON.parse(x).t === 'ping').length;
  let answered = 0;
  /** 宿主那一秒一次的敲：推 n 秒假时间，桌安静就答它一句 pong */
  const tick = (n: number, answer: boolean) => {
    for (let i = 0; i < n; i++) {
      clock += 1000;
      link.beat();
      const got = pings();
      if (answer && got > answered) {
        answered = got;
        s.hear(JSON.stringify({ t: 'pong', at: clock }));
      }
    }
  };

  tick(QUIET_MS / 1000 - 1, false);
  ok('安静到第五秒：桌一个字都没发，这边也一个字都不说', pings() === 0 && made.length === 1);
  tick(2, true);
  ok('安静满六秒：先递一句 ping 问一声，而不是拆线', pings() === 1 && made.length === 1, `问了 ${pings()} 声、开了 ${made.length} 条`);
  ok('问那一声不算断线，宿主那边没报「和桌断了」', !log.some((x) => x.startsWith('status:和桌断了')), log.join('|'));
  tick(60, true);
  ok('长考一分钟：一路只问不拆，还是原来那条连接', made.length === 1 && pings() >= 3, `开了 ${made.length} 条、问了 ${pings()} 声`);
  link.close();
}

// ---------- 问了不答的那条，才是真哑了 ----------
{
  made.length = 0;
  let clock = 1_700_000_000_000;
  const { link, sock, log } = make(() => clock);
  const s = sock();
  s.raise();
  for (let i = 0; i < (QUIET_MS + PROBE_MS) / 1000 + 2; i++) {
    clock += 1000;
    link.beat();
  }
  ok('问一声还不答：拆掉这条重连', s.readyState === 3 && made.length === 1, `开了 ${made.length} 条`);
  ok('拆线那一下报了断线，人看得见', log.some((x) => x.startsWith('status:和桌断了')), log.join('|'));
  await sleep(900);
  ok('拆完真的又去敲了门', made.length === 2, `一共开了 ${made.length} 条`);
  link.close();
}

// ---------- 桌发的一句话看不懂，别把整块屏幕带崩 ----------
{
  made.length = 0;
  const { link, sock, log } = make();
  const s = sock();
  s.raise();
  s.hear('{这不是话');
  ok('看不懂的那句只报一句话，不炸', log.includes('status:桌发的话看不懂'), log.join('|'));
  s.hear(JSON.stringify({ t: 'pong', at: 1 }));
  ok('看懂的照样往下递', log.includes('msg:pong'), log.join('|'));
  link.close();
}

// ---------- 令牌这把椅子的三条口径 ----------
{
  store.clear();
  host = '192.168.1.7:5199';
  remember(2, 's2-abc');
  ok('坐过的椅子认得回来', recall()?.seat === 2 && recall()?.token === 's2-abc');
  host = '192.168.9.9:5199';
  ok('换了地址就不算：那是另一张桌', recall() === null);
  host = '192.168.1.7:5199';
  remember(2, 's2-abc');
  forget();
  ok('桌说不归我了，本地那份跟着作废', recall() === null);
  store.set('chess-dundun.seat', '一条脏数据');
  ok('存的读不成就当没存过，不堵进桌的路', recall() === null);

  broken = true;
  let threw = '';
  try {
    remember(1, 'tk');
    recall();
    forget();
  } catch (e) {
    threw = String((e as Error).message);
  }
  ok('存储一碰就炸的那台：读写都不许抛，这一局照样打', threw === '', threw);
  session.clear();
  ok('存储炸了的时候代号给空串，座位行退回「有人」', deviceNick() === '');
  broken = false;
}

// ---------- 每台设备一个代号：四位、来回一致、不用容易看错的字符 ----------
{
  session.clear();
  const n1 = deviceNick();
  const n2 = deviceNick();
  ok('代号四位数，同一页签来回一样', n1.length === 4 && n1 === n2, n1);
  ok('不用 I/O/0/1 这些看着一样的字符', !/[IO01]/.test(n1), n1);
  session.set('chess-dundun.nick', 'ZZZ');
  ok('存过的代号照用，不重掷', deviceNick() === 'ZZZ');
}

console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`);
(G.process as { exit(code: number): void }).exit(failures === 0 ? 0 : 1);
