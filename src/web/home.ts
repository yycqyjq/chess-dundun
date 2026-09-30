import { anchor, button, div } from './ui.ts';
import { seatName } from '../core/game.ts';
import { foundLine, roomUrl, type FoundRoom } from '../net/discover.ts';
import type { Lobby } from '../net/wire.ts';
import type { Saved } from './net.ts';

/** 本机自己打开页面（127／localhost／[::1）才停在首页 */
const LOOPBACK = /^127\.|^localhost$|^\[?::1/;

export type Screen = 'home' | 'room';

/** 本机自己打开页面（127／localhost／[::1）——邀请地址也不能拿这条给别人扫，同一把尺子量两处 */
export function isLoopback(host: string): boolean {
  return LOOPBACK.test(host);
}

/**
 * 进门先落在哪一页。地址不是本机就说明人是拿着链接进来的，直接落进候场厅——
 * 他是来入桌的，别再问他一遍「要不要联机」。
 */
export function initialScreen(host: string): Screen {
  return isLoopback(host) ? 'home' : 'room';
}

/** 版本由 Vite 的 define 注进来（只注这一个字符串，不把整份 package.json 打进 bundle） */
declare const __APP_VERSION__: string | undefined;

/** 没注上就回空串：宁可少那一行，也不给人在首页念一个 undefined */
export function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
}

const ENTRY = {
  solo: { head: '单机模式', note: '2~4 个位子，没坐上人的由电脑补' },
  room: { head: '本地联机', note: '先看同网有没有桌在等人；没有就在这台机器开一桌' },
};

/**
 * 每一屏左上那颗都念这一个词。三处出口（单机模式页／本地联机页／候场厅）共用一份，
 * 别在这儿写「回首页」、在那儿写「退出这桌」——同一件事在一条链路上换了三个名字，
 * 人就不知道哪一颗会把他从这桌上摘下来。
 */
export const BACK = '返回';

/** 入口那块的字，也就是点进去之后那一屏的标题：一处改两处跟着，不会漂 */
export function entryHead(k: 'solo' | 'room'): string {
  return ENTRY[k].head;
}

/**
 * 一条同网寻到的桌：一句情况加一条真能点的地址。只有列表页画它（候场厅里不摆别的桌）。
 * 地址一律由 roomUrl 现拼（线上回来的字只留校验过的 ip＋port），也不往 HTML 里写。
 */
export function roomRow(f: FoundRoom): HTMLElement {
  const url = roomUrl(f);
  const row = div('peer-row');
  row.append(div('peer-t', foundLine(f)), anchor(url, url, 'btn mini peer-link'));
  return row;
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
 * - 扫码／链接进来的人递 -1，由桌挑一把空椅：两台手机扫同一个码各挑各的必撞，
 *   而房主位（代持的、家的那把）桌上一律不自动给，那种时候退回人自己按「坐下 · 当房主」。
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

/**
 * 首页那块版面。整块可点、里面不再嵌小按钮——热区不许大过操作对象。
 * 两颗都用普通木色：这一层是路由不是确认，金色留给「开桌／开始这一局」。
 * 住在这个文件里而不是 app.ts，是因为 app.ts 永远进不了 node 测试（rules.json?raw），
 * 「点了往哪儿走」这件事得有闸。
 */
export function homePanel(onSolo: () => void, onRoom: () => void): HTMLElement {
  const entry = (k: 'solo' | 'room', go: () => void): HTMLButtonElement => {
    const btn = button('', undefined, 'btn home-entry');
    btn.append(div('e', ENTRY[k].head), div('n', ENTRY[k].note));
    btn.addEventListener('click', go);
    return btn;
  };
  const list = div('home-entries');
  list.append(entry('solo', onSolo), entry('room', onRoom));
  const foot = div('home-foot');
  foot.append(div('n', '联机那台机器得和你在同一个网络'));
  const version = appVersion();
  if (version) foot.append(div('v', `v${version}`));
  const el = div('home');
  el.append(
    div('home-title', '棋墩墩'),
    div('home-brief', '32 枚 · 7 个职级 · 黑 < 红'),
    list,
    foot,
  );
  return el;
}
