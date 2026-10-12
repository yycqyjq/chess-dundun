/**
 * 口径卫生（2026-10-12 第二轮排查量到的三条，只报不改过一阵，用户点头「清吧」后一起修）：
 *   A `package.json` 里同一个脚本键写两遍——JSON 认后一个，前一个静默失效，照前一个理解的人就被带沟里了；
 *   B `host.ts` 没接 `listen` 那条 error——端口被占时甩的是裸栈，从访达点开的人屏幕上什么都不出现；
 *   C `discover.ts` 那次 error 里只把 socket 置空、不 close——底下 `close()` 拿到的已是 null，这条 dgram socket 再没人关。
 * 三条断言都住在 `src/test/style.test.ts`（源码级：读文件本身写了什么），所以走 `test:style`。
 * `expect` 从 `npm run knives -- housekeeping --verbose` 的实际红字抄回。
 */
export default {
  id: 'housekeeping',
  title: '口径卫生：起桌失败撂人话、寻呼那次错误不漏 socket、脚本键别写两遍',
  via: 'test',
  suite: 'test:style',
  knives: [
    {
      rel: 'package.json',
      note: 'A 脚本键写两遍：后一个静默顶掉前一个，读的人照前一个理解就是错的',
      from: '    "release": "node tools/release.mjs",',
      to: '    "release": "node tools/release.mjs",\n    "release": "node tools/release.mjs",',
      expect: 'package.json 里 "release" 这个键只出现一次（写两遍时后一个静默顶掉前一个）',
    },
    {
      rel: 'src/node/host.ts',
      note: "B 摘掉 listen 那条 error：端口被占（同机另一张桌、或者别的进程）时甩一串裸栈，从访达点开的人屏幕上什么都不出现",
      from: "server.on('error', (e: NodeJS.ErrnoException) => {",
      to: "server.on('nope', (e: NodeJS.ErrnoException) => {",
      expect: 'host.ts 接了 listen 那条 error：端口被占时不是甩一串裸栈',
    },
    {
      rel: 'src/node/discover.ts',
      note: 'C 那次 error 里只置空不 close：这条 dgram socket 再没人关（一次错误漏一条）',
      from: '      try {\n        s.close();\n      } catch {',
      to: '      try {\n        /* 不关了：只把引用撒手 */\n      } catch {',
      expect: '寻呼那次的错误里先 s.close() 再置空：只置空就再没人关这条 socket 了',
    },
  ],
};
