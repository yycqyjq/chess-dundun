import { button, div } from './ui.ts';

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
  solo: { head: '自己玩', note: '2~4 个位子，没坐上人的由电脑补' },
  room: { head: '同一张网', note: '一台当房主开桌，别人拿地址或扫码进来' },
};

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
