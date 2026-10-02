import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { entryUrl, hostArgs, portCandidates, selftestOk, stripTypeFlags, whoamiUrl } from './launch.ts';

/**
 * 桌面外壳：这个进程自己不端界面，而是把 `src/node/host.ts` 那一桌当子进程拉起来，
 * 窗口开的是它 `http://127.0.0.1:端口/`——于是同源、同网寻呼、二维码那整条路都跟浏览器里一模一样，
 * 桌面版一个字都不用改界面（要手填地址的是 APK 那头，因为 WebView 起不了桌）。
 * 走子进程而不是 import 进来，是为了不碰 host.ts 那句 `process.argv.slice(2)` 和它的退出码：
 * 主进程要是被那桌带着 exit，窗口就没机会说「这桌起不来」。
 *
 * 判断都在 launch.ts（那边有闸），这个文件只管 Electron 那几件事：起子进程、等它开口、开窗口、收尾。
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** 开发时外壳跟仓库同一份；装进包之后 src/ 和 dist/ 在 resources/app 底下（electron-builder 的 extraResources） */
const ROOT = app.isPackaged ? join(process.resourcesPath, 'app') : join(HERE, '..');
const HOST_TS = join(ROOT, 'src', 'node', 'host.ts');
const READY_MS = 15_000;

const selftest = process.argv.some((a) => a === '--selftest' || a === '--selftest=1');

let child: ChildProcess | null = null;

app.whenReady().then(async () => {
  if (!existsSync(HOST_TS) || !existsSync(join(ROOT, 'dist', 'index.html'))) {
    console.error(`桌面上这桌开不起来：找不到 ${HOST_TS} 或 ${join(ROOT, 'dist', 'index.html')}（先 npm run build）`);
    app.exit(1);
    return;
  }
  const port = await freePort();
  if (!port) {
    console.error(`5200 往后 ${portCandidates().length} 个端口都被占着：先关掉一张桌，或者别在开满端口的机器上跑桌面版`);
    app.exit(1);
    return;
  }
  const proc = startHost(port);
  child = proc;
  if (!(await waitReady(proc, port))) {
    console.error('那张桌没起来（子进程那句原因打在终端上）。常见的一种：这份存档正被另一张桌占着。');
    stopHost();
    app.exit(1);
    return;
  }
  if (selftest) {
    const page = await fetchText(entryUrl(port));
    const whoami = await fetchText(whoamiUrl(port));
    const ok = selftestOk(page, whoami);
    console.log(
      ok
        ? `桌面自测：桌起来了、界面端出去了（端口 ${port}）——界面在窗口里点不点得通，这一条量不到`
        : `桌面自测红了：页面 ${page.status}、whoami ${whoami.status}`,
    );
    stopHost();
    app.exit(ok ? 0 : 1);
    return;
  }
  const win = new BrowserWindow({ width: 1280, height: 860, title: '棋墩墩' });
  win.setMenuBarVisibility(false);
  await win.loadURL(entryUrl(port));
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', stopHost);

function startHost(port: number): ChildProcess {
  // ELECTRON_RUN_AS_NODE 让同一个二进制当 Node 用：装进包里之后没有别的 Node 可依赖
  const args = [...stripTypeFlags(process.allowedNodeEnvironmentFlags), HOST_TS, ...hostArgs(app.getPath('userData'), port)];
  return spawn(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

function stopHost(): void {
  // SIGTERM 走的是 host.ts 那个 quit()：先把这一桌存进存档再退，别硬杀
  child?.kill('SIGTERM');
  child = null;
}

/** host.ts 绑的是 0.0.0.0，所以试端口也得照那个绑法试，不然 127.0.0.1 上看着空、其实有人 */
function freePort(): Promise<number | null> {
  const list = portCandidates();
  return list.reduce<Promise<number | null>>(
    (prev, port) =>
      prev.then(
        (found) =>
          found ??
          new Promise<number | null>((res) => {
            const srv = createServer();
            srv.once('error', () => res(null));
            srv.once('listening', () => srv.close(() => res(port)));
            srv.listen(port, '0.0.0.0');
          }),
      ),
    Promise.resolve(null),
  );
}

function waitReady(proc: ChildProcess, port: number): Promise<boolean> {
  const deadline = Date.now() + READY_MS;
  return new Promise<boolean>((res) => {
    // 那桌自己走了（占不着存档那条最常见）：它的理由早打在终端上了，别对着一台没动静的机器干等满 15 秒。
    // 桌起来之后这句不会再有事——promise 落定过一次就不改，SIGTERM 收尾那次 exit 正好落空。
    proc.once('exit', () => res(false));
    const tick = (): void => {
      const req = get(whoamiUrl(port), (r) => {
        r.resume();
        if (r.statusCode === 200) {
          res(true);
          return;
        }
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1000, () => req.destroy());
    };
    const retry = (): void => {
      if (Date.now() > deadline) {
        res(false);
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

function fetchText(url: string): Promise<{ status: number; body: string }> {
  return new Promise((res) => {
    const req = get(url, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (chunk: string) => (body += chunk));
      r.on('end', () => res({ status: r.statusCode ?? 0, body }));
    });
    req.on('error', () => res({ status: 0, body: '' }));
    req.setTimeout(3000, () => req.destroy());
  });
}
