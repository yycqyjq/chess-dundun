import { LEVELS, type Level } from '../ai/agent.ts';
import type { Lobby, TableStatus } from './wire.ts';

/**
 * 同网找桌：这台机器上寻一圈「谁在开桌」，把寻到的桌列出来，点一条就把浏览器递到那张桌的候场厅。
 *
 * 为什么走 UDP 广播、不走 HTTP 挨个试：
 * 别的设备的 IP 我们压根不知道，HTTP 那一路得先有一张候选清单才能开口，而清单只能来自广播——
 * 于是广播就是唯一的起点。浏览器自己发不了 UDP，所以这一趟由本机那个宿主代跑（客户端只在 WebSocket 上说一句 find）。
 *
 * 为什么这套判断全在这儿、不在 room.ts / app.ts：
 * 这两个文件一个要真 socket、一个进不了 node 测试（app.ts 那条 rules.json?raw），
 * 搬出来才有闸——发出去的口令、认不下一份野回答、算出的地址、几次寻一圈，全在这文件里说死了。
 */

/** 寻呼口令：只有原样对上这一串才回答。答话里带的就是公开得出来的那几项，牌面一个字没有 */
export const WHOAMI = 'chess-dundun/whoami/v1';
/**
 * 寻呼口只有一扇：一台机器上一张桌。
 * 一张机器开两张桌（他这儿真有过：dev 5199 加 host 5200）就按 http 端口分槽，
 * 槽只有 8 个，寻的一侧把 8 口全问一遍——反正一次寻呼也就八个包。
 */
export const ANNOUNCE_PORT = 41732;
export const SLOTS = 8;
/** 一次寻呼等回音：局域网里一个广播往返用不了一秒，等久了只是让人对着转圈 */
export const SWEEP_MS = 700;
/** 上一轮才过多久就不必再寻：全桌一人一颗按钮，一起按会把这块网刷爆 */
export const SWEEP_MIN_MS = 3_000;
/**
 * 列表页自己寻一轮的间隔。比上面那道闸宽，是因为这一页不挨人按了——
 * 一进联机就站着、五秒一轮自己问；好几台设备同时站在这页上时，宿主那道 3 秒闸才是真拦人的那道。
 */
export const LIST_REFRESH_MS = 5_000;
/** 这么久没再听见这张桌说话就当它收了杆：寻呼不重复，账本自己得会老 */
export const OFFER_TTL = 15_000;
/** 端口太小的不谈：22、25 那一头是别的服务，一张桌不会开在那儿 */
const MIN_PORT = 1024;

/** 一张桌报出来的自己：全是候场厅本来就公开的那几项 */
export interface RoomOffer {
  port: number;
  players: number;
  gameNo: number;
  mode: 'ming' | 'kou';
  level: Level;
  status: TableStatus;
  /** 还空着几把椅子：坐下的人和「有主但掉了线」的椅子都算占了 */
  free: number;
}

/**
 * 寻到的桌：比原话多一个「从哪儿听来的」。
 * 地址不给存成字符串——线上回来的那串字谁都可能写成 javascript:，
 * 只留 ip 和 port 两个校验过的数，要显示、要跳转一律现拼（roomUrl）。
 */
export interface FoundRoom extends RoomOffer {
  ip: string;
}

/**
 * 入桌那一句意图，写在地址上：拿着这条地址进的人才是「来入桌的」，页面直接落进候场厅。
 * 手输的裸地址（`http://192.168.1.11:5200/`）没带它，就先落首页让人自己挑——
 * 「地址不是本机」只说明他不是在自己电脑上打开页面，不说明他是来干什么的。
 */
export const JOIN_QUERY = '?join=1';

/**
 * 递给人敲进浏览器的那条地址：拼法只有这一份。
 * 列表里那一条、房主进程报的邀请地址、二维码的内容，全从这儿出——
 * 一处少带那个标记，那条路上的人就白被问一遍「要不要联机」。
 */
export function httpUrl(ip: string, port: number): string {
  return `http://${ip}:${port}/${JOIN_QUERY}`;
}

/** 由校验过的 ip ＋ port 现拼一条能敲进浏览器的地址：列表里点一条本来就是去入桌，标记跟着走 */
export function roomUrl(f: { ip: string; port: number }): string {
  return httpUrl(f.ip, f.port);
}

export const MODES = ['ming', 'kou'] as const;
export const STATUSES: readonly TableStatus[] = ['waiting', 'playing'];

/** 桌那份座位表 → 一句自我介绍。谁坐着、谁掉线了都从这儿归成一个数 */
export function offerOf(lobby: Lobby, httpPort: number): RoomOffer {
  const held = lobby.seats.filter((s) => s.online || s.taken).length;
  return {
    port: httpPort,
    players: lobby.players,
    gameNo: lobby.gameNo,
    mode: lobby.mode,
    level: lobby.level,
    status: lobby.status,
    free: Math.max(0, lobby.players - held),
  };
}

export function encodeOffer(offer: RoomOffer): string {
  return JSON.stringify({ t: WHOAMI, ...offer });
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** 点分四段转成一个数；写法不对就回 null，不猜 */
function quad(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function unquad(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** 是不是自家这块网里的地址：10/8、172.16/12、192.168/16，还有 169.254 那一片 */
function isPrivate(ip: string): boolean {
  const n = quad(ip);
  if (n === null) return false;
  const a = (n >>> 24) & 255;
  const b = (n >>> 16) & 255;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 169;
}

/**
 * 这块网段的广播地址：ip 和掩码取反再或一下。
 * 掩码得是连片的（255.255.255.0 那种），零散掩码（有些网口报出来的怪东西）不认——
 * 认了就算出一个谁也不收的地址，白发一个包还算不清是谁的错。
 * /31 和 /32 也没有广播地址可发：那样算出来的是别机器自己的单播地址，往那儿发是敲门敲错了家。
 * 比 /8 还宽的掩码不是局域网在用的那一路（自家三块私网最宽就是 10/8），一律不认。
 */
export function broadcastOf(ip: string, mask: string): string | null {
  const a = quad(ip);
  const m = quad(mask);
  if (a === null || m === null) return null;
  if (!isPrivate(ip)) return null;
  const inv = (~m) >>> 0;
  // 取反之后必须是「低若干位全 1」
  if (inv !== 0 && (inv + 1) & inv) return null;
  const hostBits = inv === 0 ? 0 : Math.round(Math.log2(inv + 1));
  if (hostBits < 2 || hostBits > 24) return null;
  return unquad((a | inv) >>> 0);
}

/**
 * 一次寻呼往哪些地址发：本机每张网卡的定向广播 ＋ 全网广播 ＋ 回环。
 * 定向广播是正经那一路——255.255.255.255 有些路由器根本不转；
 * 回环留给「一台机器两张桌」，那种时候只有它俩还听得见彼此。
 */
export function targetsFor(nets: { ip: string; mask: string }[]): string[] {
  const hits = new Set<string>(['127.0.0.1', '255.255.255.255']);
  for (const net of nets) {
    const b = broadcastOf(net.ip, net.mask);
    if (b) hits.add(b);
  }
  return [...hits];
}

/** http 端口落在哪一槽：槽只有 8 个，一台机器上两张桌的端口天然差一两位 */
export function slotOf(httpPort: number): number {
  return ((httpPort % SLOTS) + SLOTS) % SLOTS;
}

/** 这张桌该守的寻呼口 */
export function announcePortOf(httpPort: number): number {
  return ANNOUNCE_PORT + slotOf(httpPort);
}

/** 寻的一侧要问遍的那几口：一次八个包，全在常量里，绝不听线上的话 */
export function sweepPorts(): number[] {
  return Array.from({ length: SLOTS }, (_, slot) => ANNOUNCE_PORT + slot);
}

/**
 * 一句回答认不认：只认得出来的那几个字段，取值一律在清单里。
 * 回一句话就是拒——野回答不进清单，也不许它把地址拼出来。
 */
export function parseOffer(text: string, ip: string): FoundRoom | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return '听不懂的一句';
  }
  if (!isObj(raw) || raw.t !== WHOAMI) return '不是棋墩墩的答话';
  if (!isPrivate(ip)) return '这话不是自家这块网里来的';
  if (!isInt(raw.port) || raw.port < MIN_PORT || raw.port > 65535) return '那桌报的端口不像话';
  if (!isInt(raw.players) || raw.players < 1 || raw.players > 8) return '座位数不像话';
  if (!isInt(raw.gameNo) || raw.gameNo < 1) return '第几局不像话';
  if (typeof raw.mode !== 'string' || !MODES.includes(raw.mode as (typeof MODES)[number])) return '没听过这种玩法';
  if (typeof raw.level !== 'string' || !LEVELS.includes(raw.level as Level)) return '没听过这档电脑';
  if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status as TableStatus)) return '没听过这个状态';
  if (!isInt(raw.free) || raw.free < 0 || raw.free > raw.players) return '空位比座位还多';
  return {
    ip,
    port: raw.port,
    players: raw.players,
    gameNo: raw.gameNo,
    mode: raw.mode as 'ming' | 'kou',
    level: raw.level as Level,
    status: raw.status as TableStatus,
    free: raw.free,
  };
}

/** 一张桌的键：同一张桌报几回只留最新那回 */
export function roomKey(f: FoundRoom): string {
  return `${f.ip}:${f.port}`;
}

/** 这台桌的自我介绍 ＋ 最后一次听见它是什么时候 */
export interface Seen {
  found: FoundRoom;
  at: number;
}

/** 寻呼这本账：每桌一本，收在宿主那边（浏览器只管要清单，不自己攒） */
export type RoomCache = Map<string, Seen>;

/** 寻到的桌归进这本账：新的写上、旧的只刷时间。就地改这本 Map，调用方一张桌一本 */
export function absorb(cache: RoomCache, found: FoundRoom[], now: number): void {
  for (const f of found) cache.set(roomKey(f), { found: f, at: now });
}

/** 太久没再听见的抹掉：别攒一屏早收了杆的桌 */
export function prune(cache: RoomCache, now: number, ttl = OFFER_TTL): void {
  for (const [key, seen] of cache) if (now - seen.at > ttl) cache.delete(key);
}

/**
 * 摆给人看的那份清单：正在打的沉底，空位多的在前，再按地址排个稳当次序。
 * 自己那张桌不列——候场厅顶上就写着它的地址，列表里再给自己递一条「去别的桌」是多余。
 */
export function listFound(cache: RoomCache, now: number, mine: { ips: string[]; port: number }, ttl = OFFER_TTL): FoundRoom[] {
  prune(cache, now, ttl);
  return [...cache.values()]
    .map((s) => s.found)
    .filter((f) => !isMine(f, mine.ips, mine.port))
    .sort((a, b) => {
      const wait = (x: FoundRoom) => (x.status === 'waiting' ? 0 : 1);
      return wait(a) - wait(b) || b.free - a.free || roomUrl(a).localeCompare(roomUrl(b), 'en', { numeric: true });
    });
}

/**
 * 是不是我们自己在应答：广播绕回本机时，来源 IP 就是自己那张网卡的地址。
 * 光看端口不算——两台笔记本各开一张桌，端口一模一样，那是正儿八经的另一桌。
 */
export function isMine(f: FoundRoom, myIps: string[], myPort: number): boolean {
  return f.port === myPort && (myIps.includes(f.ip) || f.ip === '127.0.0.1');
}

/** 这一轮该不该寻：上一轮才刚过就把八个包再发一遍，是拿全桌的按钮刷这块网 */
export function sweepDue(lastAt: number, now: number, min = SWEEP_MIN_MS): boolean {
  return now - lastAt >= min;
}

/** 寻呼被 --no-discover 关着时宿主回的那一句：说清为什么寻不到，再说下一步去哪儿 */
export const NO_DISCOVER = '这台机器的寻呼关着（开了 --no-discover）：只能照上面那条局域网地址手动敲';

/** 候场厅里那一行字。地址不进这句——它单独摆在按钮边上，点之前看得见去哪儿 */
export function foundLine(f: FoundRoom): string {
  const game = f.status === 'waiting' ? `等开局 · 第 ${f.gameNo} 局` : `正在打 · 第 ${f.gameNo} 局`;
  return `${f.players} 人 · ${f.mode === 'ming' ? '明棋' : '扣棋'} · ${game} · ${f.free > 0 ? `还空 ${f.free} 把` : '坐满了'}`;
}

/**
 * 寻完那一句说明。空清单光写「没有」没用，得说下一步怎么办：
 * 宿主给了原因（寻呼关着、口占不住、刚寻过一轮）就念它的，
 * 没原因又是空的，就是设备之间互访被拦那一路（访客网络、开了 AP 隔离的路由器）。
 */
export function peerNote(rooms: FoundRoom[], why: string): string {
  if (rooms.length) return `同网寻到 ${rooms.length} 张桌：点一条就把浏览器递过去。自己这张桌的椅子还留着，回来照上面那条地址敲就是`;
  return why || '一台都没寻到：多半是这块网不让设备之间互访（访客网络、开了 AP 隔离的路由器常这样）。照上面那条局域网地址手动敲，一样进得来';
}