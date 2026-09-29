/**
 * 冒烟的启动器：抄一份干净仓库到临时目录，真起一桌，等横幅出来，再把 `tools/online-smoke.mjs` 接上去跑。
 *
 *   npm run smoke                     # host + dev 各跑一场
 *   npm run smoke:host                # 只跑 npm run host（端 dist/，改过界面要先 npm run build）
 *   npm run smoke:dev                 # 只跑 npm run dev（Vite 直发源码，顺带把那张桌挂在同源端口上）
 *   npm run smoke:host -- --port=5345 --no-discover --keep
 *
 * 两道硬前提，都是踩过坑换来的：
 * ① 端口必须真空着——留着的孙进程会让整场测量打在旧代码上，假绿一场；
 * ② 收尾按端口把坐在上面的进程一起插干净（npm 那层壳 kill 掉了，node 那层还坐在端口上）。
 *
 * `--dir=<副本>` 是给 `tools/knife.mjs` 用的：那一层已经自己抄好、并且改了一处源码，
 * 这儿就绝不能再抄一份，否则量的还是没动过的那份，刀就白下了。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { announcePort, dropScratch, killPort, makeScratch, pickPort, slotOf, tcpPids, udpHeld } from './lib.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)));
const SMOKE = join(HERE, 'online-smoke.mjs');
/** host 等横幅里那句 Ctrl-C，dev 只等端口起来——Vite 那几句的顺序不作数 */
const READY = { host: 'Ctrl-C', dev: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起一桌跑一场冒烟。返回退出码和整段输出（判红要同时看退出码**和**那句专属断言文案）。
 * `discover` 是这桌有没有开寻呼：关着的话量的是「寻不到桌」那一句兜底回话。
 */
export async function smokeOnce({ kind = 'host', port = null, dir = null, discover = true, keep = false, label = '' } = {}) {
  const own = dir === null;
  const cwd = dir ?? makeScratch(kind);
  const http = port ?? pickPort({ discover });
  try {
    if (tcpPids(http).length) throw new Error(`端口 ${http} 上还坐着别人（PID ${tcpPids(http).join(' ')}），换个端口再量`);
    if (discover && udpHeld(announcePort(http))) throw new Error(`UDP ${announcePort(http)}（第 ${slotOf(http)} 槽）已经有人守着：别拿别人的答话当自己的`);
    if (kind === 'host' && !existsSync(join(cwd, 'dist', 'index.html'))) throw new Error('副本里没有 dist/，先 npm run build');

    const args =
      kind === 'host'
        ? ['run', 'host', '--', `--port=${http}`, '--players=2', '--fresh', ...(discover ? [] : ['--no-discover'])]
        : ['run', 'dev', '--', '--port', String(http), ...(discover ? [] : ['--no-discover'])];
    const child = spawn('npm', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const keep2 = (b) => (log += b);
    child.stdout.on('data', keep2);
    child.stderr.on('data', keep2);
    child.on('exit', (code, sig) => (log += `\n[壳退场 code=${code} sig=${sig}]\n`));

    // 最多等 30 秒：桌起不来就直接把日志尾巴吐出来，别让人对着一个 0 条的冒烟猜
    let ready = false;
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) break;
      if (READY[kind] ? log.includes(READY[kind]) : tcpPids(http).length > 0) {
        ready = true;
        break;
      }
      await sleep(150);
    }
    if (!ready) throw new Error(`桌没起来（${kind}@${http}）：\n${log.slice(-1200)}`);
    console.log(`\n· ${label || kind}@${http}（副本 ${cwd}）横幅里的寻呼那几句：\n${bannerLines(log)}`);

    let code = 0;
    let out = '';
    // --dir 是副本根：散桌那一段要对着硬盘量「这份存档真没了」，量的一直是这一份，绝不是他自己那间仓库里的
    const smoke = spawn('node', [SMOKE, `--port=${http}`, `--dir=${cwd}`, ...(discover ? [] : ['--no-discover'])], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    smoke.stdout.on('data', (b) => (out += b));
    // 等 close 不等 exit：不等 stdout 排空，最后那几句断言会被截掉
    await new Promise((r) => smoke.on('close', (c) => ((code = c ?? 1), r())));
    return { code, out, port: http, dir: cwd, log, passed: count(out, '✓'), failed: count(out, '✗') };
  } finally {
    killPort(http);
    if (own && !keep) dropScratch(cwd);
  }
}

function bannerLines(log) {
  const lines = log.split('\n').filter((l) => l.includes('寻') || l.includes('存档') || l.includes('whoami'));
  return lines.length ? lines.join('\n') : '  （横幅里没提寻呼，跟这桌的开法有关）';
}

const count = (text, mark) => text.split('\n').filter((l) => l.trim().startsWith(mark)).length;

/** 一场冒烟的收口：把红的逐条打出来，绿的只报个总数 */
function report(r) {
  const red = r.out.split('\n').filter((l) => l.trim().startsWith('✗'));
  if (red.length) console.log(red.join('\n'));
  console.log(`${r.passed} 条通过｜${r.failed} 条红｜退出码 ${r.code}`);
  return r.code === 0 && r.failed === 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const kinds = argv.filter((a) => !a.startsWith('--'));
  const port = argv.find((a) => a.startsWith('--port='))?.split('=')[1];
  const dir = argv.find((a) => a.startsWith('--dir='))?.split('=')[1] ?? null;
  const discover = !argv.includes('--no-discover');
  const keep = argv.includes('--keep');
  const want = kinds.length ? kinds : ['host', 'dev'];
  if (dir && want.length > 1) throw new Error('--dir=<副本> 一次只跑一种：那是给刀用的');

  let bad = 0;
  for (const kind of want) {
    if (!['host', 'dev'].includes(kind)) throw new Error(`只认 host／dev，收到 ${kind}`);
    // 同一时间只跑一桌：两场挤在一起会抢同一块网的寻呼答话，谁的清单都数不清
    const r = await smokeOnce({ kind, port: port ? Number(port) : null, dir, discover, keep });
    console.log(`\n${kind}@${r.port}：`);
    if (!report(r)) bad++;
  }
  console.log(bad ? `\n${bad} 场冒烟没过\n` : `\n${want.length} 场冒烟全过\n`);
  process.exit(bad ? 1 : 0);
}

// 直接跑才办事；被 knife.mjs import 时只交出 smokeOnce。
// npm 传进来的常是相对路径，所以两头都归到绝对路径再比
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
