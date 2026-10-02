/**
 * 桌面外壳的测试：往哪串端口上让、给房主子进程那串参数、窗口开哪条地址、自检算不算过。
 * 全在 Node 里跑，一个 electron 都不引——判断本来就住在 `desktop/launch.ts`（`main.ts` 引 electron，进不了这儿）。
 * 最后那一节是「搬对地方没有」的对账：launcher 不许自己再拼一份 URL、launch.ts 不许引 electron。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PORT,
  MOUNT_MARK,
  PORT_SPAN,
  entryUrl,
  hostArgs,
  portCandidates,
  selftestOk,
  stripTypeFlags,
  whoamiUrl,
} from '../../desktop/launch.ts';
import { SAVE, flag, hasFlag, intFlag } from '../node/room.ts';
import { WHOAMI, encodeOffer, offerOf } from '../net/discover.ts';
import type { Lobby, SeatInfo } from '../net/wire.ts';

let failures = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 够一份答话用的最小座位表：桌面自检只吃「这是不是棋墩墩的答话」，牌面用不上 */
function lobby(players = 2): Lobby {
  const seats: SeatInfo[] = Array.from({ length: players }, (_, seat) => ({
    seat,
    name: `P${seat + 1}`,
    online: false,
    taken: false,
    ai: true,
    human: false,
    queued: false,
    nick: '',
  }));
  return { players, hostSeat: 0, homeSeat: 0, gameNo: 1, mode: 'kou', level: 'hard', seats, status: 'waiting' };
}

const USER_DATA = join('/tmp', 'qdd-desktop-userdata');
/** 桌面那张桌的答话：跟 room.ts 里 GET /whoami 端出去的是同一只手拼的 */
function answer(port = DEFAULT_PORT): { status: number; body: string } {
  return { status: 200, body: encodeOffer(offerOf(lobby(), port)) };
}
const PAGE = { status: 200, body: `<!doctype html><html><body>${MOUNT_MARK} data-x="1"></div></body></html>` };

console.log('端口让位');
{
  const list = portCandidates();
  ok(`从 ${DEFAULT_PORT} 起往前沿着数（那是 npm run host 那一条，桌面撞上就该让开）`, list[0] === DEFAULT_PORT, `实际 ${list[0]}`);
  ok('让到 PORT_SPAN 个就收口，别一路找到 65535', list.length === PORT_SPAN, `实际 ${list.length} 个`);
  ok('每一条比前一条大 1：让位只挨个试，不跳段', list.every((p, i) => p === DEFAULT_PORT + i));
  ok('首选是别人给的时就从那条起（--port 那一条走的是同一只手）', portCandidates(7300)[0] === 7300 && portCandidates(7300).length === PORT_SPAN);
  ok('一个端口都不重复：重复就是同一个存档试两遍', new Set(list).size === list.length);
}

console.log('给房主子进程那串参数');
{
  const args = hostArgs(USER_DATA, 5213);
  // 回读用的是 host.ts/room.ts 那三只手：参数名写歪一个字母，那边读回来的就是默认值
  ok('端口那边读得回来，而且就是桌面挑的那个', intFlag(args, 'port', 1, 1, 65535) === 5213, args.join(' '));
  ok('存档那边读得回来，落在 App 自己的 userData 里', flag(args, 'save', '') === join(USER_DATA, 'table.json'), args.join(' '));
  ok('存档绝不等于仓库根那份 table.json——那是正在打的活存档', flag(args, 'save', '') !== SAVE, `实际 ${flag(args, 'save', '')}`);
  ok('省略 --save 就是落回默认那份，所以这一项必须写出来', args.some((a) => a.startsWith('--save=')));
  const other = hostArgs(join('/tmp', 'qdd-other'), 5213);
  ok('换一份 userData，存档跟着换：路径是从参数来的，不是写死的', flag(other, 'save', '') === join('/tmp', 'qdd-other', 'table.json'));
  ok('不许带 --fresh：桌面重开该接回自己那一桌，不是每次掀了重摆', !hasFlag(args, 'fresh'), args.join(' '));
  ok('带上 --watch-parent：外壳挨强退／崩了，这张桌自己先存档再退，不赖在端口和占位条上', hasFlag(args, 'watch-parent'), args.join(' '));
  ok('host 那一头读的就是这一串：拼法只有一份，改名不会两头各自安好', readFileSync(new URL('../node/room.ts', import.meta.url), 'utf8').includes(`hasFlag(argv, 'watch-parent')`) && args.includes('--watch-parent'), args.join(' '));
}

console.log('窗口开哪条地址');
{
  ok('开本机那条 http，端口跟着挑到的那个走', entryUrl(5299) === 'http://127.0.0.1:5299/');
  ok('末尾留斜杠：whoami 就接在这条尾巴上', entryUrl(5200).endsWith('/'));
  ok('问「这桌上有没有人」是这条地址加 whoami，不多一个斜杠', whoamiUrl(5299) === 'http://127.0.0.1:5299/whoami');
  ok('拼法只有一份：whoami 永远长在 entryUrl 后面（改了那边这边跟着动）', whoamiUrl(5301) === `${entryUrl(5301)}whoami`);
}

console.log('TypeScript 入口那条 flag 给不给');
{
  ok('这台 Node 认这条就给（22.6～23.5 不显式加读不了 .ts）', stripTypeFlags(new Set(['--experimental-strip-types'])).length === 1);
  ok('认都不认就别给：不认识的 Node 见到未知 flag 当场报错退出，桌压根起不来', stripTypeFlags(new Set<string>()).length === 0);
  ok('给的那一条就是这条本身，不许顺手塞别的', stripTypeFlags(new Set(['--experimental-strip-types']))[0] === '--experimental-strip-types');
  ok('真在这台机器上问一次：allowedNodeEnvironmentFlags 里有没有，跟 Set 那两条口径一致', stripTypeFlags(process.allowedNodeEnvironmentFlags).length === (process.allowedNodeEnvironmentFlags.has('--experimental-strip-types') ? 1 : 0));
}

console.log('自检算不算过');
{
  ok('页面带挂载那一格、whoami 是棋墩墩的答话：算过', selftestOk(PAGE, answer()));
  ok('页面不是 200：不过', selftestOk({ ...PAGE, status: 404 }, answer()) === false);
  ok('页面 200 但读不出挂载那一格：端出来的不是这份界面', selftestOk({ status: 200, body: '<html><body>别的进程占着这个端口</body></html>' }, answer()) === false);
  ok('whoami 不是 200：桌还没起来', selftestOk(PAGE, { status: 500, body: '' }) === false);
  ok('whoami 200 但不是 JSON：不是桌在答话', selftestOk(PAGE, { status: 200, body: '<html>ok</html>' }) === false);
  ok('whoami 200、JSON 也对，但不是棋墩墩的答话（别的开发服务器）：不许照单收下', selftestOk(PAGE, { status: 200, body: JSON.stringify({ status: 'ok', port: 5200 }) }) === false);
  ok('口令写歪一个字符就不算：认的是 discover.ts 里那一串', selftestOk(PAGE, { status: 200, body: JSON.stringify({ t: `${WHOAMI}-x` }) }) === false);
  ok('只认「读得出 JSON」是不够的：一份数组也读得出，但那张桌不报数组', selftestOk(PAGE, { status: 200, body: '[1,2,3]' }) === false);
}

console.log('判断确实住在 launch.ts');
{
  const launch = readFileSync(new URL('../../desktop/launch.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../../desktop/main.ts', import.meta.url), 'utf8');
  // 注释里提一次「窗口开的是 http://127.0.0.1:端口/」不算第二条路，所以先把注释行摘掉再对账
  const code = main
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  ok('launch.ts 一个字都不引 electron：引了这份文件就进不了 Node 测试，判断等于没闸', !launch.includes("'electron'"));
  ok('main.ts 里没有第二条拼地址的路：那条地址只有 entryUrl/whoamiUrl 两只手', !code.includes('127.0.0.1') && !/['"`]\/?whoami/.test(code));
  ok('main.ts 里没有第二条端口清单：让位那串只有 portCandidates 一只嘴', !code.includes('Array.from') && code.includes('portCandidates'));
  ok('main.ts 收尾发的是 SIGTERM：那是 host.ts 里先存档再退的那条路，硬杀会丢这一桌', code.includes("kill('SIGTERM')") && !code.includes("kill('SIGKILL')"));
  ok('main.ts 试端口照 0.0.0.0 的绑法试：host.ts 绑的就是它，拿 127.0.0.1 试会看走眼', code.includes("listen(port, '0.0.0.0')"));
  // 等桌开口那一段：只有 exit 事件算「那桌自己走了」。查 child.killed 是条永远不成立的闸——它只有 stopHost() 调过 kill() 之后才真
  ok('main.ts 等桌开口接的是子进程 exit：它自己走了就立刻收，别对着一台没动静的机器干等满 15 秒', code.includes("once('exit'") && !code.includes('.killed'));
  // spawn 自己就没成那一种（那条二进制没了／没权限）：Node 发的是 error，`exit` 一声不响（探针量过）。
  // 认的是「哪一位接的」——`freePort` 里那句 `srv.once('error')` 长得一样，光认 `once('error'` 会被它蒙过去（刀 P 量出来的）
  ok('main.ts 也接了 spawn 那条 error：那种下场 exit 不响，没人接就是把主进程连那串参数一起崩掉', code.includes("proc.once('error'"));
  ok('等桌开口有一条不靠请求回应的硬闸：body 卡在半截就是没下场，只靠重试那一排能一直干等', code.includes('setTimeout(() => res(false), READY_MS)'));
  ok('读页面接了 aborted：header 已回、body 永远不到时 req 那条 error 不会响，不接这句自检就永不收尾', code.includes("r.on('aborted'"));
  // 一台机器一个实例：双击图标两下就是两个 Electron 进程，各自起桌抢同一份 userData 存档（claimSave 的闸挡的是跨进程，挡不住同机第二个 Electron 起得比它快）
  ok('双击图标起两次：第二个实例拿不到单实例锁就当场退出，不跟第一个抢同一份存档', code.includes('app.requestSingleInstanceLock()') && code.includes('app.exit(0)'));
  const host = readFileSync(new URL('../../src/node/host.ts', import.meta.url), 'utf8');
  ok('host.ts 把那条看门狗拴在开桌之后：拴在前面那一挨就是撞 room 还没定义，桌没存成反倒抛一句', host.includes('orphanWatch(argv, quit)') && host.indexOf('orphanWatch(argv, quit)') > host.indexOf('openTable();'));
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条没过`);
process.exit(failures === 0 ? 0 : 1);
