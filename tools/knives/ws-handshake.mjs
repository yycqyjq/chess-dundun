/**
 * 握手那道：分片拼起来也有上限、Origin 要认、默认端口要摊平（安全批 A5，捞回自 b11 1–3）。
 * from／to 是从会话记录里捞回的原文逐字搬的（2026-09-28），expect 是跑出来抄回去的红字，不是凭记忆写的。
 * 跑法：npm run knives -- ws-handshake（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: "ws-handshake",
  title: "握手那道：分片拼起来也有上限、Origin 要认、默认端口要摊平（安全批 A5，捞回自 b11 1–3）",
  via: "test",
  suite: "test:net",
  knives: [
    {
      rel: "src/net/ws.ts",
      note: "1 分片拼起来不设上限（A5：内存想涨多少涨多少）",
      from: "    if (frag.bytes > MAX_MESSAGE) return this.bail('分片拼起来也超限');",
      to: "    // 拆了：拼到多少都接着攒",
      expect: "分片拼起来超限就掐",
    },
    {
      rel: "src/net/ws.ts",
      note: "2 Origin 那道闸整个拆掉（别人家的页面也握得上手）",
      from: "    if (origin !== undefined && hostPart(origin) !== hostPart(req.headers.host ?? '')) {",
      to: "    if (origin !== undefined && false) {",
      expect: "Origin 不是这一桌的，握手直接回 403",
    },
    {
      rel: "src/net/ws.ts",
      note: "3 比 Origin 时不摊平默认端口（:80 对不上 Host，自己人也被拒）",
      from: "  return (s.split('/')[0] ?? '').toLowerCase().replace(/:(80|443)$/, '');",
      to: "  return (s.split('/')[0] ?? '').toLowerCase();",
      expect: "Origin 带默认端口、Host 不带：摊平了算同一个",
    },
  ],
};
