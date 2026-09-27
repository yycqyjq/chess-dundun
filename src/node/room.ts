import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Level } from '../ai/agent.ts';
import { loadRules } from './load_rules.ts';
import { Table, type TableSetup } from '../net/table.ts';
import type { ToClient, ToHost } from '../net/wire.ts';
import { WsServer, type Conn } from '../net/ws.ts';

/**
 * 一张牌桌 + 一套 WebSocket 协议，不含任何「怎么把页面端出去」的事。
 * 两个宿主共用它：npm run host（自己开 http 服务器端 dist/）和 npm run dev
 * （挂进 Vite 的开发服务器，一条命令就能联机），所以这里不 createServer。
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
/** 运行时存档：牌桌快照，Ctrl-C 后下次接得回。仓库根，已被 .gitignore 盖住 */
export const SAVE = normalize(join(ROOT, '..', '..', 'table.json'));
/** 客户端连的就是这一条路径；两个宿主都只认它 */
export const WS_PATH = '/ws';

/** 取值口径：--名=值 和 --名 值 两种写法都认 */
export function flag(argv: string[], name: string, fallback: string): string {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
}

export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** 这些网卡上的地址出不了这块网：VPN、网桥、虚拟机、容器，别的设备照着敲只会撞墙 */
const NIC_SKIP = /^(utun|awdl|bridge|vti|gif|stun|anpd|vmnet|veth|br-|docker|lxc|tun|tap|ipsec|spid)/;

/** 内置网口打分：wlan* 和 en0 最像「这台机器连路由器的那张」，二维码就该画它 */
function nicScore(name: string): number {
  const m = /^(en|eth|wlan)(\d+)$/.exec(name);
  if (!m) return 9;
  const n = Number(m[2]);
  if (m[1] === 'wlan') return 0;
  return m[1] === 'en' && n === 0 ? 0 : n === 1 ? 1 : 2;
}

/** 同一台路由器上怎么找到这台房：把非回环的 IPv4 列出来，最可能是那张真网卡的排最前 */
export function lanAddresses(): string[] {
  const hits: { name: string; addr: string }[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (NIC_SKIP.test(name)) continue;
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      // 169.254 是没配上 DHCP 时自己编的地址，出不了这块网卡
      if (net.address.startsWith('169.254.')) continue;
      hits.push({ name, addr: net.address });
    }
  }
  hits.sort((a, b) => nicScore(a.name) - nicScore(b.name) || a.name.localeCompare(b.name, 'en', { numeric: true }));
  return hits.map((h) => h.addr);
}

export interface Room {
  table: Table;
  setup: TableSetup;
  /** 存档落在哪儿：横幅要把它念出来，好让人知道 Ctrl-C 之后接得回什么 */
  savePath: string;
  /** 只吃 /ws 那条升级；收回 true 表示这条 socket 归它了，别的一条字节都不碰（Vite 的 HMR 也挂在同一个 httpServer 上） */
  handleUpgrade(req: IncomingMessage, stream: Duplex, head: Buffer): boolean;
  /** 能递给别的设备直接敲进浏览器的那串地址；终端横幅和候场厅里那个二维码都从这儿拿 */
  inviteUrls(): string[];
  persist(): void;
  close(): void;
}

export function openRoom(argv: string[], port: number): Room {
  const setup: TableSetup = {
    rules: loadRules(),
    players: Number(flag(argv, 'players', '2')),
    mode: flag(argv, 'mode', 'kou') === 'ming' ? 'ming' : 'kou',
    level: flag(argv, 'level', 'hard') as Level,
    seed: Number(flag(argv, 'seed', String((Math.random() * 0xffffffff) | 0))),
    hostSeat: Number(flag(argv, 'host-seat', '0')),
  };
  const savePath = flag(argv, 'save', SAVE);
  /** 谁连着坐哪个位子：一条连接进来先没位子，join 成功才绑上 */
  const seatOf = new Map<Conn, number>();
  const connOf = new Map<number, Conn>();

  const send = (seat: number, msg: ToClient): void => {
    connOf.get(seat)?.send(JSON.stringify(msg));
  };
  const tell = (line: string): void => {
    console.log(`  ${line}`);
  };
  /** 这条连接还没绑上椅子：四种话都回这一句，别把「没座位」咽成沉默 */
  const NO_SEAT = JSON.stringify({
    t: 'reject',
    why: '这条连接还没坐下：先在候场厅挑一把椅子',
  } satisfies ToClient);

  function restore(): Table | null {
    if (hasFlag(argv, 'fresh') || !existsSync(savePath)) return null;
    try {
      const table = Table.load(readFileSync(savePath, 'utf8'), send, tell);
      console.log(`接回了上一桌（第 ${table.gameNo} 局）；要重开就加 --fresh`);
      return table;
    } catch (e) {
      console.log(`上一桌的存档读坏了（${String((e as Error).message)}），重开一桌`);
      return null;
    }
  }

  const table = restore() ?? new Table(setup, send, tell);

  /** 真往硬盘上写的那一下 */
  function write(): void {
    writeFileSync(savePath, table.save());
  }
  let due: ReturnType<typeof setTimeout> | null = null;
  /**
   * 落盘合批：一手牌要写三四回（每人一份快照、每位连接一次进出），
   * 而这份存档只用来在 Ctrl-C 之后接桌——差半秒不碍事，攒一起写就别让硬盘一直响。
   */
  function persist(): void {
    if (due) return;
    due = setTimeout(() => {
      due = null;
      write();
    }, 300);
  }
  // 一开桌就落一次盘：还没人坐过椅子就断掉，重启也接得回这一桌的牌面
  write();

  const ws = new WsServer({
    onMessage(conn, text) {
      let msg: ToHost;
      try {
        msg = JSON.parse(text) as ToHost;
      } catch {
        conn.close('说的话看不懂');
        return;
      }
      const seat = seatOf.get(conn);
      switch (msg.t) {
        case 'lobby':
          conn.send(
            JSON.stringify({ t: 'seats', ...table.lobby(), lan: inviteUrls() } satisfies ToClient),
          );
          return;
        case 'join': {
          // 先把椅子认给这条连接再落座：桌在 join 里就要广播一份快照，晚一步那份就发飞了
          const prev = connOf.get(msg.seat);
          const from = seatOf.get(conn);
          seatOf.set(conn, msg.seat);
          connOf.set(msg.seat, conn);
          const r = table.join(msg.seat, msg.token, msg.nick, from);
          if (!r.ok || !r.msg) {
            // 换椅子没换成：原来那把还得是他的，别一句「坐不下」把人连原有的椅子一起摘了
            if (from !== undefined) seatOf.set(conn, from);
            else seatOf.delete(conn);
            if (prev) connOf.set(msg.seat, prev);
            else connOf.delete(msg.seat);
            conn.send(JSON.stringify({ t: 'reject', why: r.why ?? '坐不下' } satisfies ToClient));
            return;
          }
          // 换椅子：旧那把的连接认得回来了，不再替那把椅子说话
          if (from !== undefined && from !== msg.seat && connOf.get(from) === conn)
            connOf.delete(from);
          // 同一个位子只许一个人连着：令牌对得上，就把旧那条连接踢掉
          // 同一条连接重新入座（改个代号、认回椅子）不算换人，别把自己踢下线
          if (prev && prev !== conn) prev.close('这把椅子换了人');
          conn.send(JSON.stringify(r.msg satisfies ToClient));
          persist();
          return;
        }
        case 'act': {
          // 没坐下就递话一定要回一句：客户端那边按下这一手就当递出去了，牌面不动它不会自己醒
          if (seat === undefined) {
            conn.send(NO_SEAT);
            return;
          }
          const r = table.act(seat, msg.action);
          if (!r.ok)
            conn.send(JSON.stringify({ t: 'reject', why: r.why ?? '这手不合法' } satisfies ToClient));
          persist();
          return;
        }
        case 'start': {
          if (seat === undefined) {
            conn.send(NO_SEAT);
            return;
          }
          const r = table.start(seat);
          if (!r.ok)
            conn.send(JSON.stringify({ t: 'reject', why: r.why ?? '开不了局' } satisfies ToClient));
          persist();
          return;
        }
        case 'setup': {
          if (seat === undefined) {
            conn.send(NO_SEAT);
            return;
          }
          const r = table.changeSetup(seat, { players: msg.players, mode: msg.mode, level: msg.level });
          if (!r.ok)
            conn.send(JSON.stringify({ t: 'reject', why: r.why ?? '这会儿改不了' } satisfies ToClient));
          persist();
          return;
        }
        case 'stand': {
          if (seat === undefined) {
            conn.send(NO_SEAT);
            return;
          }
          const r = table.stand(seat);
          if (!r.ok) {
            conn.send(JSON.stringify({ t: 'reject', why: r.why ?? '让不了座' } satisfies ToClient));
            return;
          }
          // 椅子还回候场厅了，这条连接也就不再代表哪位；想再坐得重新挑一把
          seatOf.delete(conn);
          if (connOf.get(seat) === conn) connOf.delete(seat);
          persist();
          return;
        }
        case 'ping':
          conn.send(JSON.stringify({ t: 'pong', at: msg.at } satisfies ToClient));
          return;
      }
    },
    onClose(conn) {
      const seat = seatOf.get(conn);
      if (seat === undefined) return;
      seatOf.delete(conn);
      if (connOf.get(seat) === conn) {
        connOf.delete(seat);
        table.leave(seat);
        persist();
      }
    },
  });

  /** 别的设备能不能直接敲进浏览器，全看这个端口是谁的：房主 5200、dev 5199 */
  function inviteUrls(): string[] {
    return lanAddresses().map((ip) => `http://${ip}:${port}/`);
  }

  ws.start();
  const ticker = setInterval(() => table.tick(), 1000);

  return {
    table,
    setup,
    savePath,
    handleUpgrade(req, stream, head) {
      if ((req.url ?? '').split('?')[0] !== WS_PATH) return false;
      ws.handle(req, stream, head);
      return true;
    },
    inviteUrls,
    persist,
    close() {
      // 攒着的那一笔当场落盘：Ctrl-C 之后可没有下一个 300 毫秒等它
      if (due) {
        clearTimeout(due);
        due = null;
      }
      write();
      clearInterval(ticker);
      ws.stop();
    },
  };
}
