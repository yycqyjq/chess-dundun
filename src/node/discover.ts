import { createSocket, type Socket } from 'node:dgram';
import {
  ANNOUNCE_PORT,
  listFound,
  parseOffer,
  roomKey,
  roomUrl,
  slotOf,
  sweepDue,
  sweepPorts,
  targetsFor,
  WHOAMI,
  SWEEP_MS,
  type FoundRoom,
  type RoomCache,
} from '../net/discover.ts';

/**
 * 同网寻呼那一头真正碰网络的部分：一个 UDP 口，既答话也问人。
 * 判断全在 src/net/discover.ts（那儿有闸），这儿只搬运字节——
 * 即便如此它也留了假 socket 的口子（第二个参数），所以「答不答这一句、这句归不归进账」同样测得到。
 */

/** 寻一圈的结果：清单 ＋ 一句人话（为什么空、为什么还是上一轮的账） */
export interface Found {
  rooms: FoundRoom[];
  why: string;
}

/** 只用得上 dgram 的那几下手脚：测试递一份假的进来，这一页也就跟着有闸了 */
export interface Sock {
  on(ev: 'message', cb: (msg: Buffer, rinfo: { address: string; port: number }) => void): void;
  on(ev: 'error', cb: (e: Error) => void): void;
  bind(port: number, address: string, cb?: () => void): void;
  /** 广播那一档：Node 的 dgram 默认**关着**，不开着往广播地址发就是 EACCES */
  setBroadcast(flag: boolean): void;
  send(msg: Buffer, port: number, address: string, cb?: (err?: Error | null) => void): void;
  close(): void;
}

export interface DiscOpts {
  /** 这桌的 http 端口：算自己守哪一槽，也用来认「这条答话是我自己绕回来的」 */
  httpPort: number;
  /** 自己守的那一槽（0..7）；不填就按 http 端口落。一台机器上两张桌才需要说 */
  slot?: number;
  /** 本机网卡：ip ＋ 掩码，定向广播往这些网段发 */
  nets: { ip: string; mask: string }[];
  /** 答什么：由宿主算——HTTP 那一路 /whoami 答的是同一句，两边对得上才好查 */
  answer: () => string;
  log: (line: string) => void;
}

export interface Discovery {
  /** 实际守着的那一 UDP 口：横幅念它，占不上的时候也说它 */
  readonly port: number;
  /** 寻一圈、等回音，把清单端回来（自己那张桌不在里面） */
  find(): Promise<Found>;
  close(): void;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** 这张桌该守的寻呼口：一槽一口，八口一轮问遍 */
export function announcePortOfSlot(slot: number): number {
  return ANNOUNCE_PORT + (((slot % 8) + 8) % 8);
}

export function openDiscovery(o: DiscOpts, sock?: Sock, wait: (ms: number) => Promise<void> = waitMs): Discovery {
  const cache: RoomCache = new Map();
  const mine = { ips: o.nets.map((n) => n.ip), port: o.httpPort };
  const port = announcePortOfSlot(o.slot ?? slotOf(o.httpPort));
  let lastAt = -Infinity;
  let why = '';
  /** 广播发不出去那句真原因（EACCES 之类）：空清单时拿它顶掉那句「多半是 AP 隔离」 */
  let blocked = '';
  let socket: Sock | null = null;
  let shut = false;

  /** 一句进来的字节：是口令就答一句，是答话就归进账里，其余不吭 */
  function read(msg: Buffer, from: { address: string; port: number }): void {
    if (shut || !socket) return;
    const text = msg.toString('utf8');
    if (text === WHOAMI) {
      socket.send(Buffer.from(o.answer()), from.port, from.address);
      return;
    }
    const f = parseOffer(text, from.address);
    if (typeof f === 'string') return; // 不是答话的字节满大街都是，不记也不吭
    const key = roomKey(f);
    if (!cache.has(key)) o.log(`寻到一张桌：${roomUrl(f)}`);
    cache.set(key, { found: f, at: Date.now() });
  }

  function ask(): void {
    const msg = Buffer.from(WHOAMI);
    for (const target of targetsFor(o.nets)) {
      for (const p of sweepPorts()) {
        try {
          socket?.send(msg, p, target, (err) => {
            if (err && !blocked) blocked = err.message;
          });
        } catch (e) {
          // 这块网卡发不出去（没连上、或者系统不让）：剩下的口子照问，别为一块网卡把整轮废掉
          if (!blocked) blocked = (e as Error).message;
        }
      }
    }
  }

  /**
   * 空清单那句说明：有真原因（广播发不出去）就念真原因。
   * 底下那句兜底是「多半是这块网不让设备之间互访」（`net/discover.ts` 的 `peerNote`），
   * 自己发不出去却让人去查路由器，是拿假原因把人往沟里带。
   */
  function explain(rooms: FoundRoom[], reason: string): string {
    if (rooms.length || reason || !blocked) return reason;
    return `广播发不出去（${blocked}）：这块网卡发不了广播。照上面那条局域网地址手动敲，一样进得来`;
  }

  function attach(s: Sock): void {
    socket = s;
    s.on('message', (msg, from) => read(msg, from));
    s.on('error', (e: Error) => {
      // 这一槽被同机另一张桌占了（5200 和 5208 落同一槽），或者系统压根不让占：
      // 这张桌不寻也不答，牌照照样打——寻呼只是省一次敲地址，不是进桌的路
      why = `这台机器上 ${port} 那个寻呼口占不住（${String(e.message)}）：给其中一张桌加 --discover-slot=1 到 7 换个槽`;
      o.log(why);
      socket = null;
    });
    // 绑上了才开广播：没 bind 就调 setBroadcast 是 EBADF（2026-09-29 量的）。
    // 而 dgram 默认**不开**广播——不开的话 ask() 往 255.255.255.255 和定向广播发的那 16 个包当场 EACCES，
    // 只剩回环那一路发得出去；回环绕回来的正是它自己，`isMine` 一抹，同网桌列表就永远是一张空清单。
    s.bind(port, '0.0.0.0', () => s.setBroadcast(true));
  }

  attach(sock ?? (createSocket({ type: 'udp4', reuseAddr: true }) as Socket));

  return {
    port,
    /**
     * 寻一圈要等回音，所以是异步的；等这一段里谁再按都不另开一轮（3 秒那道闸）。
     * 不按这颗就一个字都不发：一开候场厅就自己寻，等于每台设备一进桌都朝这块网打八个包。
     */
    find() {
      const now = Date.now();
      if (!socket) {
        const rooms = listFound(cache, now, mine);
        return Promise.resolve({ rooms, why: explain(rooms, why) });
      }
      if (!sweepDue(lastAt, now)) {
        const rooms = listFound(cache, now, mine);
        return Promise.resolve({ rooms, why: explain(rooms, why || '刚寻过一轮，这是上一轮听见的') });
      }
      lastAt = now;
      ask();
      return wait(SWEEP_MS).then(() => {
        const rooms = listFound(cache, Date.now(), mine);
        return { rooms, why: explain(rooms, why) };
      });
    },
    close() {
      shut = true;
      const s = socket;
      socket = null;
      try {
        s?.close();
      } catch {
        // 已经关了
      }
    },
  };
}
