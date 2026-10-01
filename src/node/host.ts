import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasFlag, intFlag, openRoom, type Room } from './room.ts';
import { fileFor, notFound, sendFile } from './serve.ts';

/**
 * 房主这一进程：同源把 dist/ 端出来，再在同一个端口上挂那张牌桌。
 * 为什么非得同源——https 页面里连 ws://192.168.x.x 会被浏览器当混合内容拦下，
 * 局域网这桌只能走 http://IP:端口。
 * 改界面时用不着这个进程：npm run dev 自己就带着同一张桌（挂的是 Vite 的开发服务器）。
 */

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = normalize(join(ROOT, '..', '..', 'dist'));
// 5199 让给 npm run dev，房主自己占 5200，两个端口能同时跑——但两份存档不能：
// 起桌前先在存档旁边占一条，抢同一份存档的那张当场开不起来（闸在 room.ts::claimSave）
const DEFAULT_PORT = 5200;

function serve(req: IncomingMessage, res: ServerResponse): void {
  if (room.handleHttp(req, res)) return; // GET /whoami：同一条端口上问一声「这桌上有没有人」
  const file = fileFor(req.url ?? '/', DIST);
  if (!file) {
    notFound(res);
    return;
  }
  sendFile(res, file);
}

const argv = process.argv.slice(2);
if (hasFlag(argv, 'help')) {
  console.log(
    'npm run host -- --players=2 --mode=kou --level=hard --port=5200 --seed=7 --save=table.json\n' +
      '  --fresh   丢掉上一次的牌桌，重开一桌\n' +
      '  --players/--mode/--level 只是这桌的默认值，进候场厅后房主随时能在页面上改\n' +
      '  --save=另一份文件  一台机器上要同时开两张桌就得各用各的存档：抢同一份存档的那张会被当场拒掉\n' +
      '  --no-discover   不参与同网寻呼（一台机器开两张桌时，其中一张加这个）\n' +
      '  --discover-slot=0..7  寻呼换一槽守；默认按 http 端口落槽\n' +
      '  先 npm run build 把 dist/ 端出来，这进程只负责把它和 WebSocket 挂在同一个端口上\n' +
      '  只想改界面、顺手也要能联机：npm run dev 一条命令就够，那张桌就挂在 Vite 上',
  );
  process.exit(0);
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/ 还没建，先跑 npm run build');
  process.exit(1);
}

const { port, room } = openTable();
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
  // 问 /whoami 得拿没带 query 的那一条：邀请地址现在尾巴上是 ?join=1，直接拼上去就成了 ?join=1whoami
  const curlBase = (urls[0] ?? `http://127.0.0.1:${port}/`).split('?')[0];
  if (urls.length) {
    console.log('同一张网里别的设备打开（地址敲进浏览器就行，不用装任何东西；进去就是候场厅）：');
    for (const url of urls) console.log(`  ${url}`);
  } else {
    console.log('没找到局域网地址：这台机器好像没连上路由器');
  }
  console.log(
    room.discovery.on
      ? `同网寻呼守 UDP ${room.discovery.port}（别的设备上同网桌列表那一页就靠它）；想自己确认一下：curl ${curlBase}whoami`
      : '同网寻呼没开（--no-discover）：别的设备只能照上面那条地址手动敲',
  );
  console.log(
    `\n房主那位位子：P${(setup.hostSeat ?? 0) + 1}。人到位后在候场厅按「开始这一局」；` +
      `没坐的位子那一局由电脑补。\nCtrl-C 收杆，牌桌会存下来，下次接着打。\n`,
  );
});

process.once('SIGINT', quit);
process.once('SIGTERM', quit);

/** 参数写歪了就撂一句人话退台：终端上甩一串栈，谁都看不出是自己那行敲错了 */
function openTable(): { port: number; room: Room } {
  try {
    const p = intFlag(argv, 'port', DEFAULT_PORT, 1, 65535);
    return { port: p, room: openRoom(argv, p) };
  } catch (e) {
    console.error(`这桌开不起来：${(e as Error).message}（--help 看怎么写）`);
    process.exit(2);
  }
}

function quit(): void {
  room.close();
  server.close();
  console.log('\n收杆，这一桌存进存档了。');
  process.exit(0);
}
