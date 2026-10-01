/**
 * 进门落哪一屏，看的是地址上那句「我是来入桌的」（2026-09-30 他另一台机器敲开裸地址被直接按进候场厅）。
 * 原来量的是 host 是不是本机——那只说明人不是在自家电脑上打开页面，不说明他来干什么。
 * 于是邀请那一头（列表里那一条、房主进程报的局域网地址、二维码、别的设备上的 origin）统一带上 ?join=1，
 * 拼法收在 httpUrl 一份里，认的那一份在 home.ts::wantsJoin。
 * A 钉「认」那一头只死认 1；B 钉「没开口」那三种写法漏了；C 钉大小写；
 * D 钉「拼」那一头丢了标记；E 钉 roomUrl 绕开 httpUrl 自己拼一份（两处拼法漂开）。
 * 跑法：npm run knives -- join-marker（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'join-marker',
  title: '入桌那句意图：拼的那一头和认的那一头是同一句话',
  via: 'test',
  suite: 'test:ui',
  knives: [
    {
      rel: 'src/web/home.ts',
      note: 'A 只认 ?join=1：只写个 ?join、写成 yes 的（都是我们自己会拼出来的那条路的邻居）就不认了',
      from: '  return v !== null && !NOT_JOIN.has(v.toLowerCase());',
      to: "  return v === '1';",
      expect: '带着 join 的那几条直落候场厅',
    },
    {
      rel: 'src/web/home.ts',
      note: 'B 「没开口」那三种写法一张清单都没有：?join=0 也把人按进候场厅',
      from: "const NOT_JOIN = new Set(['0', 'false', 'no']);",
      to: 'const NOT_JOIN = new Set<string>([]);',
      expect: 'join 写成 0／false／no 才算没开口',
    },
    {
      rel: 'src/web/home.ts',
      note: 'C 不折大小写：浏览器把 query 原样递过来，写成 NO 的那条就不算没开口了',
      from: '  return v !== null && !NOT_JOIN.has(v.toLowerCase());',
      to: '  return v !== null && !NOT_JOIN.has(v);',
      expect: 'join 写成 0／false／no 才算没开口',
    },
    {
      rel: 'src/net/discover.ts',
      note: "D 递给人敲的那条地址干脆不带标记：点列表里一条，浏览器落到首页，人还得再点一次「本地联机」",
      from: '  return `http://${ip}:${port}/${JOIN_QUERY}`;',
      to: '  return `http://${ip}:${port}/`;',
      expect: '那条地址带着入桌那个标记',
    },
    {
      rel: 'src/net/discover.ts',
      note: 'E roomUrl 绕开 httpUrl 自己拼一份：两处拼法从此各走各的，邀请那头照样带标记、列表这条丢了',
      from: '  return httpUrl(f.ip, f.port);',
      to: '  return `http://${f.ip}:${f.port}/`;',
      expect: '那条地址带着入桌那个标记',
    },
  ],
};
