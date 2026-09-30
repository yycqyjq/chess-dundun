import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { LEVELS } from '../ai/agent.ts';
import type { Rules } from '../core/game.ts';
import { loadRules } from './load_rules.ts';
import { Table, type TableSetup } from '../net/table.ts';
import { checkHost, type ToClient, type ToHost } from '../net/wire.ts';
import { WsServer, type Conn } from '../net/ws.ts';
import { announcePortOf, encodeOffer, NO_DISCOVER, offerOf, slotOf } from '../net/discover.ts';
import { openDiscovery, type Discovery, type Found } from './discover.ts';

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

/**
 * 命令行上的数得先过一遍再交给桌：`--players=abc` 一路 Number 就成了 NaN，
 * 牌桌抱着 NaN 摆牌，崩的地方离那行参数十万八千里远。当场把这句话说清楚，改了再来。
 */
export function intFlag(argv: string[], name: string, fallback: number, lo: number, hi: number): number {
  const raw = flag(argv, name, '');
  if (raw === '') return fallback;
  if (!/^-?\d+$/.test(raw)) throw new Error(`--${name} 得是个整数，你给的是「${raw}」`);
  const n = Number(raw);
  if (n < lo || n > hi) throw new Error(`--${name} 只能在 ${lo} 到 ${hi} 之间，你给的是 ${n}`);
  return n;
}

/** 命令行 → 这桌的默认配置。认不下的一句都当场抛，别开着一条废桌等人来发现 */
export function setupFrom(argv: string[], rules: Rules): TableSetup {
  const players = intFlag(argv, 'players', rules.playerCounts[0] ?? 2, 1, 8);
  if (!rules.playerCounts.includes(players))
    throw new Error(`--players 只能是 ${rules.playerCounts.join(' 或 ')}，你给的是 ${players}`);
  // 从引擎那张清单里挑，而不是把字符串硬转成档位：自定义的 rules.json 少了哪种玩法，这儿就跟着少一种
  const said = flag(argv, 'mode', 'kou');
  const mode = rules.modes.find((m) => m === said);
  if (!mode) throw new Error(`--mode 只有 ${rules.modes.join('、')} 这几种玩法，你给的是「${said}」`);
  const level = flag(argv, 'level', 'hard');
  const picked = LEVELS.find((l) => l === level);
  if (!picked) throw new Error(`--level 只有 ${LEVELS.join('/')} 这几档，你给的是「${level}」`);
  return {
    rules,
    players,
    mode,
    level: picked,
    seed: intFlag(argv, 'seed', (Math.random() * 0x100000000) | 0, 0, 0xffffffff),
    hostSeat: intFlag(argv, 'host-seat', 0, 0, players - 1),
  };
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
  return lanNets().map((n) => n.ip);
}

/**
 * 同上，但连掩码一起给——寻呼要往「这块网段的广播地址」发包，光有 IP 算不出来。
 * 掩码配得怪（零散位、/32）由 discover.ts 的 broadcastOf 拒掉：那一头就只剩全网广播和回环两路。
 *
 * `nics` 空着就是问本机；测试那头递一张假的进来。不然这四条筛选（回环／169.254／IPv6／VPN 那串名字）
 * 加打分排序就只能长在真机上——而它们筛错了的样子跟「这块网不让设备互访」一模一样，看不出区别。
 */
export function lanNets(nics: ReturnType<typeof networkInterfaces> = networkInterfaces()): { ip: string; mask: string }[] {
  const hits: { name: string; ip: string; mask: string }[] = [];
  for (const [name, list] of Object.entries(nics)) {
    if (NIC_SKIP.test(name)) continue;
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      // 169.254 是没配上 DHCP 时自己编的地址，出不了这块网卡
      if (net.address.startsWith('169.254.')) continue;
      hits.push({ name, ip: net.address, mask: net.netmask });
    }
  }
  hits.sort((a, b) => nicScore(a.name) - nicScore(b.name) || a.name.localeCompare(b.name, 'en', { numeric: true }));
  return hits.map(({ ip, mask }) => ({ ip, mask }));
}

export interface Room {
  table: Table;
  setup: TableSetup;
  /** 存档落在哪儿：横幅要把它念出来，好让人知道 Ctrl-C 之后接得回什么 */
  savePath: string;
  /** 只吃 /ws 那条升级；收回 true 表示这条 socket 归它了，别的一条字节都不碰（Vite 的 HMR 也挂在同一个 httpServer 上） */
  handleUpgrade(req: IncomingMessage, stream: Duplex, head: Buffer): boolean;
  /** 只吃 GET /whoami 那一句；同样回 true 表示这个请求我应了。两个宿主各自挂一次，省得两份实现走岔 */
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean;
  /** 寻一圈同网别的桌（客户端候场厅那颗按钮）：没开寻呼就一句回话，不装模作样等那 700 毫秒 */
  find(): Promise<Found>;
  /** 寻呼守的那个 UDP 口，加上一句「开没开」：终端横幅念出来，才知道该去哪儿 curl 一下试试 */
  discovery: { port: number; on: boolean };
  /** 能递给别的设备直接敲进浏览器的那串地址；终端横幅和候场厅里那个二维码都从这儿拿 */
  inviteUrls(): string[];
  persist(): void;
  close(): void;
}

/** 一句线上的字节该怎么办：认下来的一句话、该回的那句拒、或者请这条连接下桌。见 openRoom 里那句 onMessage */
export type Verdict = { msg: ToHost } | { reject: string } | { close: string };

/**
 * 收字节到递话之间的那道门，单拎出来就为了它能被敲：
 * 「一句 {"t":"act","action":{}} 凭什么叫停整个房主进程」这一类账，原来只有现场探针守得住。
 * 认下来的那份是 checkHost 重建过的——线上原话里的野字段一句都带不下去。
 * 抛错只有两种来路：JSON 本身不合法，和 checkHost 撞上了没见过的形状（那种形状是它的 bug，
 * 当场把这条连接请下桌，别让一句说不清的字节把全桌带走）。
 */
export function gate(text: string, seats: number, rules: Pick<Rules, 'modes' | 'playerCounts'>): Verdict {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { close: '说的话看不懂' };
  }
  try {
    const checked = checkHost(raw, seats, rules);
    return typeof checked === 'string' ? { reject: checked } : { msg: checked };
  } catch (e) {
    return { close: `这句办不了（${String((e as Error).message)}）` };
  }
}

export function openRoom(argv: string[], port: number): Room {
  const setup = setupFrom(argv, loadRules());
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
  /**
   * 散桌：这份存档不留硬盘。合批那颗延时也一起掐掉——不掐，三秒前那一下改变化还排在队里，
   * 半秒后就把刚抹掉的桌子又写回去了；留着一份接得回来的旧账，「散了」就成了「这一秒看不见」。
   */
  function discard(): void {
    if (due) {
      clearTimeout(due);
      due = null;
    }
    rmSync(savePath, { force: true });
  }
  // 一开桌就落一次盘：还没人坐过椅子就断掉，重启也接得回这一桌的牌面
  write();

  /**
   * 答话的内容：UDP 那一句和 HTTP 那一句（GET /whoami）得是同一份，
   * 不然对着终端 curl 一下以为寻呼是好的、广播出去的却是另一套。
   */
  function whoamiText(): string {
    return encodeOffer(offerOf(table.lobby(), port));
  }

  /**
   * 同网寻呼：一台机器一张桌守一槽（dev 5199 和 host 5200 各落一槽，同一台机器上两张桌也打得开）。
   * --no-discover 是给自己留的后路：冒烟里同时起两张桌时谁都不该听见谁；
   * 而这一口占不住（防火墙拦、被别的东西占了）也只当寻不到桌，牌照样打。
   */
  const disc: Discovery | null = hasFlag(argv, 'no-discover')
    ? null
    : openDiscovery({
        httpPort: port,
        slot: intFlag(argv, 'discover-slot', slotOf(port), 0, 7),
        nets: lanNets(),
        answer: whoamiText,
        log: tell,
      });

  /** 客户端列表页那句 find 走的门（浏览器发不了 UDP，这一趟由本机宿主代跑）：寻呼关着就当场回一句，不让人白等那 700 毫秒 */
  function find(): Promise<Found> {
    if (disc) return disc.find();
    return Promise.resolve({ rooms: [], why: NO_DISCOVER });
  }

  const ws = new WsServer({
    onMessage(conn, text) {
      // 认字节那一趟全在 gate 里（那儿有闸）；这儿只剩搬运，加一道兜底：
      // handle 真办砸了也该它自己下桌，凭什么叫全桌跟着掉线
      const v = gate(text, table.state.players, table.state.rules);
      if ('close' in v) {
        tell(`${v.close}（来自 ${conn.addr}），先请它下桌`);
        conn.close(v.close);
        return;
      }
      if ('reject' in v) {
        tell(`拒了一句：${v.reject}（来自 ${conn.addr}）`);
        conn.send(JSON.stringify({ t: 'reject', why: v.reject } satisfies ToClient));
        return;
      }
      try {
        handle(conn, v.msg);
      } catch (e) {
        tell(`这句办砸了（${String((e as Error).message)}），先把 ${conn.addr} 请下桌`);
        conn.close('这句办不了');
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

  function handle(conn: Conn, msg: ToHost): void {
    const seat = seatOf.get(conn);
    switch (msg.t) {
      case 'lobby':
        conn.send(JSON.stringify({ t: 'seats', ...table.lobby(), lan: inviteUrls() } satisfies ToClient));
        return;
      case 'join': {
        // seat -1＝「给我挑一把空椅」：扫码进来的人进门就落座，挑哪一把归桌定。
        // 这条连接已经站着了就不另挪椅子——一个标签页占两把，屏幕上就分不清谁是谁；
        // 真递上来也只是拿原来那把重走一遍入座（令牌对不上就被 join 挡回，不会多出第二把）
        const want: number | null = msg.seat >= 0 ? msg.seat : (seatOf.get(conn) ?? table.freeSeat());
        if (want === null) {
          conn.send(JSON.stringify({ t: 'reject', why: '这桌没空椅子了（房主位留给开桌那位，不自动给）' } satisfies ToClient));
          return;
        }
        // 先把椅子认给这条连接再落座：桌在 join 里就要广播一份快照，晚一步那份就发飞了
        const prev = connOf.get(want);
        const from = seatOf.get(conn);
        seatOf.set(conn, want);
        connOf.set(want, conn);
        const r = table.join(want, msg.token, msg.nick, from);
        if (!r.ok || !r.msg) {
          // 换椅子没换成：原来那把还得是他的，别一句「坐不下」把人连原有的椅子一起摘了
          if (from !== undefined) seatOf.set(conn, from);
          else seatOf.delete(conn);
          if (prev) connOf.set(want, prev);
          else connOf.delete(want);
          conn.send(JSON.stringify({ t: 'reject', why: r.why ?? '坐不下' } satisfies ToClient));
          return;
        }
        // 换椅子：旧那把的连接认得回来了，不再替那把椅子说话
        if (from !== undefined && from !== want && connOf.get(from) === conn) connOf.delete(from);
        // 同一个位子只许一个人连着：令牌对得上，就把旧那条连接踢掉
        // 同一条连接重新入座（改个代号、认回椅子）不算换人，别把自己踢下线
        if (prev && prev !== conn) prev.close('这把椅子换了人');
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
        if (!r.ok) conn.send(JSON.stringify({ t: 'reject', why: r.why ?? '这手不合法' } satisfies ToClient));
        persist();
        return;
      }
      case 'start': {
        if (seat === undefined) {
          conn.send(NO_SEAT);
          return;
        }
        const r = table.start(seat);
        if (!r.ok) conn.send(JSON.stringify({ t: 'reject', why: r.why ?? '开不了局' } satisfies ToClient));
        persist();
        return;
      }
      case 'setup': {
        if (seat === undefined) {
          conn.send(NO_SEAT);
          return;
        }
        const r = table.changeSetup(seat, { players: msg.players, mode: msg.mode, level: msg.level });
        if (!r.ok) conn.send(JSON.stringify({ t: 'reject', why: r.why ?? '这会儿改不了' } satisfies ToClient));
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
      case 'reset': {
        // 清账重开：形状过 checkHost，能不能清归桌查（只有房主位、只有没开打）
        if (seat === undefined) {
          conn.send(NO_SEAT);
          return;
        }
        const r = table.resetBook(seat);
        if (!r.ok) conn.send(JSON.stringify({ t: 'reject', why: r.why ?? '这会儿清不了' } satisfies ToClient));
        persist();
        return;
      }
      case 'disband': {
        // 候场厅那颗「返回」在只剩他一个活人时递上来：能不能散归桌查（只有房主、只有没开打、只有他一个活人）
        if (seat === undefined) {
          conn.send(NO_SEAT);
          return;
        }
        const r = table.disband(seat);
        if (!r.ok) {
          conn.send(JSON.stringify({ t: 'reject', why: r.why ?? '散不了这桌' } satisfies ToClient));
          return;
        }
        discard();
        // 这把椅子的连接先解绑再关：不先解绑，onClose 会替那位再走一遍 leave ＋落盘，把空桌又写回硬盘
        seatOf.delete(conn);
        if (connOf.get(seat) === conn) connOf.delete(seat);
        conn.close('这桌散了');
        return;
      }
      case 'find': {
        // 找桌不看座位：还没坐下的人恰恰最需要知道别处有没有空桌。一轮最多一个在飞，挡在 discover 那边
        void find().then((r) =>
          conn.send(JSON.stringify({ t: 'rooms', rooms: r.rooms, why: r.why } satisfies ToClient)),
        );
        return;
      }
      case 'ping':
        conn.send(JSON.stringify({ t: 'pong', at: msg.at } satisfies ToClient));
        return;
    }
  }

  /** 别的设备能不能直接敲进浏览器，全看这个端口是谁的：房主 5200、dev 5199 */
  function inviteUrls(): string[] {
    return lanAddresses().map((ip) => `http://${ip}:${port}/`);
  }

  ws.start();
  /**
   * 一秒一次的表。桌真动了手才落盘：代打那几手、局末退回候场、两分钟收椅子，
   * 原来全都不落（只有收到客户端话时才 persist），一桌全 AI 能连打几局而存档一个字不变。
   * 反过来，全桌都在想牌的那一秒啥也没变，也就不必惊动硬盘。
   */
  const ticker = setInterval(() => {
    if (table.tick()) persist();
  }, 1000);

  return {
    table,
    setup,
    savePath,
    handleUpgrade(req, stream, head) {
      if ((req.url ?? '').split('?')[0] !== WS_PATH) return false;
      ws.handle(req, stream, head);
      return true;
    },
    /**
     * 就认 GET /whoami 那一条，别的一条字节不碰——页面、HMR、别的升级都照原路走。
     * 这份答话不带任何牌面，只有候场厅本来就公开的那几句，所以不查 Origin：
     * 它是给人 curl 着看的，不是给页面读的。
     */
    handleHttp(req, res) {
      if ((req.method ?? 'GET').toUpperCase() !== 'GET') return false;
      if ((req.url ?? '').split('?')[0] !== '/whoami') return false;
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf8',
        'cache-control': 'no-store',
      });
      res.end(whoamiText());
      return true;
    },
    find,
    discovery: { port: disc?.port ?? announcePortOf(port), on: disc !== null },
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
      disc?.close();
      ws.stop();
    },
  };
}
