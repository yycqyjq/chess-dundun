import { anchor, button, div, input, span } from './ui.ts';
import { rulesFor, seatName, type Rules } from '../core/game.ts';
import { buildPieceSet } from '../core/pieces.ts';
import { foundMeta, foundFree, roomName, roomUrl, statusBadge, JOIN_QUERY, type FoundRoom } from '../net/discover.ts';
import type { Lobby, SeatInfo } from '../net/wire.ts';
import type { Saved } from './net.ts';

/** 本机自己打开页面（127／localhost／[::1）的那几种写法 */
const LOOPBACK = /^127\.|^localhost$|^\[?::1/;

export type Screen = 'home' | 'room';

/** 是不是本机。这条尺子现在只管一件事：那份 origin 不能拿去给别人扫（落哪一屏改看地址上那句意图） */
export function isLoopback(host: string): boolean {
  return LOOPBACK.test(host);
}

/** 写着「不入桌」的那几种写法：其余任何值（含空值、含只写个 ?join）都算开了这个口 */
const NOT_JOIN = new Set(['0', 'false', 'no']);

/**
 * 地址栏上有没有「我是来入桌的」那一句。只认标记，不认这台机器是谁：
 * 「地址不是本机」只说明人不是在自家电脑上打开页面，不说明他是来干什么的——
 * 拿着邀请链接、扫码进来的人带的就是这个标记，直落候场厅；
 * 手输一条裸局域网地址（`http://192.168.1.11:5200/`）的人没带，就先落首页自己挑。
 */
export function wantsJoin(search: string): boolean {
  const v = new URLSearchParams(search).get('join');
  return v !== null && !NOT_JOIN.has(v.toLowerCase());
}

/** 进门先落在哪一页：开了入桌那个口的落候场厅，其余一律首页 */
export function initialScreen(search: string): Screen {
  return wantsJoin(search) ? 'room' : 'home';
}

/**
 * 邀请别人用的那串地址，第一个就是二维码的内容，每一条都带着入桌那个标记。
 * 这台设备自己够得着的 origin 最准——它不是回环就说明这条路真能走；
 * 房主在本机开页面时 origin 是 127.0.0.1，那份不能给别人扫，才退回房主进程报上来的局域网地址。
 * `here` 从外面传进来而不是直接读 location：这样这条判断脱离 DOM 也测得动（ui 那节有闸）。
 */
export function inviteUrls(lan: string[], here: { hostname: string; protocol: string; origin: string }): string[] {
  const self =
    !isLoopback(here.hostname) && (here.protocol === 'http:' || here.protocol === 'https:') ? `${here.origin}/${JOIN_QUERY}` : '';
  return [...new Set(self ? [self, ...lan] : lan)];
}

/** 版本由 Vite 的 define 注进来（只注这一个字符串，不把整份 package.json 打进 bundle） */
declare const __APP_VERSION__: string | undefined;

/** 没注上就回空串：宁可少那一行，也不给人在首页念一个 undefined */
export function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
}

const ENTRY = {
  // 入口按目的说，不按结构说：这四块都是「进门要做的一件事」的入口，同级同尺寸
  solo: { head: '单机模式', note: '电脑补位，2~4 人' },
  // note 有两份：浏览器那头能寻同网的桌、也能在自己这台开一桌；App 外壳能寻同网的桌（原生插件发广播），
  // 但开不了桌（桌是 Node 那张）——所以那一路的小字把「开一桌」换成「把地址抄进来」
  room: {
    head: '联机模式',
    note: '同一网络里选桌加入；没有就在这台机器开一桌',
    appNote: '同一网络里选桌加入；没有就把另一台电脑上那桌的地址抄进来',
  },
  // 关于／设置是 2026-10-09 从脚注小链接升格上来的第三、四块：和玩法入口同级同尺寸，不再压在页面最底
  about: { head: '关于', note: '玩法速览与版本' },
  settings: { head: '设置', note: '声音开关' },
};

/** 首页入口那一块 key：四块都从这份 ENTRY 取字，标题／点进去那一屏的名字同源 */
export type EntryKey = keyof typeof ENTRY;

/** 首页那块上第二行字：App 外壳里别念「在这台机器开一桌」，那颗按钮在那一头不存在 */
export function entryNote(k: EntryKey, app: boolean): string {
  return k === 'room' && app ? ENTRY.room.appNote : ENTRY[k].note;
}

/**
 * 这页面是不是跑在原生外壳（App）里：Capacitor 起来时往全局上注一个 Capacitor 对象。
 * 这一个判断管两件事：外壳里开不了桌（桌是 Node 那张，首页那块的小字与列表页底栏那颗按钮都得换），
 * 同网寻呼也不走本机宿主那条线——外壳里没有那个宿主，改由原生插件自己发（见 app.ts 的 findNative）。
 * 浏览器里永远是 false：没那个全局就别给人多摆一格用不上的输入框。
 */
export function inAppShell(): boolean {
  const c = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return c?.isNativePlatform?.() === true;
}

/** 那一屏要说的话：要人给什么（抄的、扫的两种说法）、给错了怎么说、相机没开成怎么说 */
export const ADDR_HINT = '桌开在另一台电脑上：那边跑 npm run host，把它打印的 http://192.168.1.11:5200/ 抄进来（端口要一起写）';
/** 「扫一扫」那颗在的时候改念这一句：说的还是同一件事，只是把给地址的两条路都点到 */
export const ADDR_SCAN = '桌开在另一台设备上：点下面「扫一扫」扫它候场厅里那张码，或者把那边打印的 http://192.168.1.11:5200/ 抄进来（端口要一起写）';
export const ADDR_BAD = '这串读不出一张桌：得写成 192.168.1.11:5200 那样，主机和端口都得有';
/** 扫回来的那串读不出一张桌：跟手敲的错法分开说，人才知道该去扫什么 */
export const SCAN_BAD = '扫到的这串读不出一张桌：得是棋墩墩候场厅里那张码';
/** 相机压根没开成（没给权限最常见）：这是「办不成」，跟「扫了但没扫到」不是一回事 */
export const SCAN_FAIL = '相机没开成：多半是没给相机权限，去系统设置里给上再试';

/**
 * 人敲进来的桌地址 → 连接用的 host:port。
 * 带 http:// 前缀、结尾带斜杠、两头有空格都收（抄终端那一行出来就是这样）；
 * **端口必须写**：桌开在哪个端口是房主那行 --port 说了算的，这一头猜不得——
 * 猜错的症状是「莫名其妙连不上」，一句写在脸上的要求比一次猜错好查。
 * 读不成回 null，由调用方换成那句提示，别拿一串指不出门的字去敲门。
 */
export function normAddr(raw: string): string | null {
  const s = raw.trim().replace(/^https?:\/\//i, '').split('/')[0]!.trim();
  if (!s || /\s/.test(s)) return null;
  const at = s.lastIndexOf(':');
  if (at <= 0) return null;
  const host = s.slice(0, at);
  const port = s.slice(at + 1);
  // 主机只认域名和 IPv4 那两种写法：方括号里的 IPv6、带空格的、带路径的都读不出一张桌
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith('-') || host.endsWith('-') || host.includes('..')) return null;
  if (!/^\d+$/.test(port)) return null;
  const p = Number(port);
  if (p < 1 || p > 65535) return null;
  return `${host}:${p}`;
}

/**
 * 每一屏左上那颗都念这一个词。三处出口（单机模式页／本地联机页／候场厅）共用一份，
 * 别在这儿写「回首页」、在那儿写「退出这桌」——同一件事在一条链路上换了三个名字，
 * 人就不知道哪一颗会把他从这桌上摘下来。
 */
export const BACK = '返回';

/**
 * 同网列表底下那行次要入口（只有外壳里摆）：同网寻不到、或者不想等那一圈广播时，
 * 手填／扫码把地址弄进来。它原来占着底栏那颗主按钮的位置——可那是「主路」的位置，
 * 而寻呼＋扫码才是主路，手填是兜底（2026-10-11 用户：手填留着，但别杵在底栏）。
 */
export const LIST_ALT = '寻不到？手填地址／扫码';

/**
 * 候场厅摊开、第一份座位表还没到手时的标题。把「连的是哪台」写在脸上：
 * 连不上时同一句只换个词（见 roomFailHead），人一眼看得出地址抄错没有。
 */
export function roomHead(addr: string): string {
  return `正连着 ${addr}……`;
}

/** 同上，可一次快照都没到手就断了——那不是「断线重连」，是压根没连上 */
export function roomFailHead(addr: string): string {
  return `连不上 ${addr}`;
}

/**
 * 同一屏上那句实话：三种成因（地址抄错／桌没开着／两台设备不在同一个网）长得一模一样，
 * 不装成「再等等就好」——原来只有一句「和桌断了，正在重连…」，人对着它无限等，没有出路。
 */
export const ROOM_FAIL = '一直在重连。地址抄错了、桌没开着、或者两台设备不在同一个网里——都长这样';

/** 连不上时底栏那两颗：改地址，或者回列表重挑一张 */
export const ALT_ADDR = '换个地址';
export const BACK_LIST = '回去重选一张';

/** 一桌里掉线的那几位，归成轻提醒要念的东西 */
export interface SeatWarn {
  name: string;
  /** 还有多久由电脑接手（毫秒）；已经被接手的给 0 */
  leftMs: number;
  /** 已经由电脑接手了 */
  ai: boolean;
}

/**
 * 掉线轻提醒那句话（钉在桌面正上方那条）。一位都没有就回空串——那一档不该露脸。
 * 还没被电脑接手的优先念：那句带着倒计时，是要人**现在**看见的；都已经接手了就只说接手。
 * 一桌同时掉几位时名字连起来念，倒计时取最近的那一位。
 * 原来只有名字条上那两个字（「掉线」／「代打」），缩在座位行里，2026-10-11 用户：都看不到。
 */
export function seatNotice(list: SeatWarn[]): string {
  if (list.length === 0) return '';
  const pending = list.filter((s) => !s.ai);
  if (pending.length > 0) {
    const ms = Math.min(...pending.map((s) => s.leftMs));
    const tail = ms <= 0 ? '马上由电脑代打' : `${Math.ceil(ms / 1000)} 秒后由电脑代打`;
    return `${warnNames(pending)} 掉线了 · ${tail}`;
  }
  return `${warnNames(list)} 掉线太久，已由电脑代打`;
}

/** 几位连成一句：`P2、P3` */
function warnNames(list: SeatWarn[]): string {
  return list.map((s) => s.name).join('、');
}

/**
 * 座位翻篇那一下飘的一句（toast）。跟正上方那条轻提醒分工不同：
 * 那条是**这会儿还这样**的常驻状态，这三句是**刚发生**的那一下，飘两秒就走。
 */
export function dropFlash(name: string): string {
  return `${name} 掉线了`;
}
export function takenFlash(name: string): string {
  return `${name} 掉线太久，电脑接手了`;
}
export function backFlash(name: string): string {
  return `${name} 回来了`;
}

/** 入口那块的字，也就是点进去之后那一屏的标题：一处改两处跟着，不会漂 */
export function entryHead(k: EntryKey): string {
  return ENTRY[k].head;
}

/**
 * 一条同网寻到的桌：整行就是热区（2026-10-09 批3：从「点那条小地址」升成「点哪儿都进桌」）。
 * 行内三排：头一排是桌名（**认桌就靠这一行**：两台设备各开一张时，光有 IP:端口分不清哪张是谁的），
 * 第二排是徽章·情况·空位，第三排是地址（悬着可整条选中拷走）。字和色档全取
 * discover 那批拆片函数，跟候场厅那句平铺文本同源。坐满了给 .dim：这会儿没人接，
 * 不该抬起来给小手骗人去点（.btn.dim 那条家族逻辑，见 style.css）。
 *
 * 两副面孔，看你在哪儿（2026-10-11 用户实测：点列表跳去了浏览器）：
 * - **浏览器里（不给 onPick）**行本体是真 `<a>`——进桌就是让浏览器自己走一趟，落在**桌自己那份页面**上，
 *   同源、那条 ws 也同源；点之前悬上去还看得见去哪儿。
 * - **App 外壳里（给了 onPick）必须是按钮**：外壳的页面住在设备自己身上（`http://localhost`），
 *   那条 `<a>` 一按就被 Capacitor 的 `Bridge.launchIntent` 拦下来甩给系统浏览器
 *   （`host` 不是 `localhost`、又不在 `server.allowNavigation` 里，就走 `Intent.ACTION_VIEW`），
 *   人根本没进到 app 里。所以那一头改成回调——把地址记下来、由壳自己开一条 ws，
 *   跟扫码／手填走同一条路。
 */
export function roomRow(f: FoundRoom, onPick?: (f: FoundRoom) => void): HTMLElement {
  const b = statusBadge(f);
  const fr = foundFree(f);
  const cls = f.free > 0 ? 'peer-row btn' : 'peer-row btn dim';
  const row = onPick ? button('', () => onPick(f), cls) : anchor('', roomUrl(f), cls);
  const line = span('peer-t');
  line.append(span(`peer-badge ${b.cls}`, b.text), span('peer-meta', `${foundMeta(f)} · 第 ${f.gameNo} 局`), span(`peer-free ${fr.cls}`, fr.text));
  row.append(span('peer-name', roomName(f)), line, span('peer-addr', `${f.ip}:${f.port}`));
  return row;
}

/** 空清单那格的挡位：一行说「这儿没东西可点」，一行说「下一步怎么办」（那句由 peerNote 现给，不另养一份） */
export function peerEmpty(why: string): HTMLElement {
  const box = div('peer-empty');
  box.append(div('pe-h', '这台网上还没寻到开着的桌'), div('pe-s', why));
  return box;
}

/** 自动入座该递哪一把椅子：-1＝「给我挑一把空椅」（哪把归桌定，见 Table.freeSeat），null＝这一步别替人做 */
export type AutoSit = number | null;

/**
 * 进门这一刻该不该替人挑椅子、挑哪一把。回 null 就是「这一步别替他做」，界面退回手挑。
 *
 * - 上次坐过哪把（令牌还在这台设备手里）先认回原来那把：断线回来不该换个位子；
 *   那把此刻还连着就说明另有个标签页坐着，这一页不替他抢第二把；
 * - 开桌那位（creating）直接坐「家」那把房主位，这就是「建房即房主」——
 *   那把已经被别人坐过就不硬挤，让他自己挑，别把人家掉线的椅子摘了；
 * - 扫码／链接进来的人递 -1，由桌挑一把空椅：两台手机扫同一个码各挑各的必撞。
 *   房主位**空着**时桌第一把给的就是它（`Table.freeSeat`，2026-10-10 起）——谁先进来谁当房主，
 *   和上面「开桌那位」落到的是同一把椅子；那把有人拿着（哪怕只是掉线挂着令牌）才往后挑。
 */
export function autoSeat(lobby: Pick<Lobby, 'homeSeat' | 'seats'>, saved: Saved | null, creating: boolean): AutoSit {
  const seats = lobby.seats;
  const mine = saved && saved.seat >= 0 && saved.seat < seats.length ? seats[saved.seat] : undefined;
  // 上次那把还连着就说明有个标签页正坐着，这一页不该再替自己抢第二把
  if (mine) return mine.online ? null : saved!.seat;
  if (creating) return seats[lobby.homeSeat]?.taken ? null : lobby.homeSeat;
  return -1;
}

/**
 * 本机桌上是不是还压着「上一桌」。三条判据，任一命中就算：
 * 打过至少一局（局号 > 1）、有人坐着（令牌留着，哪怕人早走了）、或者那一局正在打。
 * 全新的一桌是：局号还在 1、一把椅子没人坐过、也没开打——宿主刚起来、存档刚抹掉的那张就是。
 *
 * 上一桌是怎么留下来的：正常离桌会散桌（闸在 `table.ts::disband` 的 `aliveSeats` 上），
 * 可宿主进程被强杀、断电、或者早先那版「正在打就不散」漏下来的时候来不及散，存档留在了硬盘上，
 * 下次起桌 `restore()` 又原样接回来（见 `room.ts`）。点「在这台机器开一桌」的人要的是一张新桌，
 * 可那上面也许还压着别人的账——所以不替他决定，问一句（口径见 app.ts 的 askStale）。
 */
export function staleTable(lobby: Pick<Lobby, 'gameNo' | 'status' | 'seats'>): boolean {
  return lobby.gameNo > 1 || lobby.status === 'playing' || lobby.seats.some((s) => s.taken);
}

/**
 * 这一份座位表到了，该不该开口念那句交接。两条都得挡住，因为座位表是一秒一份：
 * 头一份不念（`prev` 是 -1，页面刚打开，那之前换过谁没人在看，补念等于凭空冒一句），
 * 没换也不念（房主位好好待着，那句话就会每秒钟重讲一遍、挂六秒摘掉再重讲）。
 */
export function hostJump(prev: number, next: number): boolean {
  return prev >= 0 && next !== prev;
}

/**
 * 房主位换了人，候场厅得说一句人话。桌那头本来就 log 了，但这一层不演牌桌日志——
 * 让人只看见「房主位」那三个字从一行跳到另一行，是这一版最招人误会的地方（他不知道是谁、为什么）。
 *
 * 这一句只报「现在在哪把、那把的主人连着没、上一把那把现在空不空」这三件快照里就写着的事，
 * 不猜为什么：代持那位自己让座时，位是还回「家」那把，而那把的主人多半没连着——
 * 写成「交给 阿明」就有人在等一个不会回来的人，写成「上一把还空着」就把刚让座说成一直是空的。
 */
export function hostHanded(from: number, to: number, seats: { taken: boolean; nick: string; online: boolean }[]): string {
  const who = (seat: number): string => {
    const s = seats[seat];
    return s?.nick ? `${seatName(seat)} · ${s.nick}` : seatName(seat);
  };
  const now = seats[to]?.online ? `${who(to)} 手上` : `${who(to)} 那把（那位还没连着）`;
  return seats[from]?.taken
    ? `房主位刚交给 ${now}，上一把在 ${who(from)} 手上`
    : `房主位刚交给 ${now}，上一把 ${who(from)} 那把空出来了`;
}

/** 候场厅一行座位的那份上下文：这台设备是谁、坐没坐下、房主位在哪把、存着哪把的令牌 */
export interface SeatRowCtx {
  /** 桌还没开局：空椅念「空着」，坐下那颗也按候场那一档给字 */
  waiting: boolean;
  /** 这台设备自己坐下了没 */
  seated: boolean;
  /** 这台设备坐的是哪把 */
  me: number;
  /** 此刻代持房主位的那把 */
  hostSeat: number;
  /** 这台设备存着的座位号（令牌还在手里），没存过是 null */
  savedSeat: number | null;
}

/** 一行座位要写进 DOM 的那三处字与三个开关，全是这一座这一刻的快照说了算 */
export interface SeatRowText {
  who: string;
  tag: string;
  btn: string;
  /** 自己正坐着那把：那颗按钮整个撤掉（按不动的按钮就是噪音） */
  hidden: boolean;
  disabled: boolean;
  primary: boolean;
}

/**
 * 候场厅一行座位里「谁／状态／按钮」那三处字。整段状态机从 app.ts 抽出来住在这儿，
 * 是因为 app.ts 经 `rules.json?raw` 进不了 node 测试——哪把椅子念什么、哪颗按钮按不按得动，
 * 得有闸盯着。座位号一律取 `s.seat`（座位表按椅子号排，和行号同值）。
 *
 * 三处各管一件事，分支顺序都不能换：
 * - `.who`：房主位那把多缀一句「房主位」，跑命令那位才认得该坐哪；
 * - `.t`：先看连没连（连着→「有人／你在这儿」），再看坐过没（「掉线了…凭令牌坐得回来」）、
 *   再是不是电脑补位，最后才分候场中「空着」和开打后「电脑位」；
 * - 按钮：掉线且这把还认你（自己坐过／令牌还在这台设备）才给一颗按得动的「坐回这位」，
 *   正坐着的自己那颗直接撤掉，其余按「有没有主／候场没候场」给字。
 */
export function seatRowText(s: SeatInfo, ctx: SeatRowCtx): SeatRowText {
  const seat = s.seat;
  const own = ctx.seated && ctx.me === seat;
  const back = ctx.savedSeat === seat;
  // 同一台机器开两个标签页，只写「有人」就分不清哪把归谁：谁报过代号就把代号缀上
  const nick = s.nick ? ` · ${s.nick}` : '';
  const tag = s.online
    ? own
      ? s.queued
        ? '你在这儿 · 这一局先由电脑打'
        : '你在这儿'
      : s.queued
        ? `有人${nick} · 这一局先由电脑打`
        : `有人${nick}`
    : s.taken
      ? own || back
        ? `掉线了${nick}，凭令牌坐得回来`
        : `掉线了${nick}`
      : s.ai
        ? '电脑补位'
        : ctx.waiting
          ? '空着'
          : '电脑位';
  // 桌那边线掉了、这把椅子还认得你（正坐着／令牌在手上），才给一颗按得动的「坐回这位」
  const rejoin = !s.online && (own || back);
  const btn = rejoin
    ? '坐回这位'
    : back
      ? '回到这位'
      : s.taken
        ? '这把有主'
        : ctx.waiting
          ? seat === ctx.hostSeat
            ? '坐下 · 当房主'
            : '坐下'
          : '坐下 · 等下一局';
  const disabled = s.online || (s.taken && !back);
  return {
    who: seat === ctx.hostSeat ? `${seatName(seat)} · 房主位` : seatName(seat),
    tag,
    btn,
    hidden: own && s.online,
    disabled,
    primary: !disabled,
  };
}

/**
 * 首页那块版面。整块可点、里面不再嵌小按钮——热区不许大过操作对象。
 * 两颗都用普通木色：这一层是路由不是确认，金色留给「开桌／开始这一局」。
 * 住在这个文件里而不是 app.ts，是因为 app.ts 永远进不了 node 测试（rules.json?raw），
 * 「点了往哪儿走」这件事得有闸。
 */
/**
 * 「N 人 · 每人 M 枚」那一行。M 得按**这一档自己落定**的牌组算：3 人局那一档减了两枚兵卒（30 枚），
 * 拿上一桌的牌堆去除会念成「每人 10.67 枚」这种数。
 */
export function seatOption(rules: Rules, n: number): string {
  const r = rulesFor(rules, n);
  return `${n} 人 · 每人 ${Math.floor(buildPieceSet(r.ranks).length / n)} 枚`;
}

export function homePanel(
  onSolo: () => void,
  onRoom: () => void,
  app = false,
  onAbout?: () => void,
  onSettings?: () => void,
): HTMLElement {
  const entry = (k: EntryKey, go: () => void): HTMLButtonElement => {
    const btn = button('', undefined, 'btn home-entry');
    btn.append(div('e', ENTRY[k].head), div('n', entryNote(k, app)));
    btn.addEventListener('click', go);
    return btn;
  };
  const list = div('home-entries');
  // 四块同级同尺寸：关于／设置不再是脚注里的小字链接，和两个玩法入口一样是整块热区。
  // 传了回调才摆上（跟旧那颗小链接同一脾气）——没挂回调的入口层不摆按不动的大按钮。
  list.append(entry('solo', onSolo), entry('room', onRoom));
  if (onAbout) list.append(entry('about', onAbout));
  if (onSettings) list.append(entry('settings', onSettings));
  const foot = div('home-foot');
  foot.append(div('n', '联机那台机器得和你在同一个网络'));
  const version = appVersion();
  if (version) foot.append(div('v', `v${version}`));
  const el = div('home');
  el.append(
    div('home-title', '棋墩墩'),
    div('home-brief', '7 个职级 · 黑 < 红'),
    list,
    foot,
  );
  return el;
}

/**
 * 「手填桌地址」那一屏的版面：一格地址、一句话、底栏两颗（外壳里多一颗「扫一扫」）。
 * 住在 home.ts 而不是 app.ts 的理由和首页那块一样——「读不出来就别去连」这条判断得有闸。
 * 这一屏不是外壳专属了（2026-10-10 起 App 里也先摆同网列表，寻不到才点这儿进来），
 * 只是外壳里没有本机宿主、也没有一张桌可开，能走的就是把地址弄进来这一条。
 * 填错了就地换那一行字、不弹层：这就是一串字打错了，不该把人从这一屏摘出去。
 * `cur` 是这台设备上次敲的那串（tableAddr），进来就摆在格里，重连不用再抄一遍。
 *
 * `scan` 是「扫一扫」那一趟（只有 App 外壳里给得出来，见 nativeScan.ts）：它读回一串**原文**，
 * 规范化那一步仍然走上面那把尺子——**扫码就是手填的自动版**，读得出就照读得出的走，
 * 读不出就照填错的报（只是那句说法换成 SCAN_BAD，让人知道该去扫什么）。
 * 不给这一项就不摆那颗按钮：浏览器里扫不了，那儿没有原生插件。
 */
export function fillAddr(
  body: HTMLElement,
  foot: HTMLElement,
  cur: string,
  onGo: (addr: string) => void,
  onBack: () => void,
  scan?: () => Promise<string | null>,
): void {
  const hint = scan ? ADDR_SCAN : ADDR_HINT;
  const box = input('addr', cur, '192.168.1.11:5200');
  const note = div('note', hint);
  body.append(box, note);
  const go = button(
    '连这张桌',
    () => {
      const addr = normAddr(box.value);
      note.textContent = addr ? hint : ADDR_BAD;
      if (addr) onGo(addr);
    },
    'btn primary',
  );
  if (scan) {
    foot.append(
      button(
        '扫一扫',
        () => {
          void scan()
            .then((raw) => {
              // 人取消了（回 null）什么都不动：他没做错事，不该被弹一句
              if (raw === null) return;
              const addr = normAddr(raw);
              note.textContent = addr ? hint : SCAN_BAD;
              if (addr) onGo(addr);
            })
            .catch(() => {
              // 相机没开成（没给权限最常见）：说一句，别让人对着没反应的按钮猜
              note.textContent = SCAN_FAIL;
            });
        },
        'btn',
      ),
    );
  }
  foot.append(go, button(BACK, onBack, 'btn mini'));
}

/** 候场厅／牌桌进行中那一屏的「现在该干什么」：六种处境各一句，纯函数进这儿才有闸。
 *  入参全来自快照里写着的东西（SeatInfo/Lobby），不猜为什么——猜的那句是 2026-09 立过的规矩。 */
export function lobbyGuide(input: {
  waiting: boolean;
  seated: boolean;
  isHost: boolean;
  queued: boolean;
  short: number;
  hostSeatName: string;
  hostTaken: boolean;
}): string {
  const { waiting, seated, isHost, queued, short, hostSeatName, hostTaken } = input;
  if (waiting) {
    if (!seated)
      return `挑一把椅子坐下${short > 0 ? `；还差 ${short} 个位子` : ''}。房主位 ${hostSeatName} ${hostTaken ? '已经有人' : '还空着，谁先坐下谁当房主'}`;
    if (isHost) return short > 0 ? `还差 ${short} 个位子，开局就由电脑补——或者把「邀请朋友」发给朋友` : '位子坐满了，可以开局';
    // 房主位那把还空着时不许念「等 P1 开局」：那把没人，等的是个不存在的人（2026-10-10 用户踩的）。
    // 这种局面只有「自己挑了非房主位那一把」才走得出来（扫码进来的人桌会直接把房主位给他），
    // 所以下一句是让他挪过去——点房主位那一行的按钮就直接换过去了（客户端递的是换椅子，
    // 旧那把当场还回候场厅，见 room.ts 的 join），用不着先让座再坐。
    if (!hostTaken) return `已坐下；房主位 ${hostSeatName} 还空着——点那一行的「坐下 · 当房主」，这桌就归你开局`;
    return `已坐下，等 ${hostSeatName} 开局`;
  }
  if (queued) return '这一局先让电脑打，下一局开局归你';
  if (seated) return '这一局在打；改配置得等下一局';
  return '这一局正在打。先坐下，下一局开局就归你打';
}
