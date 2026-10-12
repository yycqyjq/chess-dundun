/**
 * App 外壳里扫码那一头的测试：拿一个假的原生插件（QrScan）把 nativeScan 的脾气钉住。
 * 钉的是这几件——
 * 没有插件时回 null（浏览器里扫不了，调用方据此不摆那颗「扫一扫」）、
 * 扫回来的**原文原样递出去**（规范化归 home.ts 的 normAddr，一把尺子只养一份）、
 * 人取消（插件报 null）、插件报空串、插件压根没报 text 那一项、text 不是字符串——
 * 这几种都算「没扫到」，调用方什么都不必说；
 * 以及相机没开成（插件抛）就往上抛——那是「办不成」，跟「扫了但没扫到」不是一回事。
 * 这个文件住在 src/web：它要替 globalThis.Capacitor 造假，跟 nativeDiscover.test.ts 一个路子。
 */
import { nativeScan, nativeScanAvailable } from './nativeScan.ts';

let failures = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 测试要替 Capacitor 装的那一个全局；不带 node 的 types，一律这么绕 */
const G = globalThis as unknown as Record<string, unknown>;

/** 把 Capacitor 那个全局装上（null＝拆掉，模拟浏览器） */
function install(plugin: unknown): void {
  if (plugin === null) delete G.Capacitor;
  else G.Capacitor = { isNativePlatform: () => true, Plugins: { QrScan: plugin } };
}

console.log('\nApp 外壳：扫码由原生插件（QrScan）起相机，读回来的原文递给同一把尺子');

// ---------- 没插件的那几种情形：一律回 null，调用方就不摆那颗按钮 ----------

install(null);
ok('浏览器里没那个全局：nativeScanAvailable() 回 false', nativeScanAvailable() === false);
ok('浏览器里 nativeScan 回 null（调用方据此不摆那颗「扫一扫」）', (await nativeScan()) === null);

G.Capacitor = { isNativePlatform: () => true, Plugins: {} };
ok('Capacitor 在、可插件不在（老包）：还是回 false', nativeScanAvailable() === false);
ok('插件不在时回 null，不抛', (await nativeScan()) === null);

G.Capacitor = { isNativePlatform: () => true, Plugins: { QrScan: {} } };
ok('半拉子插件（有那一项、可没有 scan）也算没这本事', nativeScanAvailable() === false);

// ---------- 插件在：原文原样递出去 ----------

install({ scan: async () => ({ text: 'http://192.168.1.11:5200/?join=1' }) });
ok('装上插件了：nativeScanAvailable() 回 true', nativeScanAvailable() === true);
ok(
  '扫回来的原文原样递出去（规范化是 normAddr 的事，这一层一个字不动）',
  (await nativeScan()) === 'http://192.168.1.11:5200/?join=1',
);

// ---------- 「没扫到」的四种写法：都回 null，都别弹话 ----------

install({ scan: async () => ({ text: null }) });
ok('人按了返回（插件把 text 报成 null）：回 null', (await nativeScan()) === null);

install({ scan: async () => ({ text: '' }) });
ok('插件报了个空串：也当没扫到', (await nativeScan()) === null);

install({ scan: async () => ({}) });
ok('插件回的话里压根没有 text 那一项：也当没扫到', (await nativeScan()) === null);

install({ scan: async () => ({ text: 42 }) });
ok('text 不是字符串（插件写歪了）：不硬塞给调用方', (await nativeScan()) === null);

// ---------- 相机没开成：往上抛，由调用方兜成一句实话 ----------

install({
  scan: async () => {
    throw new Error('没给相机权限');
  },
});
let threw = '';
try {
  await nativeScan();
} catch (e) {
  threw = String((e as Error).message);
}
ok('相机没开成（抛了）就往上抛，别悄悄回 null 混成「没扫到」', threw === '没给相机权限', threw);

// ---------- 同一时刻只准一趟在飞：连点两下「扫一扫」不该起两个相机页 ----------

// 原生那头 `@ActivityCallback` 只认一条在飞的 call，真撞上时后到的那趟拿不回 call、没法回话，
// 对应的 `await` 就永远等下去（见 QrScanPlugin.scanned 那一格）。这一层挡住最干净：
// 第二趟当场回 null（调用方当「没扫到」），第一趟照常落定。
install({
  scan: () =>
    new Promise((res) => {
      setTimeout(() => res({ text: 'http://192.168.1.11:5200/?join=9' }), 10);
    }),
});
const firstScan = nativeScan();
const secondScan = nativeScan();
ok('同一时刻第二趟当场回 null（不另起一个相机页、也不抢第一趟的回话）', (await secondScan) === null);
ok('第一趟照常落定，读到原文', (await firstScan) === 'http://192.168.1.11:5200/?join=9');
ok('前一趟落定后闸就放开：下一趟照常能扫', (await nativeScan()) === 'http://192.168.1.11:5200/?join=9');

delete G.Capacitor;

console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`);
(G.process as { exit(code: number): void }).exit(failures === 0 ? 0 : 1);
