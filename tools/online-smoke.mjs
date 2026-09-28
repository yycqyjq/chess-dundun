/**
 * 端到端冒烟：对着一个已经起好的房主进程，用两条 WebSocket 当两台设备。
 * 浏览器自动化这条路是被拦的，所以这儿只验到「传输 + 桌 + 协议」，画面还得他自己真机看。
 *
 * 起桌和收尾不在这儿，在 `tools/smoke.mjs`（那一层负责抄副本、挑空端口、把孙进程插干净）。
 *   node tools/online-smoke.mjs --port=5345
 *   node tools/online-smoke.mjs --port=5346 --no-discover   # 这桌的寻呼被关着，量的是那一句兜底回话
 */
const argv = process.argv.slice(2);
const PORT = Number((argv.find((a) => a.startsWith('--port=')) ?? '--port=5321').split('=')[1]);
const BASE = `http://127.0.0.1:${PORT}/`;
let fails = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fails++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
};

/** 一台设备：只发协议里有的那几句话，回来的按类型排成一队 */
class Client {
  constructor() {
    this.got = [];
    // 客户端只认 /ws 这一条路径（room.ts 的口径），别拿根路径去试
    this.ws = new WebSocket(`${BASE.replace('http', 'ws')}ws`);
    this.open = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('握手不成'));
    });
    this.ws.onmessage = (ev) => this.got.push(JSON.parse(String(ev.data)));
    this.ws.onclose = () => this.got.push({ t: 'closed' });
  }
  ask(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  /** 等一条没消耗掉的话；want 可以是一组类型加一个额外条件，先到哪个算哪个 */
  async until(want, extra = null, ms = 5000) {
    const hit = this.got.find((m) => !m.__used && want.includes(m.t) && (!extra || extra(m)));
    if (hit) return (hit.__used = true, hit);
    const at = Date.now();
    while (Date.now() - at < ms) {
      await new Promise((r) => setTimeout(r, 20));
      const m = this.got.find((x) => !x.__used && want.includes(x.t) && (!extra || extra(x)));
      if (m) return (m.__used = true, m);
    }
    throw new Error(`等 ${want.join('/')} 超时，收到的最后一句是 ${JSON.stringify(this.got[this.got.length - 1])?.slice(0, 160)}`);
  }
  /** 最新收到的那一份快照（不消耗） */
  view() {
    for (let i = this.got.length - 1; i >= 0; i--) if (this.got[i].t === 'state') return this.got[i];
    throw new Error('一份快照都没收到');
  }
  /** 断线：只把连接掐了，不坐回来——留出「那把椅子空着」这段时间 */
  async drop() {
    this.ws.close();
    await new Promise((r) => setTimeout(r, 300)); // 让桌收到 close、把椅子标成掉线
  }
  /** 换一条连接坐回某把椅子。历史清空，免得旧消息被当成刚回的 */
  async sit(seat, token, nick) {
    this.got.length = 0;
    this.ws = new WebSocket(`${BASE.replace('http', 'ws')}ws`);
    this.ws.onmessage = (ev) => this.got.push(JSON.parse(String(ev.data)));
    this.ws.onclose = () => this.got.push({ t: 'closed' });
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('重连握手不成'));
    });
    this.ask({ t: 'join', seat, token, nick });
    return this.until(['welcome']);
  }
  close() {
    this.ws.close();
  }
}

const home = await fetch(BASE);
const html = await home.text();
ok('首页 200，端的就是那份 index.html', home.status === 200 && html.includes('id="app"'), `状态 ${home.status}`);
/** 两个宿主的静态文件口径不一样：host 端 dist/ 的打包产物，dev 端源码模块，分开查 */
const dev = html.includes('/src/web/main.ts');
console.log(`  · 这个端口上是${dev ? ' npm run dev（Vite 直发源码）' : ' npm run host（端 dist/）'}`);
if (dev) {
  const js = await fetch(BASE + 'src/web/main.ts');
  ok('入口模块按需编译得出来', js.status === 200 && (await js.text()).includes('import'), `状态 ${js.status}`);
  const app = await fetch(BASE + 'src/web/app.ts');
  ok('牌桌那块的源码也拿得到', app.status === 200 && (await app.text()).length > 2000, `状态 ${app.status}`);
} else {
  const entry = (/src="\.?\/?(assets\/[^"]+\.js)"/.exec(html) ?? [])[1];
  const css = (/href="\.?\/?(assets\/[^"]+\.css)"/.exec(html) ?? [])[1];
  const js = await fetch(BASE + entry);
  ok('打包出来的入口 js 拿得到', js.status === 200 && (await js.text()).length > 1000, entry);
  const sheet = await fetch(BASE + css);
  ok('那份样式表也端得出来', sheet.status === 200 && (await sheet.text()).includes('.chip'), css);
  ok('没这个文件给 404', (await fetch(BASE + 'nope.wasm')).status === 404);
  ok('图标这些静态文件也端得出来', (await fetch(BASE + 'icon.svg')).status === 200 && (await fetch(BASE + 'apple-touch-icon.png')).status === 200);
  ok('往上翻 dist 外翻不动', (await fetch(BASE + 'package.json')).status === 404);
}

const a = new Client();
const b = new Client();
await Promise.all([a.open, b.open]);
ok('两条连接都握上了', true);

/** 客户端那条看门狗靠这一句分辨「桌安静」和「桌没了」：递 ping 必须回 pong */
a.ask({ t: 'ping', at: 1234 });
const pong = await a.until(['pong']);
ok('没入座也能问一声探活，桌原样把 at 带回来', pong.at === 1234, JSON.stringify(pong));

/** a 坐第 1 把：那把就是这桌的「家」房主位，房主位归他，后面改配置和按开始都是他 */
const HOST = 0;
const GUEST = 1;
/** 每台设备一个短代号，候场厅拿它分辨哪把椅子是谁坐的 */
const NICK_A = 'A7Q2';
const NICK_B = 'B3XK';

a.ask({ t: 'lobby' });
const lobby = await a.until(['seats']);
ok(
  '没入座就能问到座位表，且一张牌面都不给、开局前一直在候场',
  lobby.players === 2 &&
    lobby.gameNo === 1 &&
    lobby.mode === 'kou' &&
    lobby.level === 'hard' &&
    lobby.status === 'waiting' &&
    lobby.hostSeat === 0 &&
    lobby.seats.every((s) => !s.taken),
  JSON.stringify(lobby).slice(0, 160),
);
ok(
  '座位表还带着局域网地址：端口跟这个房一致，且短到画得出二维码',
  Array.isArray(lobby.lan) &&
    lobby.lan.length > 0 &&
    lobby.lan.every((u) => u === `http://${u.slice(7).split(':')[0]}:${PORT}/`) &&
    lobby.lan.every((u) => new TextEncoder().encode(u).length <= 78),
  JSON.stringify(lobby.lan),
);

a.ask({ t: 'join', seat: HOST, token: '', nick: NICK_A });
const w0 = await a.until(['welcome']);
ok('P1 坐下，令牌到手', w0.seat === HOST && w0.token.length > 8 && w0.status === 'waiting');
const s0 = await a.until(['state']);
ok(
  '入座那份：第 1 局、还在候场、没有要演的手、也没给合法着法',
  s0.gameNo === 1 && s0.last === null && s0.status === 'waiting' && s0.acts.length === 0 && s0.view.draft.stacks.length === 8,
);
ok('没公开的牌在快照里就是个光 id', s0.view.pieces.every((p) => Object.keys(p).join() === 'id'));
a.ask({ t: 'lobby' });
const seated = await a.until(['seats']);
ok(
  '座位表把这台设备的代号带回来了',
  seated.seats[HOST].nick === NICK_A && seated.seats[GUEST].nick === '',
  JSON.stringify(seated.seats),
);
ok('家房主位上坐着人，房主位就指着第 1 把', seated.hostSeat === HOST);

b.ask({ t: 'join', seat: HOST, token: '瞎猜的' });
ok('别人坐过的椅子抢不来', (await b.until(['reject'])).why === '这把椅子坐了人');
b.ask({ t: 'join', seat: GUEST, token: '', nick: NICK_B });
ok('P2 也坐下了', (await b.until(['welcome'])).seat === GUEST);
await b.until(['state']);
b.ask({ t: 'lobby' });
ok(
  '房主还连着，晚坐下那位抢不走房主位',
  ((await b.until(['seats'])).hostSeat) === HOST,
);

// 房主位跟着活人走：家那把椅子空了才交给代持的，人一回来就收回
await a.drop();
ok(
  '房主断线这段时间：椅子还留在他名下，只是不在线',
  b.view().seats[HOST].taken === true && b.view().seats[HOST].online === false,
  JSON.stringify(b.view().seats[HOST]),
);
const tokenB = b.got.find((m) => m.t === 'welcome').token;
b.ask({ t: 'join', seat: GUEST, token: tokenB, nick: NICK_B });
// hostSeat 只跟着座位表（lobby 那句）走，state 里没有；网页端本来就每秒问一次
await b.until(['welcome']);
ok(
  '同一条连接重新入座，不该把自己踢下线',
  !b.got.some((m) => m.t === 'closed'),
  JSON.stringify(b.got.map((m) => m.t)),
);
b.ask({ t: 'lobby' });
const held = await b.until(['seats'], (m) => m.hostSeat === GUEST);
ok('房主没连着时，重新入座的那位接过房主位', held.seats[GUEST].nick === NICK_B, JSON.stringify(held.seats));
await a.sit(HOST, w0.token, NICK_A);
a.ask({ t: 'lobby' });
const backed = await a.until(['seats'], (m) => m.hostSeat === HOST);
ok('原房主一回到第 1 把，房主位就交回他', backed.seats[GUEST].online === true, JSON.stringify(backed.seats));

a.ask({ t: 'act', action: { kind: 'draw', stackIdx: 0 } });
ok('房主没按开始之前，递上来的动作先被候场这道闸门挡下', (await a.until(['reject'])).why === '这桌还在候场，等房主按开始');
b.ask({ t: 'setup', mode: 'ming' });
ok('不是房主改不了这桌的配置', (await b.until(['reject'])).why === '只有房主能改这桌的配置');
b.ask({ t: 'start' });
ok('不是房主那位按不动开始', (await b.until(['reject'])).why === '只有房主能开局');
a.ask({ t: 'setup', level: 'easy' });
a.ask({ t: 'lobby' });
const chosen = await a.until(['seats']);
ok(
  '收回房主位那位改得动补位电脑的难度，玩法没被顺手改掉',
  chosen.level === 'easy' && chosen.mode === 'kou' && chosen.players === 2,
  JSON.stringify(chosen).slice(0, 120),
);
a.ask({ t: 'start' });
const go = await a.until(['state'], (m) => m.status === 'playing');
ok('房主一按开始，两份快照都翻成 playing', go.status === 'playing' && go.view.phase === 'draft');
ok('开局以后 P1 才拿得到合法着法', go.acts.length > 0 === (go.view.drawer === HOST));
await b.until(['state'], (m) => m.status === 'playing');

let moves = 0;
let rejects = 0;
let badPush = '';
for (let guard = 0; guard < 400; guard++) {
  if (a.view().view.phase === 'over') break;
  for (const c of [a, b]) {
    const st = c.view();
    if (st.view.phase === 'over' || st.acts.length === 0) continue;
    const act = st.acts[0];
    c.ask({ t: 'act', action: act });
    const reply = await c.until(['state', 'reject'], (m) => m.t === 'reject' || m.seq > st.seq);
    if (reply.t === 'reject') {
      rejects++;
      badPush = `${c === a ? 'P1' : 'P2'} 递的合法一手被拒：${reply.why}｜${JSON.stringify(act)}`;
      continue;
    }
    moves++;
  }
}
const end = a.view();
ok('两台设备把整局走完了', end.view.phase === 'over' && moves >= 20, `${moves} 手`);
ok('一局打完桌自己退回候场厅', end.status === 'waiting');
ok('照桌给的合法着法递，一次都没被拒', rejects === 0, badPush);
ok('收尾那份里 32 枚全收进某家牌摞', end.view.won.reduce((x, y) => x + y, 0) === 32, end.view.won.join());
ok(
  '快照的 seq 一路向上不回头，且每份都带着这一手是谁落的',
  (() => {
    const seqs = a.got.filter((m) => m.t === 'state').map((m) => m.seq);
    return seqs.every((s, i) => i === 0 || s > seqs[i - 1]) && a.got.filter((m) => m.t === 'state' && m.last).length >= 20;
  })(),
);
ok('自己的牌在快照里全带牌名', end.view.pieces.filter((p) => p.label).length >= 16);

// 候场厅里改人数：坐过的两位不用重坐，椅子多出两把
a.ask({ t: 'setup', players: 4 });
await a.until(['state'], (m) => m.view.players === 4);
a.ask({ t: 'lobby' });
const seats4 = await a.until(['seats']);
ok('改成 4 人，两位还坐在原位', seats4.players === 4 && seats4.seats.slice(0, 2).every((s) => s.taken && s.online), JSON.stringify(seats4.seats));
a.ask({ t: 'setup', players: 3 });
ok('人数不在档位上改不了', (await a.until(['reject'])).why.includes('这桌只能 2 或 4 人'));

// 还没开局也坐得进来：坐下、看看、再把椅子还回去
const c = new Client();
await c.open;
c.ask({ t: 'join', seat: 2, token: '' });
const sitEarly = await c.until(['welcome']);
ok('候场时坐进来的 welcome 说清还没开局', sitEarly.seat === 2 && sitEarly.status === 'waiting');
c.ask({ t: 'lobby' });
ok('座位表里 P3 算有人', ((await c.until(['seats'])).seats[2] ?? {}).online === true);
c.ask({ t: 'stand' });
c.ask({ t: 'lobby' });
const afterStand = await c.until(['seats']);
ok('让了座那把椅子彻底空出来', afterStand.seats[2].taken === false && afterStand.seats[2].online === false);

// 一个标签页连着点两把椅子：旧那把不许还挂着「有人」，不然屏幕上四行都是同一个人
c.ask({ t: 'join', seat: 2, token: '', nick: 'C3DE' });
await c.until(['welcome']);
c.ask({ t: 'join', seat: 3, token: '', nick: 'C3DE' });
ok('换椅子换到了第 4 把', (await c.until(['welcome'])).seat === 3);
c.ask({ t: 'lobby' });
const afterMove = await c.until(['seats']);
ok(
  '换椅子：旧那把当场空了，新那把带着代号',
  afterMove.seats[2].taken === false &&
    afterMove.seats[3].taken === true &&
    afterMove.seats[3].nick === 'C3DE',
  JSON.stringify(afterMove.seats).slice(0, 220),
);
c.ask({ t: 'stand' });
c.ask({ t: 'lobby' });
const afterSwap = await c.until(['seats']);
ok(
  '换完椅子再让座：两把都空着，旧那把没被这条连接复活',
  afterSwap.seats[2].taken === false && afterSwap.seats[3].taken === false,
  JSON.stringify(afterSwap.seats).slice(0, 220),
);

// 扫码／链接进来那一路：客户端只递 seat:-1，挑哪一把归桌定（两台手机各挑各的必撞在同一把）
{
  const d = new Client();
  await d.open;
  d.ask({ t: 'lobby' });
  const l4 = await d.until(['seats']);
  ok('座位表连「家」那把一起报出来：客户端不用猜房主位在哪把', l4.homeSeat === 0 && l4.hostSeat === 0, JSON.stringify([l4.hostSeat, l4.homeSeat]));
  d.ask({ t: 'join', seat: -1, token: '', nick: 'D9FF' });
  const auto = await d.until(['welcome']);
  ok('递 -1 进门就落座：挑中第 3 把，房主位和家那把都不自动给', auto.seat === 2 && auto.status === 'waiting', JSON.stringify(auto));
  d.ask({ t: 'join', seat: -1, token: '', nick: 'D9FF' });
  await d.until(['welcome', 'reject']);
  d.ask({ t: 'lobby' });
  const twice = await d.until(['seats']);
  ok(
    '同一条连接再递一次 -1：原来那把还归他，既不挪位也不多占一把',
    twice.seats[2].nick === 'D9FF' && twice.seats.filter((s) => s.nick === 'D9FF').length === 1,
    JSON.stringify(twice.seats).slice(0, 220),
  );

  const e = new Client();
  await e.open;
  e.ask({ t: 'join', seat: -1, token: '', nick: 'E1AA' });
  const second = await e.until(['welcome']);
  ok('第二台设备递同一个 -1：桌给的是另一把，不撞车', second.seat === 3 && second.seat !== auto.seat, JSON.stringify(second));
  const f = new Client();
  await f.open;
  f.ask({ t: 'join', seat: -1, token: '', nick: 'F2BB' });
  const none = await f.until(['reject']);
  ok('非房主位坐满了就回一句「没空椅子了」，不把人塞到房主位上', none.why.includes('没空椅子') && none.why.includes('房主位'), JSON.stringify(none));
  f.ask({ t: 'lobby' });
  const stillHost = await f.until(['seats']);
  ok('那一句拒完房主位还指着开桌那位', stillHost.hostSeat === 0 && stillHost.seats[0].nick === NICK_A, JSON.stringify([stillHost.hostSeat, stillHost.seats[0].nick]));
  // 让座再断开：把 2、3 两把彻底还回这桌，后面「中途坐下」那段还要用
  // 查这一句得站在还坐着的人那儿看——让完座的那两条连接已经没椅子了，快照根本不再往它们发；
  // 而且要「比这一句更新的那一份」：队里堆着 d／e 落座之前的旧快照，那几份同样写着两把都空着
  const beforeStand = a.view().seq;
  d.ask({ t: 'stand' });
  e.ask({ t: 'stand' });
  await a.until(
    ['state'],
    (m) => m.seq > beforeStand && m.seats[2]?.taken === false && m.seats[3]?.taken === false,
  );
  d.close();
  e.close();
  f.close();
  await new Promise((r) => setTimeout(r, 200));
}

const beforeGo = a.view().seq;
b.ask({ t: 'start' });
const notHost = await b.until(['reject']);
ok('候场厅里不是房主那位按不动开始', notHost.why === '只有房主能开局', notHost.why);

a.ask({ t: 'start' });
const g2 = await a.until(['state'], (m) => m.seq > beforeGo && m.status === 'playing');
ok(
  '改了人数后一按开始：新牌桌、4 人、局数从第 1 局重记',
  g2.gameNo === 1 && g2.view.players === 4 && g2.view.phase === 'draft' && g2.last === null,
  JSON.stringify(g2).slice(0, 120),
);
const g2b = await b.until(['state'], (m) => m.seq > beforeGo && m.status === 'playing');
ok('P2 那侧也换到了新牌桌', g2b.view.seed !== end.view.seed, `种子 ${g2b.view.seed} vs ${end.view.seed}`);
a.ask({ t: 'start' });
ok('开打了房主自己也按不动下一局', (await a.until(['reject'])).why === '这一局正在打');

// 新牌桌打到一半挤进来的人：这一局由电脑打，他一颗着法都拿不到
const beforeLate = c.view().seq;
c.ask({ t: 'join', seat: 2, token: '' });
const lateW = await c.until(['welcome']);
const lateS = await c.until(['state'], (m) => m.seq > beforeLate);
ok('中途坐下的 welcome 说清桌正在打', lateW.status === 'playing');
ok(
  '中途坐下这一局不算他的，快照也不给着法',
  lateS.status === 'playing' && lateS.acts.length === 0 && lateS.seats[2].queued === true,
  JSON.stringify(lateS.seats[2]),
);
c.ask({ t: 'act', action: { kind: 'draw', stackIdx: 0 } });
ok('这一局他递什么都拒', (await c.until(['reject'])).why === '你来得晚了，这一局先由电脑打，下一局归你');
c.ask({ t: 'setup', players: 2 });
ok('排队那位也改不了配置', (await c.until(['reject'])).why === '只有房主能改这桌的配置');
c.close();

const myTurn = a.view().acts.length > 0;
a.ask({ t: 'act', action: { kind: 'draw', stackIdx: 99 } });
const bad = await a.until(['reject']);
ok(
  '乱指一摞抽牌：桌回一句不合法',
  bad.why === (myTurn ? '这手不合法' : '这会儿不该你出'),
  `${bad.why}｜此刻是不是他动手 ${myTurn}`,
);

a.ask({ t: 'ping', at: 12345 });
ok('ping 收到 pong', (await a.until(['pong'])).at === 12345);

// P2 断线，P1 接着走一手，再凭令牌坐回来
const seqBefore = b.view().seq;
b.close();
await new Promise((r) => setTimeout(r, 400));
const token = b.got.find((m) => m.t === 'welcome').token;
const draft = a.view();
const me = draft.acts[0];
if (me) {
  a.ask({ t: 'act', action: me });
  await a.until(['state'], (m) => m.seq > draft.seq);
}
const back = new Client();
await back.open;
back.ask({ t: 'join', seat: GUEST, token });
const rw = await back.until(['welcome']);
const rs = await back.until(['state']);
ok('断线后凭令牌坐回原来那把椅子', rw.seat === GUEST && rw.token === token);
// 比的是同一份牌：桌一直在动，拿 a「此刻」那份比就变成比两个时刻了，照 seq 取那一份
await a.until(['state'], (m) => m.seq >= rs.seq);
const same = a.got.find((m) => m.t === 'state' && m.seq === rs.seq);
ok(
  '重连那份的牌面就是桌那一刻的牌面',
  !!same && same.view.won.join() === rs.view.won.join() && same.view.phase === rs.view.phase,
  `${rs.view.won.join()}/${rs.view.phase} vs ${same ? `${same.view.won.join()}/${same.view.phase}` : 'a 没收到这一份'}`,
);
ok('重连那份不带要演的手，seq 比断线前大', rs.last === null && rs.seq > seqBefore);

{
  // 一条压根没坐下的连接：act/setup/stand 这三种话不许默默咽掉。
  // 客户端按下那一下就算递出去了，等不到回音就一直挂着——桌必须当场回一句
  const x = new Client();
  await x.open;
  x.ask({ t: 'act', action: { kind: 'draw', stackIdx: 0 } });
  ok('没坐下递动作：桌当场回一句「还没坐下」', (await x.until(['reject'])).why.includes('还没坐下'));
  x.ask({ t: 'setup', players: 4 });
  ok('没坐下改配置：同样回一句', (await x.until(['reject'])).why.includes('还没坐下'));
  x.ask({ t: 'stand' });
  ok('没坐下让座：照样回一句', (await x.until(['reject'])).why.includes('还没坐下'));
  x.ask({ t: 'lobby' });
  ok('没坐下问座位表照样答得出来', (await x.until(['seats'])).players > 0);
  x.close();
}

a.close();
back.close();

// ───────────────────────── 同网寻呼：HTTP 那一句、UDP 那一句、候场厅那颗按钮 ─────────────────────────

const dgram = await import('node:dgram');
/** 朝一个 UDP 口喊一句，把这一小段里听见的都收回来 */
function shout(text, port) {
  return new Promise((res) => {
    const s = dgram.createSocket('udp4');
    const got = [];
    const done = () => {
      try {
        s.close();
      } catch {
        /* 已经关了 */
      }
      res(got);
    };
    s.on('message', (m) => got.push(m.toString('utf8')));
    s.on('error', done);
    s.bind(0, '127.0.0.1', () => {
      s.send(Buffer.from(text), port, '127.0.0.1');
      setTimeout(done, 600);
    });
  });
}

/** 同一条冒烟跑两遍：一遍寻呼开着（真发真收），一遍加了 --no-discover（那条兜底回话） */
const DISC = !argv.includes('--no-discover');
/** 跟 net/discover.ts 同一算法：寻呼口 = 底座 + (http 端口 % 8)。改了副本里那个常量，下面几条先红 */
const ANNOUNCE = 41732 + (((PORT % 8) + 8) % 8);
const WHOAMI = 'chess-dundun/whoami/v1';
console.log(`\n同网寻呼（这桌落第 ${PORT % 8} 槽，UDP ${ANNOUNCE}，${DISC ? '寻呼开着' : '开了 --no-discover'}）`);
if (DISC)
  ok(
    '这一槽躲开了他自己那两台（dev 5199→7、host 5200→0），不会串台',
    PORT % 8 !== 0 && PORT % 8 !== 7,
    `端口 ${PORT}`,
  );

const who = await fetch(BASE + 'whoami');
const whoText = await who.text();
ok('/whoami 回 200 且说的是 JSON', who.status === 200 && (who.headers.get('content-type') ?? '').includes('application/json'), `${who.status}`);
ok(
  '/whoami 报的就是这桌的端口，且只有明面那八格（牌面一个字没有）',
  (() => {
    try {
      const j = JSON.parse(whoText);
      return j.t === WHOAMI && j.port === PORT && Object.keys(j).length === 8 && !('seats' in j) && !('view' in j);
    } catch {
      return false;
    }
  })(),
  whoText.slice(0, 160),
);
ok('/whoami 挂着 no-store', who.headers.get('cache-control') === 'no-store', String(who.headers.get('cache-control')));
ok('挂了 /whoami 这条路之后，根路径照样是页面', (await fetch(BASE)).status === 200);
ok('别的地址不归它应（还是走静态那条路）', (await fetch(BASE + 'icon.svg')).status === 200);
if (!DISC) ok('寻呼关着，HTTP 那一句照旧答得出来（自己 curl 那条路不挨着 UDP）', whoText.includes(String(PORT)));

const heard = await shout(WHOAMI, ANNOUNCE);
const parsed = heard.map((t) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
});
if (DISC) {
  ok(`朝 UDP ${ANNOUNCE} 喊口令，这桌答了一句`, parsed.some((j) => j && j.port === PORT), JSON.stringify(heard).slice(0, 200));
  ok('UDP 那句答话和 /whoami 是同一份（对着终端 curl 才查得准）', heard.some((t) => t === whoText), JSON.stringify(heard).slice(0, 200));
  const junkBack = await shout('hello', ANNOUNCE);
  ok('口令对不上：一个字都不回，不拿自己的口当反射器', junkBack.length === 0, JSON.stringify(junkBack));
} else {
  ok('寻呼关着就一个字都不答（那个口上确实没人守）', heard.length === 0, JSON.stringify(heard));
}

{
  const q = new Client();
  await q.open;
  const t0 = Date.now();
  q.ask({ t: 'find' });
  const r = await q.until(['rooms'], null, 9000);
  const dt = Date.now() - t0;
  if (DISC) {
    ok(
      '没坐下也寻得动（寻桌不查椅子），回音那一段真等了',
      Array.isArray(r.rooms) && typeof r.why === 'string' && dt >= 500,
      `${dt}ms ${JSON.stringify(r).slice(0, 160)}`,
    );
    ok(
      '清单里每条都是校验过的那几项：地址现拼、线上没带 url 那种字',
      r.rooms.every((x) => Number.isInteger(x.port) && x.port >= 1024 && typeof x.ip === 'string' && !('url' in x)),
      JSON.stringify(r.rooms).slice(0, 200),
    );
    ok('自己这张桌不往自己脸上贴（本机同端口那条不列）', r.rooms.every((x) => !(x.ip === '127.0.0.1' && x.port === PORT)), JSON.stringify(r.rooms.map((x) => `${x.ip}:${x.port}`)));
    const t1 = Date.now();
    q.ask({ t: 'find' });
    const r2 = await q.until(['rooms'], null, 9000);
    ok('三秒内再按：当场端回上一轮的账，不再朝这块网打八个包', Date.now() - t1 < 400 && Array.isArray(r2.rooms), `${Date.now() - t1}ms`);
  } else {
    ok(
      '寻呼关着也照回一句人话：清单空、说清是 --no-discover，还不让人白等那 700 毫秒',
      r.rooms.length === 0 && r.why.includes('--no-discover') && r.why.includes('手动') && dt < 400,
      `${dt}ms ${JSON.stringify(r).slice(0, 200)}`,
    );
  }
  // 寻呼这一路折腾完，桌本身还得能用：寻不到桌绝不能连牌都不让人打
  q.ask({ t: 'lobby' });
  ok('寻完这一圈，座位表照问得出（寻呼只是锦上添花）', (await q.until(['seats'])).players > 0);
  q.close();
}

// ───────────────────────── 清账重开：这句在房主手上，不在别人手上 ─────────────────────────

{
  const stranger = new Client();
  await stranger.open;
  stranger.ask({ t: 'reset' });
  const noSeat = await stranger.until(['reject'], null, 3000);
  ok('还没坐下就按清账：回一句人话，不让人以为清成了', noSeat.t === 'reject' && noSeat.why.includes('坐下'), JSON.stringify(noSeat));
  stranger.close();

  // 前面那几段已经把两把椅子坐过了，这儿照旧凭令牌坐回来（空令牌会被「这把有主」挡住）
  const host = new Client();
  await host.open;
  await host.sit(HOST, w0.token, 'H2');
  const guest = new Client();
  await guest.open;
  await guest.sit(GUEST, token, 'G2');
  const playing = host.view().status === 'playing';
  guest.ask({ t: 'reset' });
  const notHost = await guest.until(['reject'], null, 3000);
  ok('坐着但不是房主：清不动，也念得清为什么', notHost.t === 'reject' && notHost.why.includes('房主'), JSON.stringify(notHost));
  // 队里已经堆了几份旧快照，所以要「比这一句更新的那一份」，不能拿旧答案交差
  const before = host.view().seq;
  host.ask({ t: 'reset' });
  const answered = playing
    ? await host.until(['reject'], null, 3000)
    : await host.until(['state'], (m) => m.seq > before, 3000);
  ok(
    '房主按清账：候场就归零、开打就挡在门口，两条路都得给一句准话',
    playing
      ? answered.t === 'reject' && answered.why.includes('正在打')
      : answered.gameNo === 1 && answered.book.games === 0,
    `${playing ? '开打中' : '候场'}｜${JSON.stringify(answered).slice(0, 150)}`,
  );
  // 清完这一句，桌还得是那张桌：座位表问得出、椅子一把没少
  host.ask({ t: 'lobby' });
  const seats = await host.until(['seats'], null, 3000);
  ok('清账之后桌照用得动（这句绝不能把房主进程带走）', seats.players > 0 && seats.seats.length === seats.players, JSON.stringify([seats.players, seats.seats.length]));
  host.close();
  guest.close();
}

await new Promise((r) => setTimeout(r, 200));
console.log(fails === 0 ? '\n全部通过' : `\n${fails} 条没过`);
process.exit(fails === 0 ? 0 : 1);
