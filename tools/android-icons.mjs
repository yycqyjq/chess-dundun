/**
 * 安卓图标：照 `public/icon.svg` 现画全套 mipmap（三种图 × 五档密度），别手改 `res/mipmap-*` 里那几张 PNG。
 *
 * 为什么不走 `npm run icon` 那条 qlmanage 的路：
 *   qlmanage 起的是系统缩略图服务，在受限环境里直接 `sandbox initialization failed: Operation not permitted`；
 *   ImageMagick 内置的 SVG 渲染器又读不了字（顶上那枚的「墩」当场 `unable to read font`）。
 *   仓库里本来就躺着 electron（`desktop:selftest` 用的就是它），拿它开一个离屏窗口把 SVG 画出来再截图，
 *   跟网页端／桌面端同一个渲染器——渐变、clipPath、中文都照原样，不必再引一个 SVG 光栅化库。
 *
 * 三种图：
 *   整图 `ic_launcher`            `public/icon.svg` 原样（圆角方）—— API 24/25 那些不吃自适应图标的桌面看这张；
 *   圆形 `ic_launcher_round`      同一份，圆角矩形换成圆；
 *   前景 `ic_launcher_foreground` 只留 `android-foreground` 两个标记之间的那两组（棋子摞 ＋「墩」），
 *                                 四周留透明，按 108 画布居中、缩到安全区（中心 66dp 圆）之内。
 * 底下那层是 `values/ic_launcher_background.xml` 里的颜色，跟这张前景配一对（原来那片 #FFFFFF 是「没图标」的正主）。
 *
 * 用法：`npm run icons:android`（要起 electron，得在能开 GUI 的终端里跑；沙箱里跑不动）
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO, run } from './lib.mjs';

/** 五档密度：legacy 那张以 48dp 为基准，自适应前景那张以 108dp 为基准 */
const DENSITIES = [
  { d: 'mdpi', legacy: 48, fg: 108 },
  { d: 'hdpi', legacy: 72, fg: 162 },
  { d: 'xhdpi', legacy: 96, fg: 216 },
  { d: 'xxhdpi', legacy: 144, fg: 324 },
  { d: 'xxxhdpi', legacy: 192, fg: 432 },
];

const FG_START = '<!-- android-foreground:start';
const FG_END = '<!-- android-foreground:end -->';
/**
 * 前景那一层：108 画布，图案居中、缩到安全区里。
 * 图案在 512 坐标里的外接半径是 150（顶、底那两个点，不是包围盒的角——棋子是椭圆摞，角上是空的），
 * 150 × 0.21 = 31.5 < 33（中心 66dp 圆的半径），四周还留 1.5dp 余量。
 */
const FG_BOX = 108;
const FG_SCALE = 0.21;
const FG_CENTER = { x: 256, y: 274 };

/** 切一刀必须见血：锚点对不上就当场抛，别默默产出一张歪图 */
function cut(text, from, to, what) {
  const a = text.indexOf(from);
  if (a < 0) throw new Error(`public/icon.svg 里找不到${what}：${from}`);
  const b = text.indexOf(to, a + from.length);
  if (b < 0) throw new Error(`public/icon.svg 里${what}后面找不到收尾：${to}`);
  return text.slice(a + from.length, b);
}

/** 一份 SVG → 三份（整图／圆形／前景） */
function variants(src) {
  const clipRect = '<rect width="512" height="512" rx="112"/>';
  const borderRect = '<rect width="512" height="512" rx="112" fill="none"';
  if (!src.includes(clipRect) || !src.includes(borderRect)) {
    throw new Error('public/icon.svg 的圆角矩形换写法了：图标脚本里那两处锚点要跟着改');
  }
  const round = src
    .replace(clipRect, '<circle cx="256" cy="256" r="256"/>')
    .replace(borderRect, '<circle cx="256" cy="256" r="254" fill="none"');

  const defs = cut(src, '<defs>', '</defs>', '<defs> 那一段');
  const art = cut(src, FG_START, FG_END, 'android-foreground 两个标记')
    .split('-->')
    .slice(1) // 起点那一行是注释本体，切掉它，只留后面那两组 <g>
    .join('-->')
    .trim();
  if (!art.includes('<ellipse') || !art.includes('墩')) {
    throw new Error('android-foreground 两个标记之间没夹着棋子摞：标记挪位置了？');
  }
  const fg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FG_BOX} ${FG_BOX}" role="img">`,
    '  <title>棋墩墩</title>',
    `  <defs>${defs}</defs>`,
    `  <g transform="translate(${FG_BOX / 2} ${FG_BOX / 2}) scale(${FG_SCALE}) translate(${-FG_CENTER.x} ${-FG_CENTER.y})">`,
    art,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
  return { full: src, round, fg };
}

/** 离屏窗口把 SVG 画出来再截图：force-device-scale-factor=1 是「1 CSS px = 1 像素」，Retina 上不写会出 2 倍图 */
const RENDERER = `const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
const jobs = JSON.parse(readFileSync(process.argv[2], 'utf8'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 900, height: 900, transparent: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.webContents.setZoomFactor(1);
  for (const j of jobs) {
    const svg = readFileSync(j.svg, 'utf8').replace(/<svg /, \`<svg width="\${j.size}" height="\${j.size}" \`);
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}' +
      'svg{display:block}</style></head><body>' + svg + '</body></html>';
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 200));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: j.size, height: j.size });
    writeFileSync(j.out, img.toPNG());
    console.log('wrote ' + j.out + '  ' + img.getSize().width + 'x' + img.getSize().height);
  }
  app.quit();
});
`;

/** PNG 的宽高就在 IHDR 里：8 字节签名 + 4 字节长度 + 'IHDR' + 宽 4 + 高 4。为这一件事不值得引个图像库 */
function pngSize(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('这不是一张 PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const iconSrc = readFileSync(join(REPO, 'public', 'icon.svg'), 'utf8');
const v = variants(iconSrc);

const work = mkdtempSync(join(tmpdir(), 'qdd-icons-'));
const appDir = join(work, 'app');
mkdirSync(appDir, { recursive: true });
writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'qdd-icon-shot', main: 'main.cjs' }));
writeFileSync(join(appDir, 'main.cjs'), RENDERER);

const svgPath = { full: join(work, 'full.svg'), round: join(work, 'round.svg'), fg: join(work, 'fg.svg') };
writeFileSync(svgPath.full, v.full);
writeFileSync(svgPath.round, v.round);
writeFileSync(svgPath.fg, v.fg);

const jobs = [];
for (const { d, legacy, fg } of DENSITIES) {
  jobs.push({ svg: svgPath.full, size: legacy, out: join(work, `ic_launcher.png.${d}`) });
  jobs.push({ svg: svgPath.round, size: legacy, out: join(work, `ic_launcher_round.png.${d}`) });
  jobs.push({ svg: svgPath.fg, size: fg, out: join(work, `ic_launcher_foreground.png.${d}`) });
}
const jobsFile = join(work, 'jobs.json');
writeFileSync(jobsFile, JSON.stringify(jobs));

// ELECTRON_RUN_AS_NODE=1 会把 electron 变成纯 node（这台机器的环境里就挂着这一条），
// 不摘掉它 require('electron') 当场 MODULE_NOT_FOUND；NODE_OPTIONS 里那个 shim 同理要摘。
const env = { ...process.env };
for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'BASH_ENV']) delete env[k];
const bin = join(REPO, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const r = run(bin, [appDir, jobsFile], { env });
if (r.code !== 0) {
  console.error(r.out);
  throw new Error(`electron 光栅化没跑成（退出码 ${r.code}）：留一份现场在 ${work}`);
}

let wrote = 0;
const res = join(REPO, 'android', 'app', 'src', 'main', 'res');
for (const { d, legacy, fg } of DENSITIES) {
  const dir = join(res, `mipmap-${d}`);
  const pairs = [
    [`ic_launcher.png.${d}`, 'ic_launcher.png', legacy],
    [`ic_launcher_round.png.${d}`, 'ic_launcher_round.png', legacy],
    [`ic_launcher_foreground.png.${d}`, 'ic_launcher_foreground.png', fg],
  ];
  for (const [from, to, want] of pairs) {
    const buf = readFileSync(join(work, from));
    const { w, h } = pngSize(buf);
    if (w !== want || h !== want) throw new Error(`${to}（${d}）画出来是 ${w}x${h}，该是 ${want}x${want}`);
    writeFileSync(join(dir, to), buf);
    wrote++;
  }
}
rmSync(work, { recursive: true, force: true });
console.log(`已按 public/icon.svg 重画 ${wrote} 张安卓图标（三种图 × 五档密度），落在 android/app/src/main/res/mipmap-*`);
console.log('自适应图标底下那层是 values/ic_launcher_background.xml 里那个颜色（跟前景配一对，别忘了改）');
