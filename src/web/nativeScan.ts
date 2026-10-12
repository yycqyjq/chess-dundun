/**
 * App 外壳里的扫码：把原生插件（QrScan）读到的那串字递给调用方。
 *
 * 这件事只有 App 外壳里有：浏览器里没有那个插件，也没有一条能扫的路——
 * 手机浏览器的 WebView 里没有 `BarcodeDetector`（那是 Chrome 的东西），塞一个 JS 解码器进去
 * 既慢又破了这一头「零依赖」的调子；而相机本来就得走原生。
 * 所以 `nativeScanAvailable()` 回 false 时，调用方（home.ts 的 fillAddr）就别摆那颗「扫一扫」。
 *
 * 插件只管「把镜头里的东西读成一串字」（android 侧 QrScanPlugin ＋ QrScanActivity），
 * 那串字是不是一张桌、能不能连，全归 home.ts 的 `normAddr`——跟手敲地址同一把尺子量。
 * 所以这一层一个字都不判断，只把**原文**递出去。
 */

/** 原生插件那一面：Capacitor 建好 Bridge 之后把它挂到 globalThis.Capacitor.Plugins 上 */
interface QrScanBridge {
  scan(): Promise<{ text?: unknown }>;
}

/** 拿到插件那一面；浏览器里（没那个全局）回 null，不抛 */
function bridge(): QrScanBridge | null {
  const c = (globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
  const p = c?.Plugins?.QrScan as QrScanBridge | undefined;
  return p && typeof p.scan === 'function' ? p : null;
}

/** 这一头有没有「自己扫码」的本事（只有 App 外壳里才有） */
export function nativeScanAvailable(): boolean {
  return bridge() !== null;
}

/**
 * 正有一趟在飞。相机那一屏是整屏的原生 Activity，同一时刻只该有一趟：
 * 双击那颗「扫一扫」、或者返回键和按钮一起按，都会走到这儿。
 * 原来没有这道闸，两趟一起递下去（两个 Activity、两条 promise），
 * 而原生那一头 `@ActivityCallback` 只认一条在飞的 call——真撞上时后到的那一趟拿不回 call，
 * 那一格**没法回话**（见 QrScanPlugin.scanned），对应的 `await` 就永远等下去。
 * 在这儿挡住，比在原生那头补救干净：这一层本来就知道「一趟在飞」这件事。
 */
let flying = false;

/**
 * 扫一次：回扫到的那串**原文**，不规范化——那是 `normAddr` 的事，一把尺子只养一份。
 *
 * 回 null 有三种来处，调用方都当「这一趟没扫到」、什么都不必说：
 * 人按了返回（插件把 `text` 报成 null）、这一头压根没这本事（没插件）、
 * 以及**已经有一趟在飞**（上面那道闸，别叠第二趟）。
 *
 * 相机没开成（权限没给）会往上抛，由调用方兜成一句实话——那是要人去设置里点一下的事，
 * 跟「扫了但没扫到」不是一回事，别混成一件。
 */
export async function nativeScan(): Promise<string | null> {
  const p = bridge();
  if (!p) return null;
  if (flying) return null;
  flying = true;
  try {
    const res = await p.scan();
    const text = res?.text;
    return typeof text === 'string' && text !== '' ? text : null;
  } finally {
    flying = false;
  }
}
