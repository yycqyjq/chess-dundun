/**
 * b13（批8-A 端 dist 那一段）的刀谱：3 把，全在 src/node/serve.ts。
 * 原文手抄自 recovered/run-knives-b13.mjs 的第 17、18、19 刀；同批那四把 gate／协议的在 room-gate.mjs。
 */
export default {
  id: 'serve-gate',
  title: '端 dist 那一段不许把房主进程带走：转义抛错、目录穿越、拿目录当文件',
  via: 'test',
  suite: 'test:discover',
  knives: [
    {
      rel: 'src/node/serve.ts',
      note: '17 转义写歪不兜（这一抛原来就把房主进程带走）',
      from: "  try {\n    path = decodeURIComponent(url.split('?')[0] ?? '');\n  } catch {\n    return null;\n  }",
      to: "  path = decodeURIComponent(url.split('?')[0] ?? '');",
      expect: "歪转义不该把 fileFor 抛穿",
    },
    {
      rel: 'src/node/serve.ts',
      note: '18 目录穿越那道闸拆掉（/../secretx 一路翻到 dist 外）',
      from: "  if (full !== dist && !full.startsWith(dist + sep)) return null;",
      to: '  // 拆了：算出什么就是什么',
      expect: '出得去就回 null',
    },
    {
      rel: 'src/node/serve.ts',
      note: '19 是不是文件不查（拿目录当文件端出去）',
      from: '    return statSync(full).isFile() ? full : null;',
      to: '    return full;',
      expect: '拿目录当文件也不给',
    },
  ],
};
