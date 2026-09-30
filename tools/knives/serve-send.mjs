/**
 * 「dist 那头怎么端出去」的刀谱（2026-09-30：覆盖对账查出 `serve.ts::sendFile`／`notFound` 一份测试都没引用过）。
 *
 * `fileFor`／`mimeOf` 那一半早有 16 条断言（含目录穿越那三条），可「算出路径之后怎么端」这一半只剩冒烟顺带跑到，
 * 而冒烟只看得到 happy path：读不出来的文件当场抛穿是**整个房主进程没了、全桌掉线**那一档
 * （`host.ts` 是 `createServer(serve)`，`serve()` 里没有 try，抛出来就逃出 http 回调）。
 * 现在拿一个假 `ServerResponse`（只记状态码／头／end 的正文和次数，`record()` 自己接住抛的错再记一条 ✗，
 * 沿用 `fileFor` 那两条歪转义的同一种写法）敲它，9 条断言全在 `test:discover` 里跑。
 *
 * 五处说明（2026-09-30 逐把实测，红字条数抄自 `npm run knives -- serve-send --verbose`）：
 * ① 红数 A 4／B 1／C 2／D 3／E 2／F 2／G 1／H 1。A（整个 catch 摘掉）一个人点亮 4 句是这一族的常态：
 *    500 那一路全由那个 catch 产生，摘掉它，「不许抛穿」「回 500」「end 一次」「目录也不许抛」全塌。
 *    所以每把只钉自己那句名字对得上错法的红字，重叠处在此写明。
 * ② D 摘的是 500 那句后面的 `return;`，后果是真测的：本机 Node v24.18.0 上拿真 `ServerResponse` 走一遍
 *    「writeHead(500)→end→writeHead(200)」⇒ 第二步抛 **ERR_HTTP_HEADERS_SENT**（`/private/tmp/headtwice.mjs`，一次性 127.0.0.1 随机端口，客户端只收到第一句）。
 *    假 res 量的是「多端了一遍」这件事本身，真 res 上那一抛逃出 http 回调＝上面说的那一档。
 * ③ C（500 写成 404）红 2 条：那句跟「拿目录当文件端出去」都认 `code === 500`——两回事别让一句挡，
 *    「没这个文件」是 404、「这会儿读不出来」是 500，混了就等于把 build 中途的坏消息说成好话。
 * ④ E 会连带点亮 09-28 就有的那句「没后缀不瞎猜」：同一句判据两处用，不算它红得没道理。
 * ⑤ no-store 那句的后果写清楚：build 出来的 js／css 都带 hash，唯独 `index.html` 名字不变，
 *    浏览器要是缓存了它，重新 build 之后端出去的还是旧页面。
 *
 * 跑法：npm run knives -- serve-send（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'serve-send',
  title: '端一个文件出去：状态码、类型、no-store、还有「读不出来不许把宿主抛穿」',
  via: 'test',
  suite: 'test:discover',
  knives: [
    {
      rel: 'src/node/serve.ts',
      note: 'A 读文件那圈 try／catch 整个拆掉（读不了就抛穿）',
      from:
        "  let body: Buffer;\n  try {\n    body = readFileSync(file);\n  } catch {\n    res.writeHead(500, { 'content-type': 'text/plain; charset=utf8' });\n    res.end('这个文件这会儿读不出来');\n    return;\n  }",
      to: '  const body = readFileSync(file);',
      expect: '文件这会儿读不出来那一路不许把宿主抛穿',
    },
    {
      rel: 'src/node/serve.ts',
      note: 'B no-store 摘掉（浏览器拿旧的 index.html）',
      from: "  res.writeHead(200, { 'content-type': mimeOf(file), 'cache-control': 'no-store' });",
      to: "  res.writeHead(200, { 'content-type': mimeOf(file) });",
      expect: '每份都带 no-store',
    },
    {
      rel: 'src/node/serve.ts',
      note: 'C 读不出来当成「没这个文件」（500 写成 404）',
      from: "    res.writeHead(500, { 'content-type': 'text/plain; charset=utf8' });",
      to: "    res.writeHead(404, { 'content-type': 'text/plain; charset=utf8' });",
      expect: '读不出来的文件回 500、正文那句念得出人话',
    },
    {
      rel: 'src/node/serve.ts',
      note: 'D 500 那句写完没 return（接着往下又端一遍 200）',
      from: "    res.end('这个文件这会儿读不出来');\n    return;",
      to: "    res.end('这个文件这会儿读不出来');",
      expect: '500 那句写完就收：end 只调一次',
    },
    {
      rel: 'src/node/serve.ts',
      note: 'E 后缀认不出的拿 text/plain 糊过去',
      from: "  return MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream';",
      to: "  return MIME[file.slice(file.lastIndexOf('.'))] ?? 'text/plain; charset=utf8';",
      expect: '后缀认不出的文件照样端得出去，类型给 octet-stream',
    },
    {
      rel: 'src/node/serve.ts',
      note: 'F 正文忘了给（端出去一个空文件）',
      from: '  res.end(body);',
      to: '  res.end();',
      expect: '读得出来的文件：200、正文是文件自己那几字节、end 只调一次',
    },
    {
      rel: 'src/node/serve.ts',
      note: 'G MIME 表里 .html 那条摘掉（首页端成下载）',
      from: "  '.html': 'text/html; charset=utf8',",
      to: '',
      expect: '类型跟着后缀走（.html 别端成下载）',
    },
    {
      rel: 'src/node/serve.ts',
      note: 'H 认不出那串 URL 也回 200（空页当首页端）',
      from: "  res.writeHead(404, { 'content-type': 'text/plain; charset=utf8' });",
      to: "  res.writeHead(200, { 'content-type': 'text/plain; charset=utf8' });",
      expect: '认不出那串 URL：404＋一句「没这个文件」，一句就完事',
    },
  ],
};
