import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag, hasFlag, openRoom } from './room.ts';

/**
 * 房主这一进程：同源把 dist/ 端出来，再在同一个端口上挂那张牌桌。
 * 为什么非得同源——https 页面里连 ws://192.168.x.x 会被浏览器当混合内容拦下，
 * 局域网这桌只能走 http://IP:端口。
 * 改界面时用不着这个进程：npm run dev 自己就带着同一张桌（挂的是 Vite 的开发服务器）。
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = normalize(join(ROOT, '..', '..', 'dist'));
// 5199 让给 npm run dev，房主自己占 5200，两个端口能同时跑（但都写同一份存档，别同时开两桌）
const DEFAULT_PORT = 5200;

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
if (hasFlag(argv, 'help')) {
  console.log(
    'npm run host -- --players=2 --mode=kou --level=hard --port=5200 --seed=7 --save=table.json\n' +
      '  --fresh   丢掉上一次的牌桌，重开一桌\n' +
      '  --players/--mode/--level 只是这桌的默认值，进候场厅后房主随时能在页面上改\n' +
      '  先 npm run build 把 dist/ 端出来，这进程只负责把它和 WebSocket 挂在同一个端口上\n' +
      '  只想改界面、顺手也要能联机：npm run dev 一条命令就够，那张桌就挂在 Vite 上',
  );
  process.exit(0);
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/ 还没建，先跑 npm run build');
  process.exit(1);
}

const port = Number(flag(argv, 'port', String(DEFAULT_PORT)));
const room = openRoom(argv, port);
const { table, setup } = room;

const server = createServer(serve);
server.on('upgrade', (req, socket, head) => {
  if (!room.handleUpgrade(req, socket, head)) socket.destroy();
});
server.listen(port, '0.0.0.0', () => {
  console.log(
    `\n棋墩墩联机房主：默认 ${setup.players} 人 ${setup.mode === 'kou' ? '扣棋' : '明棋'}，代打用 ${setup.level} 档`,
  );
  console.log(`牌面种子 ${table.state.seed}，存档 ${room.savePath}`);
  console.log('\n这台机器上打开：');
  console.log(`  http://127.0.0.1:${port}/`);
  const urls = room.inviteUrls();
  if (urls.length) {
    console.log('同一张网里别的设备打开（地址敲进浏览器就行，不用装任何东西；进去就是候场厅）：');
    for (const url of urls) console.log(`  ${url}`);
  } else {
    console.log('没找到局域网地址：这台机器好像没连上路由器');
  }
  console.log(
    `\n房主那位位子：P${(setup.hostSeat ?? 0) + 1}。人到位后在候场厅按「开始这一局」；` +
      `没坐的位子那一局由电脑补。\nCtrl-C 收杆，牌桌会存下来，下次接着打。\n`,
  );
});

process.once('SIGINT', quit);
process.once('SIGTERM', quit);

function quit(): void {
  room.close();
  server.close();
  console.log('\n收杆，这一桌存进存档了。');
  process.exit(0);
}
