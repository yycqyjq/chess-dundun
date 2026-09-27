import type { ToClient, ToHost } from '../net/wire.ts';

/**
 * 联机这一头的连接：断线自动重连、座位凭令牌认回原来那把椅子。
 * 地址一律同源——页面和 WebSocket 挂在同一个端口上，局域网里只能走 http，
 * https 页面连 ws://192.168.x.x 会被浏览器当混合内容掐掉。
 * 两个宿主都守这条：npm run host 端 dist/，npm run dev 那张桌直接挂在 Vite 的服务器上。
 */

/** 重连间隔：头几次快一点，路由器抖一下不该让人干等半分钟 */
const WAIT = [400, 900, 1800, 3200, 5000] as const;

/** 连着却这么久没听桌说过话：先递一句 ping 问一声。牌桌安静是常态——对面想牌六秒太正常了 */
export const QUIET_MS = 6_000;
/** 问一声还不答，再等这么久才认定这条线哑了：拆掉重连 */
export const PROBE_MS = 6_000;

/** 令牌就躺在这台设备的 localStorage 里：换浏览器、清缓存就得重新挑一把空椅子 */
const KEY = 'chess-dundun.seat';

export interface Saved {
  seat: number;
  token: string;
}

/** 桌说的话原样递出去，回来的一律交给 onMsg；状态变化只管一句话，空串是「连着」 */
export interface NetHandlers {
  onMsg(m: ToClient): void;
  /** 断了就报一句话，连上给空串 */
  onStatus(text: string): void;
  /** 每次握手成功都来一趟：还站在大厅就在这儿重问座位表，已经坐下就在这儿凭令牌坐回那把椅子 */
  onReady(): void;
}

function read(): (Saved & { host: string }) | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as (Saved & { host: string }) | null;
    return raw && raw.host === location.host && typeof raw.seat === 'number' && typeof raw.token === 'string' ? raw : null;
  } catch {
    // 存的东西读不成，就当没存过——不能因为一条脏数据把进桌堵死
    return null;
  }
}

/** 这台设备上次坐的是哪个位子。地址换了就不算：那是另一张桌 */
export function recall(): Saved | null {
  const hit = read();
  return hit ? { seat: hit.seat, token: hit.token } : null;
}

export function remember(seat: number, token: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ host: location.host, seat, token }));
  } catch {
    // 隐私模式写不进去：这一局照样打，只是刷新或断线后得重挑椅子
  }
}

/** 桌说了这把椅子不归你（断线那会儿被人坐了、这桌减了人）：本地那份令牌跟着作废，别再拿它去撞 */
export function forget(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 写不进去的机器多半也没存过
  }
}

/**
 * 这个页面的短代号，候场厅拿它在座位行上认人。
 * 存 sessionStorage 而不是 localStorage：同一台机器开两个标签页模拟两台设备时，
 * 共用一个代号就等于没标；重开一个新标签页拿到新代号才对得上「另一台设备」。
 */
const NICK_KEY = 'chess-dundun.nick';
const NICK_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function deviceNick(): string {
  try {
    const old = sessionStorage.getItem(NICK_KEY);
    if (old) return old;
    let code = '';
    for (let i = 0; i < 4; i++) code += NICK_ABC[Math.floor(Math.random() * NICK_ABC.length)];
    sessionStorage.setItem(NICK_KEY, code);
    return code;
  } catch {
    // 隐私模式写不进去：没代号，座位行退回「有人」那句，不耽误进桌
    return '';
  }
}

export class Link {
  private ws: WebSocket | null = null;
  private timer: number | null = null;
  private tries = 0;
  private shut = false;
  /**
   * 断线期间攒下的「桌边话」（入座、开局、改配置）——握手一成就补发。
   * 出牌一律不进这个队列：那一手是拿旧牌面算出来的，补回去只会出错子，
   * 与其让桌默默拒掉，不如当场告诉用户「没递上去」，让他照最新牌面重按。
   */
  private outbox: string[] = [];
  /** 最后一次听见桌说话是什么时候：任何一句都算，包括看不懂的 */
  private seen: number;
  /** 探活那句是什么时候递出去的，0 = 这会儿没在等回音 */
  private probeAt = 0;
  /** 不带参数属性：这个文件要能被 node --experimental-strip-types 直读着测（src/web/net.test.ts） */
  private readonly h: NetHandlers;
  /** 看门狗用的钟：测试给假钟，就能一秒一秒把「桌上安静了多久」推过去看它什么反应 */
  private readonly now: () => number;

  constructor(h: NetHandlers, now: () => number = Date.now) {
    this.h = h;
    this.now = now;
    this.seen = now();
    this.open();
  }

  get online(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * 宿主一秒敲一次这一句。安静**不等于**断线：桌上没人动牌，桌就一个字都不发，
   * 原来这里直接重连，等于对面每想六秒牌我们就自己拆一次线（候场厅不犯，因为那儿一秒问一次座位表）。
   * 所以现在先问一声 ping，问而不答才动手——那条真哑了的线（手机切走被路由器收了）照样抓得住。
   */
  beat(): void {
    const now = this.now();
    if (this.shut || !this.online) return;
    if (now - this.seen < QUIET_MS) {
      this.probeAt = 0; // 桌又开口了，这一轮探活不必再等回音
      return;
    }
    if (!this.probeAt) {
      this.probeAt = now;
      this.send({ t: 'ping', at: now });
      return;
    }
    if (now - this.probeAt < PROBE_MS) return;
    this.probeAt = 0;
    this.retry();
  }

  /** 座位表要人主动问：坐下之前那几秒，谁进谁出都靠这一句来回刷 */
  askLobby(): void {
    if (this.online) this.send({ t: 'lobby' });
  }

  /** 递出去了 true；没连着又是不该补发的那几类话就 false，由调用方去跟用户交代 */
  send(msg: ToHost): boolean {
    const text = JSON.stringify(msg);
    if (this.online) {
      this.ws!.send(text);
      return true;
    }
    if (msg.t === 'act') return false;
    this.outbox.push(text);
    return false;
  }

  /** 手动重来一遍：别让用户对着一条已经死了的连接等下一轮退避 */
  retry(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.tries = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    else this.open();
  }

  close(): void {
    this.shut = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.outbox.length = 0;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private open(): void {
    // 路径固定 /ws：两个宿主都只认这一条（host.ts 和 vite.config.ts 里那个插件共用 room.ts 的口径）
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      this.seen = this.now();
      this.probeAt = 0;
      this.h.onStatus('');
      // 先让宿主把椅子认回来，再补发攒下的话：桌是按连接认人的，
      // 椅子还没绑上就先递话，那句会被默默丢掉，攒着的东西也就永远等不回音讯
      this.h.onReady();
      if (this.online) for (const text of this.outbox.splice(0)) ws.send(text);
    };
    ws.onmessage = (ev) => {
      this.seen = this.now(); // 听见动静就算活着，看不懂的下一句再判
      let msg: ToClient;
      try {
        msg = JSON.parse(String(ev.data)) as ToClient;
      } catch {
        this.h.onStatus('桌发的话看不懂');
        return;
      }
      this.h.onMsg(msg);
    };
    // 只在这儿排重连：出错跟着就是关闭，两头各排一次会越连越快
    ws.onclose = () => {
      if (this.shut) return;
      this.ws = null;
      this.h.onStatus('和桌断了，正在重连…');
      const base = WAIT[Math.min(this.tries, WAIT.length - 1)]!;
      this.tries++;
      // 抖一下：好几台设备同时断在同一个路由器上，别约好了一起回头敲门
      const wait = base + Math.floor(Math.random() * 250);
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.open();
      }, wait);
    };
    ws.onerror = () => ws.close();
  }
}
