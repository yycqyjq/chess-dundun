/**
 * 断线重连的现状快照该解开等待：两句口径一句都不能少（批7，捞回自 b9 A–D，四把共用 src/web/net.ts:101 那一句）。
 * from／to 是从会话记录里捞回的原文逐字搬的（2026-09-28），expect 是跑出来抄回去的红字，不是凭记忆写的。
 * 跑法：npm run knives -- wake（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: "wake",
  title: "断线重连的现状快照该解开等待：两句口径一句都不能少（批7，捞回自 b9 A–D，四把共用 src/web/net.ts:101 那一句）",
  via: "test",
  suite: "test:link",
  knives: [
    {
      rel: "src/web/net.ts",
      note: "A 一句都不解（冻屏原样回来）",
      from: "  return m.last === null || m.acts.length === 0;",
      to: "  return false;",
      expect: "既没要演的手、也不该我出：更要解",
    },
    {
      rel: "src/web/net.ts",
      note: "B 什么都解（扣棋里别人那一手提前演给我看）",
      from: "  return m.last === null || m.acts.length === 0;",
      to: "  return true;",
      expect: "别人落的一手、还该我出：照旧攒着，别提前演",
    },
    {
      rel: "src/web/net.ts",
      note: "C 丢掉「不该我出」那半（这一手作废了还死等）",
      from: "  return m.last === null || m.acts.length === 0;",
      to: "  return m.last === null;",
      expect: "已经不该我出：哪怕带着要演的手也得解",
    },
    {
      rel: "src/web/net.ts",
      note: "D 丢掉「现状变了」那半（正是这次撞到的：对面重连回来这边还挂着掉线）",
      from: "  return m.last === null || m.acts.length === 0;",
      to: "  return m.acts.length === 0;",
      expect: "只是现状变了",
    },
  ],
};
