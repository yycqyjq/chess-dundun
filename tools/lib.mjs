/**
 * 冒烟和刀共用那几件事：抄一份干净的仓库、挑一个真空着的端口、收尾把坐在端口上的进程插干净。
 *
 * 为什么非得抄一份：`src/node/room.ts` 一开桌就往存档上写（`openRoom` 里那句 `write()`），
 * 而默认存档就是仓库根的 `table.json`——那可能是他正在打的那一桌。
 * 所以任何一场冒烟、任何一把刀都只在临时目录里跑，量完就扔，一笔都不许落在他家硬盘上。
 *
 * `node_modules` 不整份搬（54M，每把刀搬一次太蠢），也不整条软链接（那样 Vite 的 `.vite` 缓存会写进
 * 他那个 `node_modules`）：在副本里开一个真目录，一个一个软链过去，`.vite` 就落在副本里。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
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

const NOT_COPIED = ['--exclude=node_modules', '--exclude=.git', '--exclude=dist', '--exclude=table.json', '--exclude=*.log', '--exclude=.DS_Store'];

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

/** 抄一份干净仓库到临时目录；`dist` 端的是仓库现在那份，改过界面要先 `npm run build` */
export function makeScratch(label = 'run') {
  const dir = mkdtempSync(join(tmpdir(), `chess-${label}-`));
  execFileSync('rsync', ['-a', ...NOT_COPIED, `${REPO}/`, `${dir}/`]);
  linkNodeModules(dir);
  if (existsSync(join(REPO, 'dist'))) symlinkSync(join(REPO, 'dist'), join(dir, 'dist'));
  return dir;
}

function linkNodeModules(dir) {
  const nm = join(REPO, 'node_modules');
  if (!existsSync(nm)) throw new Error(`${nm} 还没装，先 npm install`);
  const mine = join(dir, 'node_modules');
  mkdirSync(mine);
  for (const name of readdirSync(nm)) {
    // .vite 是开发服务器的依赖缓存：不链，让它在副本里自己长一份
    if (name === '.vite') continue;
    symlinkSync(join(nm, name), join(mine, name));
  }
}

/** 把仓库的 src 整个盖回副本：只补单个文件会被上一把刀的伤口连坐 */
export function syncSrc(dir) {
  execFileSync('rsync', ['-a', '--delete', `${REPO}/src/`, `${dir}/src/`]);
  // 副本那份存档是上一场冒烟坐过的椅子：不清就卡在「这把椅子坐了人」，跑不到要量的那一段
  if (existsSync(join(dir, 'table.json'))) rmSync(join(dir, 'table.json'));
}

/** 临时目录只收自己造的：路径不在系统临时目录下、或者不带这个前缀，就别删 */
export function dropScratch(dir) {
  if (!dir.startsWith(join(tmpdir(), 'chess-'))) throw new Error(`这不是冒烟造的临时目录，不删：${dir}`);
  rmSync(dir, { recursive: true, force: true });
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
