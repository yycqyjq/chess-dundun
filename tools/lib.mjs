/**
 * 冒烟和刀共用那几件事：抄一份干净的仓库、挑一个真空着的端口、收尾把坐在端口上的进程插干净。
 *
 * 为什么非得抄一份：`src/node/room.ts` 一开桌就往存档上写（`openRoom` 里那句 `write()`），
 * 而默认存档就是仓库根的 `table.json`——那可能是他正在打的那一桌。
 * 所以任何一场冒烟、任何一把刀都只在临时目录里跑，一笔都不许落在他家硬盘上。
 * 副本本身是常驻复用的（见 `makeScratch`）：改花的部分每场开头增量盖回，想清才用 `--drop`。
 *
 * `node_modules` 不整份搬（54M，每把刀搬一次太蠢），也不整条软链接（那样 Vite 的 `.vite` 缓存会写进
 * 他那个 `node_modules`）：在副本里开一个真目录，一个一个软链过去，`.vite` 就落在副本里。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 跟 `src/net/discover.ts` 同一算法：寻呼口 = 底座 + (http 端口 % 8)。那边改了常量，冒烟里那几条会先红 */
export const ANNOUNCE_BASE = 41732;
export const announcePort = (port) => ANNOUNCE_BASE + (((port % 8) + 8) % 8);
export const slotOf = (port) => ((port % 8) + 8) % 8;

/** 5199 是 `npm run dev`、5200 是 `npm run host` 自己占的槽，冒烟别去撞他的桌 */
export const RESERVED = [5199, 5200];

/**
 * 副本里不带的东西：`node_modules` 走软链，`dist` 是端出去的那份（另接），存档是他正在打的账。
 * `release/` 和 `android/` 是装包那条路的产物（一份 dmg 就 123 MB，gradle 中间产物更多）：
 * 每造一份临时副本都把它们抄一遍，量一刀的功夫全花在拷机上。
 */
const NOT_COPIED = [
  '--exclude=node_modules',
  '--exclude=.git',
  '--exclude=dist',
  '--exclude=table.json',
  '--exclude=release',
  '--exclude=android',
  '--exclude=*.log',
  '--exclude=.DS_Store',
];

/** 跑一条命令，把 stdout+stderr 都收下，退出码非 0 也不抛 */
export function run(cmd, args, opts = {}) {
  try {
    return { code: 0, out: execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...opts }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, err: String(e.message ?? e) };
  }
}

/** 坐在某个 TCP 端口上监听的那些进程号 */
export function tcpPids(port) {
  return run('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN']).out.split('\n').filter(Boolean);
}

/** 某个 UDP 端口上有没有人守着——寻呼口被占了还照量，就是把别人的答话当成自己的 */
export function udpHeld(port) {
  return udpPids(port).length > 0;
}

export function udpPids(port) {
  return run('lsof', ['-nP', '-t', `-iUDP:${port}`]).out.split('\n').filter(Boolean);
}

/**
 * 挑一个真空着的端口：TCP 空、寻呼那个 UDP 口也空、并且躲开他自己那两张桌落的槽。
 * 端口不空就整场测量打在旧代码上——上一批就是这么骗出过一次假绿的。
 */
export function pickPort({ discover = true, from = 5341, to = 5399 } = {}) {
  for (let port = from; port <= to; port++) {
    if (RESERVED.includes(port)) continue;
    if (discover && [slotOf(5199), slotOf(5200)].includes(slotOf(port))) continue;
    if (tcpPids(port).length > 0) continue;
    if (discover && udpHeld(announcePort(port))) continue;
    return port;
  }
  throw new Error(`${from}..${to} 里没有又空又躲得开他那张桌的端口`);
}

/**
 * 拿一份干净仓库到临时目录；`dist` 端的是仓库现在那份，改过界面要先 `npm run build`。
 *
 * 副本**常驻复用**（2026-10-02 改）：目录名固定（`chess-<label>`），不再每次 mkdtemp 起随机名。
 * 之前每调用一次就建一份、收尾删一份全仓——分批跑 --only 时十几次建删，弹窗全是它。
 * 现在复用时先 `rsync -a --delete` 增量盖一遍：源码没变则近乎 no-op，上一场跑挂留下的动刀痕迹
 * （改花的文件、多出来的文件）在 --delete 里一并抹平，等价于全新副本，但**不删目录**。
 * 清理走 `dropAllScratch()`（knives 的 `--drop`）——从「每次跑都删」变成「想清才清」。
 *
 * 注意：同一个 label 同时只能跑一个进程（以前 mkdtemp 天然隔离，现在目录是共享的）。
 */
export function makeScratch(label = 'run') {
  const dir = join(tmpdir(), `chess-${label}`);
  mkdirSync(dir, { recursive: true });
  execFileSync('rsync', ['-a', '--delete', ...NOT_COPIED, `${REPO}/`, `${dir}/`]);
  // 上一场留在副本里的存档是「坐过人的椅子」：不清，基准就卡在「这把椅子坐了人」上
  if (existsSync(join(dir, 'table.json'))) rmSync(join(dir, 'table.json'), { force: true });
  linkNodeModules(dir);
  if (existsSync(join(REPO, 'dist')) && !existsSync(join(dir, 'dist'))) symlinkSync(join(REPO, 'dist'), join(dir, 'dist'));
  return dir;
}

function linkNodeModules(dir) {
  const nm = join(REPO, 'node_modules');
  if (!existsSync(nm)) throw new Error(`${nm} 还没装，先 npm install`);
  const mine = join(dir, 'node_modules');
  mkdirSync(mine, { recursive: true });
  for (const name of readdirSync(nm)) {
    // .vite 是开发服务器的依赖缓存：不链，让它在副本里自己长一份
    if (name === '.vite') continue;
    // 复用的副本里链子已经在了：撞 EEXIST 就是「链过了」，跳过
    try {
      symlinkSync(join(nm, name), join(mine, name));
    } catch {
      /* 已有一条 */
    }
  }
}

/**
 * 把仓库的源码整个盖回副本：只补单个文件会被上一把刀的伤口连坐。
 * 要盖的不止 `src/`——桌面外壳那两文件（`desktop/`）也架着刀，漏了它下一把刀就砍在上一把的伤口上。
 */
export function syncSrc(dir) {
  for (const sub of ['src', 'desktop']) {
    if (existsSync(join(REPO, sub))) execFileSync('rsync', ['-a', '--delete', `${REPO}/${sub}/`, `${dir}/${sub}/`]);
  }
  // 副本那份存档是上一场冒烟坐过的椅子：不清就卡在「这把椅子坐了人」，跑不到要量的那一段
  if (existsSync(join(dir, 'table.json'))) rmSync(join(dir, 'table.json'));
}

/** 临时目录只收自己造的：路径不在系统临时目录下、或者不带这个前缀，就别删 */
export function dropScratch(dir) {
  if (!dir.startsWith(join(tmpdir(), 'chess-'))) throw new Error(`这不是冒烟造的临时目录，不删：${dir}`);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * 清掉所有缓存的副本（knives 的 `--drop`）。副本平时常驻复用不自动删——
 * 想把「建了不删」的账一把清掉时跑它；只收 `chess-` 前缀的，别的照样不碰。
 */
export function dropAllScratch() {
  const gone = [];
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('chess-')) continue;
    rmSync(join(tmpdir(), name), { recursive: true, force: true });
    gone.push(name);
  }
  return gone;
}

/**
 * 收尾按端口把进程插干净：`child.kill()` 只杀得掉 npm 那层壳，坐在端口上的那层 node 还活着，
 * 下一场测量就打在它身上（旧代码）。在 node 里按 PID 收，不借 shell 的 kill。
 */
export function killPort(port) {
  const killed = [];
  for (const proto of ['tcp', 'udp']) {
    for (const pid of (proto === 'tcp' ? tcpPids(port) : udpPids(announcePort(port)))) {
      try {
        process.kill(Number(pid), 'SIGKILL');
        killed.push(`${proto}:${pid}`);
      } catch {
        /* 已经退了 */
      }
    }
  }
  return killed;
}
