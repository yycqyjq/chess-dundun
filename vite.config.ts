import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { openRoom, type Room } from './src/node/room.ts';

/** 只把版本号那一个字符串注进 bundle，首页底部那一行用它 */
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * 把那张牌桌直接挂进开发服务器：npm run dev 一条命令就能联机，不用再单开一个
 * npm run host——页面和 /ws 同源于这个端口，终端印出来的那条局域网地址扫开就是候场厅。
 * host 那边还留着：那是「不装开发工具、只端 dist/」的跑法。
 */
function tableRoom(): Plugin {
  let room: Room | null = null;
  return {
    name: 'chess-dundun-table',
    configureServer(server: ViteDevServer) {
      room = openRoom(process.argv.slice(2), Number(server.config.server.port));
      // GET /whoami 排在 Vite 自己的中间件前面：这条路径 Vite 本来也没有，占不着谁
      server.middlewares.use((req, res, next) => {
        if (!room?.handleHttp(req, res)) next();
      });
      server.httpServer?.on('upgrade', (req, socket, head) => {
        room?.handleUpgrade(req, socket, head); // 不是 /ws 的一条字节不碰，留给 Vite 自己的 HMR
      });
      server.httpServer?.once('close', () => room?.close());
      // 服务器起来了再补这几行（实测排在 Vite 那条 Local/Network 前面，看两遍地址别奇怪）
      return () => {
        const urls = room?.inviteUrls() ?? [];
        console.log(`  牌桌就挂在这个服务器上，存档 ${room?.savePath}；别的设备打开下面那条局域网地址就是候场厅。`);
        console.log(
          urls.length
            ? `  局域网地址：${urls.join('  ')}`
            : '  没找到局域网地址：这台机器好像没连上路由器',
        );
        const d = room?.discovery;
        console.log(
          d?.on
            ? `  同网寻呼守 UDP ${d.port}：候场厅按「找同网的桌」往这块网问一圈。`
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
  build: { outDir: 'dist', target: 'es2022' },
  // 5173 被本机另一个项目（pocket-kit）占着，这里钉死一个不撞车的端口
  server: { host: true, port: 5199, strictPort: true },
  plugins: [tableRoom()],
});
