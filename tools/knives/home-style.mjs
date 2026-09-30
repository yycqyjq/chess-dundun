/**
 * 首页是盖住的一层、手机上竖排、入口热区够高（批6 的三处样式，捞回自 b8 A/B/C）。
 * from／to 是从会话记录里捞回的原文逐字搬的（2026-09-28），expect 是跑出来抄回去的红字，不是凭记忆写的。
 * 2026-09-30：A 那把的 `z-index` 跟着 `.home` 从 1900 换成 1950（那层不再跟复盘打平），刀口重跑过。
 * 跑法：npm run knives -- home-style（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: "home-style",
  title: "首页是盖住的一层、手机上竖排、入口热区够高（批6 的三处样式，捞回自 b8 A/B/C）",
  via: "test",
  suite: "test:style",
  knives: [
    {
      rel: "src/web/style.css",
      note: "A 首页不再是盖住的一层（position 改回 static，牌桌隔一层透上来）",
      from: "  position: fixed;\n  inset: 0;\n  z-index: 1950;",
      to: "  position: static;\n  inset: 0;\n  z-index: 1950;",
      expect: "它是盖住整块屏幕的一层",
    },
    {
      rel: "src/web/style.css",
      note: "B 手机上两条入口也横排（默认 flex-direction 写成 row）",
      from: ".home-entries {\n  display: flex;\n  flex-direction: column;",
      to: ".home-entries {\n  display: flex;\n  flex-direction: row;",
      expect: "两条入口默认竖着排",
    },
    {
      rel: "src/web/style.css",
      note: "C 入口热区退回普通按钮那一档高（72px → 40px）",
      from: "  min-height: 72px;\n  padding: 13px 15px;",
      to: "  min-height: 40px;\n  padding: 13px 15px;",
      expect: "入口那块比一般按钮高一大截",
    },
  ],
};
