import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { openRoom, type Room } from './src/node/room.ts';

/** 只把版本号那一个字符串注进 bundle，首页底部那一行用它 */
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * 把那张牌桌直接挂进开发服务器：npm run dev 一条命令就能联机，不用再单开一个
 * npm run host——页面和 /ws 同源于这个端口，终端印出来的那条局域网地址扫开就是候场厅。
 * host 那边还留着：那是「不装开发工具、只端 dist/」的跑法。
 *
 * 重启怎么算（2026-10-12 探针量的）：vite 改配置重启时**先建新 server、再关旧 server**，
 * configureServer 会再跑一趟。桌跟的是配置不是 server 实例——端口没变就把**同一张桌**
 * 接给新 server 接着用（改配置重启牌局还在，存档锁也只占一趟，不存在前后两桌抢同一份）；
 * 端口变了才收旧开新。每张 httpServer 的收尾只认**自己这一代**的代号：
 * 旧 server 关闭那一刻 live 已经记成新的一代，就别去收新 server 正用着的那张桌——
 * 原来的写法 `once('close', () => room?.close())` 摸的是外层变量，重启时那变量已经被
 * 后一趟覆盖，关掉的是新桌，旧桌的寻呼 socket 和存档闸从没人收。
 */
function tableRoom(): Plugin {
  /** 还活着的桌＋它的代数：configureServer 每跑一趟记一代，httpServer 收尾只认自己那一代 */
  let live: { room: Room; gen: number; port: number } | null = null;
  let genSeq = 0;
  return {
    name: 'chess-dundun-table',
    configureServer(server: ViteDevServer) {
      const gen = ++genSeq;
      const port = Number(server.config.server.port);
      // 端口没变就接回同一张桌（重启＝改配置，桌本身没理由换）；端口变了才收旧开新
      if (live && live.port !== port) {
        live.room.close();
        live = null;
      }
      const room = live?.room ?? openRoom(process.argv.slice(2), port);
      live = { room, gen, port };
      const http = server.httpServer;
      // GET /whoami 排在 Vite 自己的中间件前面：这条路径 Vite 本来也没有，占不着谁
      server.middlewares.use((req, res, next) => {
        if (!room.handleHttp(req, res)) next();
      });
      http?.on('upgrade', (req, socket, head) => {
        room.handleUpgrade(req, socket, head); // 不是 /ws 的一条字节不碰，留给 Vite 自己的 HMR
      });
      // 这张 httpServer 收尾只收自己这一代的桌：重启时旧 server 关闭，live 已记成下一代，这一手就落空
      http?.once('close', () => {
        if (live?.gen === gen) {
          room.close();
          live = null;
        }
      });
      // 服务器起来了再补这几行（实测排在 Vite 那条 Local/Network 前面，看两遍地址别奇怪）
      return () => {
        const urls = room.inviteUrls();
        console.log(`  牌桌就挂在这个服务器上，存档 ${room.savePath}；别的设备打开下面那条局域网地址就是候场厅。`);
        console.log(
          urls.length
            ? `  局域网地址：${urls.join('  ')}`
            : '  没找到局域网地址：这台机器好像没连上路由器',
        );
        const d = room.discovery;
        console.log(
          d?.on
            ? `  同网寻呼守 UDP ${d.port}：别的设备上同网桌列表那一页每五秒往这块网问一圈。`
            : '  同网寻呼没开：这台机器上寻不到别的桌，只能手动敲地址。',
        );
        console.log(`  人到位后由房主在候场厅按「开始这一局」；没坐的位子那一局由电脑补。\n`);
      };
    },
  };
}

export default defineConfig({
  // 相对路径：之后 Capacitor（安卓）和 Tauri/Electron（Win/Mac）都是把 dist 塞进壳里，绝对路径会白屏
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  // cssMinify: false 是**故意的，别顺手打开**（2026-10-14 查兼容）。
  // 客户端那条路的 CSS 压缩器是 lightningcss（Vite 8 的默认；本仓库压根没装 esbuild），
  // 它会把同一个规则里的四条 `top/right/bottom/left` **无条件折回 `inset` 简写**——
  // 实测 `{top:0;right:0;bottom:0;left:0;inset:0}` 压完只剩 `inset:0;inset:0`，手写的兜底整条没了；
  // `@supports not (inset:0){…}` 里照折，拿自定义属性隔开也照折，只有 `!important` 挡得住
  // （那会改级联语义，不能用）。而 `inset` 要 Chromium 87、这份代码的 JS 下限是 85
  // ⇒ 不关压缩，WebView 85/86 上覆盖层（`.sheet`／`.home`／`.drawer`）和棋子正反面当场没定位。
  // 代价只是 CSS 不压缩（gzip 3.98 KB → 12.1 KB，APK 5.9 MB／桌面包 100 MB 里可忽略），
  // 换「下限 85」这句话是真的。闸在 `src/test/style.test.ts` 的「CSS 压缩必须关着」那一节。
  build: { outDir: 'dist', target: 'es2022', cssMinify: false },
  // 5173 被本机另一个项目（pocket-kit）占着，这里钉死一个不撞车的端口
  server: { host: true, port: 5199, strictPort: true },
  plugins: [tableRoom()],
});
