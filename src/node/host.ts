import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Level } from '../ai/agent.ts';
import { loadRules } from './load_rules.ts';
import { Table, type TableSetup } from '../net/table.ts';
import type { ToClient, ToHost } from '../net/wire.ts';
import { WsServer, type Conn } from '../net/ws.ts';

/**
 * 房主这一进程：同源把 dist/ 端出来，再在同一个端口上挂 WebSocket。
 * 为什么非得同源——https 页面里连 ws://192.168.x.x 会被浏览器当混合内容拦下，
 * 局域网这桌只能走 http://IP:端口。
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = normalize(join(ROOT, '..', '..', 'dist'));
const DEFAULT_PORT = 5199;
const SAVE = normalize(join(ROOT, '..', '..', 'table.json'));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf8',
  '.js': 'text/javascript; charset=utf8',
  '.css': 'text/css; charset=utf8',
  '.json': 'application/json; charset=utf8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf8',
  '.woff2': 'font/woff2',
};

/** 取值口径跟命令行那头一样：--名=值 和 --名 值 两种写法都认 */
function flag(argv: string[], name: string, fallback: string): string {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** 同一台路由器上怎么找到这台房：把非回环的 IPv4 全列出来 */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/**
 * 能递给别的设备直接敲进浏览器的那串地址。
 * 终端横幅和大厅里那张二维码都从这儿拿，别两处各拼一遍拼出两个口径。
 */
function inviteUrls(): string[] {
  return lanAddresses().map((ip) => `http://${ip}:${port}/`);
}

function fileFor(url: string): string | null {
  const path = decodeURIComponent(url.split('?')[0] ?? '');
  const rel = path === '/' || path === '' ? 'index.html' : path.replace(/^\/+/, '');
  const full = normalize(join(DIST, rel));
  // 挡目录穿越：算出来的路径必须还在 dist 里头
  if (full !== DIST && !full.startsWith(DIST + sep)) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

function serve(req: IncomingMessage, res: ServerResponse): void {
  const file = fileFor(req.url ?? '/');
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf8' });
    res.end('没这个文件');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(readFileSync(file));
}

const argv = process.argv.slice(2);
if (has(argv, 'help')) {
  console.log(
    'npm run host -- --players=2 --mode=kou --level=hard --port=5199 --seed=7 --save=table.json\n' +
      '  --fresh   丢掉上一次的牌桌，重开一桌\n' +
      '  先 npm run build 把 dist/ 端出来，这进程只负责把它和 WebSocket 挂在同一个端口上',
  );
  process.exit(0);
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/ 还没建，先跑 npm run build');
  process.exit(1);
}

const port = Number(flag(argv, 'port', String(DEFAULT_PORT)));
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

function restore(): Table | null {
  if (has(argv, 'fresh') || !existsSync(savePath)) return null;
  try {
    const table = Table.load(readFileSync(savePath, 'utf8'), send, tell);
    console.log(`接回了上一桌（第 ${table.gameNo} 局）；要重开就加 --fresh`);
    return table;
  } catch (e) {
    console.log(`上一桌的存档读坏了（${String((e as Error).message)}），重开一桌`);
    return null;
  }
}

function tell(line: string): void {
  console.log(`  ${line}`);
}

const table = restore() ?? new Table(setup, send, tell);

function persist(): void {
  writeFileSync(savePath, table.save());
}
// 一开桌就落一次盘：还没人坐过椅子就断掉，重启也接得回这一桌的牌面
persist();

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
        conn.send(JSON.stringify({ t: 'seats', ...table.lobby(), lan: inviteUrls() } satisfies ToClient));
        return;
      case 'join': {
        // 先把椅子认给这条连接再落座：桌在 join 里就要广播一份快照，晚一步那份就发飞了
        const prev = connOf.get(msg.seat);
        seatOf.set(conn, msg.seat);
        connOf.set(msg.seat, conn);
        const r = table.join(msg.seat, msg.token);
        if (!r.ok || !r.msg) {
          seatOf.delete(conn);
          if (prev) connOf.set(msg.seat, prev);
          else connOf.delete(msg.seat);
          conn.send(JSON.stringify({ t: 'reject', why: r.why ?? '坐不下' } satisfies ToClient));
          return;
        }
        // 同一个位子只许一个人连着：令牌对得上，就把旧那条连接踢掉
        prev?.close('这把椅子换了人');
        conn.send(JSON.stringify(r.msg satisfies ToClient));
        persist();
        return;
      }
      case 'act': {
        if (seat === undefined) return;
        const r = table.act(seat, msg.action);
        if (!r.ok) conn.send(JSON.stringify({ t: 'reject', why: r.why ?? '这手不合法' } satisfies ToClient));
        persist();
        return;
      }
      case 'next': {
        if (seat === undefined) return;
        const r = table.nextGame(seat);
        if (!r.ok) conn.send(JSON.stringify({ t: 'reject', why: r.why ?? '开不了下一局' } satisfies ToClient));
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

const server = createServer(serve);
server.on('upgrade', (req, socket, head) => ws.handle(req, socket, head));
server.listen(port, '0.0.0.0', () => {
  console.log(`\n棋墩墩联机房主：${setup.players} 人 ${setup.mode === 'kou' ? '扣棋' : '明棋'}，代打用 ${setup.level} 档`);
  console.log(`牌面种子 ${table.state.seed}，存档 ${savePath}`);
  console.log('\n这台机器上打开：');
  console.log(`  http://127.0.0.1:${port}/`);
  const urls = inviteUrls();
  if (urls.length) {
    console.log('同一张网里别的设备打开（地址敲进浏览器就行，不用装任何东西）：');
    for (const url of urls) console.log(`  ${url}`);
  } else {
    console.log('没找到局域网地址：这台机器好像没连上路由器');
  }
  console.log(`\n房主那位位子：P${(setup.hostSeat ?? 0) + 1}。Ctrl-C 收杆，牌桌会存下来，下次接着打。\n`);
});

ws.start();
const ticker = setInterval(() => table.tick(), 1000);

function quit(): void {
  persist();
  clearInterval(ticker);
  ws.stop();
  server.close();
  console.log('\n收杆，这一桌存进存档了。');
  process.exit(0);
}
process.once('SIGINT', quit);
process.once('SIGTERM', quit);
