import type { ToClient, ToHost } from '../net/wire.ts';

/**
 * 联机这一头的连接：断线自动重连、座位凭令牌认回原来那把椅子。
 * 地址一律同源——房主进程把页面和 WebSocket 挂在同一个端口上，
 * 局域网里只能走 http，https 页面连 ws://192.168.x.x 会被浏览器当混合内容掐掉。
 */

/** 重连间隔：头几次快一点，路由器抖一下不该让人干等半分钟 */
const WAIT = [400, 900, 1800, 3200, 5000] as const;

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

export class Link {
  private ws: WebSocket | null = null;
  private timer: number | null = null;
  private tries = 0;
  private shut = false;
  /** 没连上的时候按下的那几手先攒着，握手一成就补发；桌会验它合不合法 */
  private outbox: string[] = [];

  constructor(private readonly h: NetHandlers) {
    this.open();
  }

  get online(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** 座位表要人主动问：坐下之前那几秒，谁进谁出都靠这一句来回刷 */
  askLobby(): void {
    if (this.online) this.send({ t: 'lobby' });
  }

  send(msg: ToHost): void {
    const text = JSON.stringify(msg);
    if (this.online) this.ws!.send(text);
    else this.outbox.push(text);
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
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`);
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      this.h.onStatus('');
      for (const text of this.outbox.splice(0)) ws.send(text);
      this.h.onReady();
    };
    ws.onmessage = (ev) => {
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
      const wait = WAIT[Math.min(this.tries, WAIT.length - 1)]!;
      this.tries++;
      this.timer = window.setTimeout(() => this.open(), wait);
    };
    ws.onerror = () => ws.close();
  }
}
