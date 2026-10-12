/**
 * App 外壳里的同网寻呼：把原生插件（LanSweep）搬回来的字节，喂给 discover.ts 那一套认话。
 *
 * 电脑那一头这件事是宿主代跑的：网页递一句 find 出去，Node 那边朝八槽发口令、把回包递回来。
 * App 外壳里没有那个宿主，所以换成手机自己发。插件只管搬字节——口令长什么样、往哪八槽发、
 * 广播地址怎么算、回包怎么认、清单怎么摆，全在这儿跟电脑那一头共用同一份 discover.ts，不另养一套口径。
 *
 * 浏览器里没有那个插件：nativeSweepAvailable() 回 false，调用方照旧走宿主那条路。
 */
import {
  WHOAMI,
  absorb,
  listFound,
  parseOffer,
  sweepPorts,
  targetsFor,
  type FoundRoom,
  type RoomCache,
} from '../net/discover.ts';

/** 原生插件那一面：Capacitor 建好 Bridge 之后把它挂到 globalThis.Capacitor.Plugins 上 */
interface LanSweepBridge {
  networks(): Promise<{ nets?: { ip: string; mask: string }[] }>;
  sweep(o: {
    targets: string[];
    ports: number[];
    text: string;
    waitMs: number;
  }): Promise<{ replies?: { text: string; ip: string }[] }>;
}

/**
 * 「自己那张桌」在这一头不存在：App 外壳里没有本机宿主，一张桌都开不出来。
 * 端口填 0——真桌落不到 0（`parseOffer` 那道 MIN_PORT 是 1024），`isMine` 于是永不成立，一条都不用抹。
 * 将来 App 真能开桌了，这儿要换成手机那张网卡的 ip ＋ 它占的端口，否则自己那张桌会列给自己看。
 */
const NO_MINE: { ips: string[]; port: number } = { ips: [], port: 0 };

/** 拿到插件那一面；浏览器里（没那个全局）回 null，不抛 */
function bridge(): LanSweepBridge | null {
  const c = (globalThis as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
  const p = c?.Plugins?.LanSweep as LanSweepBridge | undefined;
  return p && typeof p.sweep === 'function' && typeof p.networks === 'function' ? p : null;
}

/** 这一头有没有「自己发广播」的本事（只有 App 外壳里才有） */
export function nativeSweepAvailable(): boolean {
  return bridge() !== null;
}

/**
 * 寻一圈：拿网卡 → 算广播目标 → 发口令 → 收 waitMs 毫秒 → 认话 → 摆成清单。
 * 认话、归并、滤空桌、排序全走 `net/discover.ts` 那一套（`parseOffer` ＋ `absorb` ＋ `listFound`），
 * 跟电脑那一头同一份口径。
 *
 * **为什么必须归并**（2026-10-10 用户实测）：一次寻呼，同一张桌**会回两个包**——
 * 口令往 `255.255.255.255` 和定向广播各发一趟，两条路都到得了它，它两条都答。
 * 只把回包一条条往数组里塞的话，一张桌就占两行、桌名还一模一样；两张桌看着就是四张。
 * 归并的键是 `roomKey`（`ip:port`），两个回包的来源地址相同，合成一条。
 *
 * 这本账只活在这一次寻呼里，不跨轮：跟宿主那头不一样——宿主的 find 有 3 秒闸、客户端 5 秒一问，
 * 中间的空档得靠上一轮的账填上；这一头每叫一次就是真发一趟广播，用不着上一轮的记忆。
 *
 * 没插件回 null——调用方据此退回宿主那条路。「这一圈确实没寻到」和「这一头压根没这本事」
 * 是两件事，别混成一件：前者要摆空状态那一格，后者要换一条路。
 */
export async function nativeSweep(waitMs: number): Promise<FoundRoom[] | null> {
  const p = bridge();
  if (!p) return null;
  const { nets } = await p.networks();
  const { replies } = await p.sweep({
    targets: targetsFor(nets ?? []),
    ports: sweepPorts(),
    text: WHOAMI,
    waitMs,
  });
  const now = Date.now();
  const heard: FoundRoom[] = [];
  for (const r of replies ?? []) {
    const one = parseOffer(r.text, r.ip);
    if (typeof one !== 'string') heard.push(one);
  }
  const book: RoomCache = new Map();
  absorb(book, heard, now);
  return listFound(book, now, NO_MINE);
}
