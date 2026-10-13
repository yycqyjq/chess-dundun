/**
 * App 外壳里同网寻呼那一头的测试：拿一个假的原生插件（LanSweep）把 nativeDiscover 的脾气钉住。
 * 钉的是这几件——
 * 没有插件时回 null（好让调用方退回宿主那条路，别把「这一头没这本事」当成「寻了一圈没有」）、
 * 插件在时递出去的口令／槽位／广播目标跟电脑那一头共用同一份 discover.ts、
 * 回包一律走 parseOffer 认话（野话、不是自家这块网来的，一条都不进清单）、
 * 每条桌的 ip 用的是回包的来处（答话里压根不写地址）、
 * 同一张桌回两个包只算一条（归并：2026-10-10 用户实测的「一张桌占两行」就是漏了这一步）、
 * 摆法也跟电脑那一头同源（空桌不列、等开局的在前、空位多的在前）、
 * 以及插件自己抛就往上抛（由 app.ts 那一头兜成一句实话，不当成「寻了一圈没有」）。
 * 这个文件住在 src/web：它要替 globalThis.Capacitor 造假，跟 net.test.ts 同一份 tsconfig（带着 DOM）。
 */
import { SWEEP_MS, WHOAMI, encodeOffer, sweepPorts, targetsFor, type RoomOffer } from '../net/discover.ts';
import { nativeSweep, nativeSweepAvailable } from './nativeDiscover.ts';

let failures = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failures++;
  // 失败第一件事是知道挂在哪：栈帧 0 是 ok 自己，帧 1 才是调用处 —— 取「文件名：行：列」缀在名字后
  const at = new Error().stack?.split('\n')[2]?.trim().split(/[\\/]/).pop() ?? '';
  // 定位缀在整行末尾：名字和 detail 的前缀保持原样，别把按名字找钉子的刀谱匹配弄瞎
  console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}${at ? `（${at}）` : ''}`);
}

/** 测试要替 Capacitor 装的那一个全局；不带 node 的 types，一律这么绕 */
const G = globalThis as unknown as Record<string, unknown>;

/** 一张桌报出来的自己（全是候场厅公开的那几项），拿 encodeOffer 拼成一句答话 */
function offer(over: Partial<RoomOffer> = {}): RoomOffer {
  return {
    port: 5200,
    name: '客厅的桌',
    players: 3,
    gameNo: 2,
    mode: 'kou',
    level: 'easy',
    status: 'waiting',
    free: 1,
    ...over,
  };
}

type SweepArg = { targets: string[]; ports: number[]; text: string; waitMs: number };

/** 假的 LanSweep 插件：记下被问了什么，回一份编排好的答话 */
function fakePlugin(o: { nets?: { ip: string; mask: string }[]; replies?: { text: string; ip: string }[]; throwOn?: 'networks' | 'sweep' } = {}) {
  const calls: SweepArg[] = [];
  return {
    calls,
    networks: async () => {
      if (o.throwOn === 'networks') throw new Error('没网卡');
      return { nets: o.nets };
    },
    sweep: async (a: SweepArg) => {
      calls.push(a);
      if (o.throwOn === 'sweep') throw new Error('口占不住');
      return { replies: o.replies };
    },
  };
}

/** 把 Capacitor 那个全局装上（null＝拆掉，模拟浏览器） */
function install(plugin: unknown): void {
  if (plugin === null) delete G.Capacitor;
  else G.Capacitor = { isNativePlatform: () => true, Plugins: { LanSweep: plugin } };
}

console.log('\nApp 外壳：同网寻呼由原生插件（LanSweep）自己发，认话那套跟电脑端同源');

// ---------- 没插件的那几种情形：一律回 null，交给宿主那条路 ----------

install(null);
ok('浏览器里没那个全局：nativeSweepAvailable() 回 false', nativeSweepAvailable() === false);
ok('浏览器里 nativeSweep 回 null（调用方据此退回宿主那条路）', (await nativeSweep(SWEEP_MS)) === null);

G.Capacitor = { isNativePlatform: () => true, Plugins: {} };
ok('Capacitor 在、可插件不在（老包）：还是回 false', nativeSweepAvailable() === false);
ok('插件不在时回 null，不抛', (await nativeSweep(SWEEP_MS)) === null);

G.Capacitor = { isNativePlatform: () => true, Plugins: { LanSweep: { networks: async () => ({}) } } };
ok('半拉子插件（有 networks 没 sweep）也算没这本事', nativeSweepAvailable() === false);

// ---------- 插件在：递出去的那几样跟电脑端同源 ----------

const nets = [{ ip: '192.168.1.7', mask: '255.255.255.0' }];
const p = fakePlugin({
  nets,
  replies: [
    { text: encodeOffer(offer({ name: '客厅的桌' })), ip: '192.168.1.41' },
    { text: encodeOffer(offer({ name: '书房的桌', port: 5208, free: 0 })), ip: '192.168.1.42' },
    { text: '{}', ip: '192.168.1.43' }, // 不是棋墩墩的答话
    { text: '不是 JSON', ip: '192.168.1.44' }, // 听不懂的一句
    { text: encodeOffer(offer()), ip: '8.8.8.8' }, // 不是自家这块网里来的
  ],
});
install(p);
ok('装上插件了：nativeSweepAvailable() 回 true', nativeSweepAvailable() === true);
const found = await nativeSweep(1234);
ok(
  '寻回来的就是认得下的那两张桌（野话、别处的答话一条都不进清单）',
  found?.length === 2 && found[0]!.name === '客厅的桌' && found[1]!.name === '书房的桌',
  JSON.stringify(found),
);
ok(
  '每条桌的 ip 用的是回包的来处（答话里压根不写地址）',
  found?.[0]!.ip === '192.168.1.41' && found?.[1]!.ip === '192.168.1.42',
  `${found?.[0]!.ip}｜${found?.[1]!.ip}`,
);
ok('寻呼口令就是 WHOAMI（跟电脑那一头同一份）', p.calls[0]!.text === WHOAMI, p.calls[0]!.text);
ok(
  '问的是那八个槽口（sweepPorts 现给，不听线上的话）',
  p.calls[0]!.ports.join() === sweepPorts().join(),
  p.calls[0]!.ports.join(),
);
ok(
  '广播目标由网卡现算（定向广播＋全网＋回环）',
  p.calls[0]!.targets.join() === targetsFor(nets).join(),
  p.calls[0]!.targets.join(),
);
ok('收包窗口照传进来的那个数（不自己另定一个）', p.calls[0]!.waitMs === 1234, String(p.calls[0]!.waitMs));

// ---------- 归并 / 滤空桌 / 摆法：跟电脑那一头同一份口径 ----------

/**
 * 同一张桌回两个包。为什么必然回两个：口令往 `255.255.255.255` 和定向广播各发一趟，
 * 两条路都到得了它，它两条都答；两个回包的来源地址一样，`roomKey`（ip:port）也就一样。
 * 不归并的话一张桌占两行——2026-10-10 用户实测：5180 和 5200 两张桌，列表里各占两行、桌名一模一样。
 */
const twice = fakePlugin({
  nets,
  replies: [
    { text: encodeOffer(offer({ name: '客厅的桌', port: 5200 })), ip: '192.168.1.41' },
    { text: encodeOffer(offer({ name: '客厅的桌', port: 5200 })), ip: '192.168.1.41' },
  ],
});
install(twice);
const merged = await nativeSweep(SWEEP_MS);
ok(
  '同一张桌回两个包只算一条（不归并就是一张桌占两行）',
  merged?.length === 1 && merged[0]!.name === '客厅的桌',
  JSON.stringify(merged),
);

/**
 * 一把椅子都没人坐过的桌（`free === players`）不列：那还不是「一张开着的桌」，是一张**还没开的桌**。
 * 电脑那一头一直是这么办的，这一头原来漏了——于是同一块网，电脑上一条都不列、App 上却列着。
 */
const blank = fakePlugin({
  nets,
  replies: [
    { text: encodeOffer(offer({ name: '还没开', players: 2, free: 2 })), ip: '192.168.1.41' },
    { text: encodeOffer(offer({ name: '开着的', players: 3, free: 1 })), ip: '192.168.1.42' },
  ],
});
install(blank);
const onlyOpen = await nativeSweep(SWEEP_MS);
ok(
  '一把椅子都没人坐过的桌不列（跟电脑那一头同源）',
  onlyOpen?.length === 1 && onlyOpen[0]!.name === '开着的',
  JSON.stringify(onlyOpen),
);

// 摆法：正在打的沉底、空位多的在前、再按地址排——都归 listFound，这一头只管把料递过去
const ordering = fakePlugin({
  nets,
  replies: [
    { text: encodeOffer(offer({ name: '打的', port: 5200, status: 'playing', free: 1 })), ip: '192.168.1.41' },
    { text: encodeOffer(offer({ name: '空得少', port: 5202, status: 'waiting', free: 1 })), ip: '192.168.1.42' },
    { text: encodeOffer(offer({ name: '空得多', port: 5203, status: 'waiting', players: 4, free: 2 })), ip: '192.168.1.43' },
  ],
});
install(ordering);
const sorted = await nativeSweep(SWEEP_MS);
ok(
  '摆法跟电脑那一头同源：等开局的在前、空位多的在前、正在打的沉底',
  sorted?.map((f) => f.name).join() === '空得多,空得少,打的',
  JSON.stringify(sorted?.map((f) => f.name)),
);

// 网卡报不出来：不该抛，广播目标退化成「回环＋全网」那一份（跟电脑端 targetsFor([]) 同源）
const p2 = fakePlugin({ replies: [] });
install(p2);
const none = await nativeSweep(SWEEP_MS);
ok(
  '网卡报不出来（nets 缺省）也不抛：目标退化成回环＋全网',
  none !== null && none.length === 0 && p2.calls[0]!.targets.join() === targetsFor([]).join(),
  `${none?.length}｜${p2.calls[0]!.targets.join()}`,
);

// ---------- 插件自己抛：往上抛，由调用方兜成一句实话 ----------

install(fakePlugin({ throwOn: 'sweep' }));
let threw = '';
try {
  await nativeSweep(SWEEP_MS);
} catch (e) {
  threw = String((e as Error).message);
}
ok('插件发不出去（抛了）就往上抛，别悄悄回一份空清单', threw === '口占不住', threw);

install(fakePlugin({ throwOn: 'networks' }));
threw = '';
try {
  await nativeSweep(SWEEP_MS);
} catch (e) {
  threw = String((e as Error).message);
}
ok('拿网卡那一步抛也往上抛（同一套兜法）', threw === '没网卡', threw);

delete G.Capacitor;

console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`);
(G.process as { exit(code: number): void }).exit(failures === 0 ? 0 : 1);
