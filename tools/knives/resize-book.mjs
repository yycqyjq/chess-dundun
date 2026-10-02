/**
 * 换人数＝换本子：账清零、局号回 1、说一声、新本子按新人头发、booked 跟着重置（捞回自 b12 1–7）。
 * from／to 是从会话记录里捞回的原文逐字搬的（2026-09-28），expect 是跑出来抄回去的红字，不是凭记忆写的。
 * 跑法：npm run knives -- resize-book（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: "resize-book",
  title: "换人数＝换本子：账清零、局号回 1、说一声、新本子按新人头发、booked 跟着重置（捞回自 b12 1–7）",
  via: "test",
  suite: "test:net",
  knives: [
    {
      rel: "src/node/table.ts",
      note: "1 换人数不还换新本（老账留着，P3、P4 那两位还挂在桌上）",
      from: "      this.book = openMatch(players);\n      this.gameNo = 1;",
      to: "      // 拆了：老本照留\n      this.gameNo = 1;",
      expect: "换成两把椅子那本账跟着重开",
    },
    {
      rel: "src/node/table.ts",
      note: "2 换人数不回局号（2 人桌第一局印着「第 5 局」）",
      from: "      this.book = openMatch(players);\n      this.gameNo = 1;",
      to: "      this.book = openMatch(players);\n      // 拆了：局号跟着老桌印",
      expect: "换成两把椅子那本账跟着重开",
    },
    {
      rel: "src/node/table.ts",
      note: "3 人数变了却不说一声（重开成了一件悄悄发生的事）",
      from: "        // 重开是悄悄发生的还是说一声的，差别就在有人回头找「刚才那几局」时会不会以为账丢了\n        (sameSeats ? '' : '｜人数变了，跨局那本账从重开'),",
      to: "        '',",
      expect: "候场厅里念得出来：人数变了，账是从重开的",
    },
    {
      rel: "src/core/match.ts",
      note: "4 新本子发的是空格子（undefined 摆进账目里）",
      from: "  const zero = () => Array.from({ length: players }, () => 0);",
      to: "  const zero = () => new Array(players).fill(undefined);",
      suite: "test:rules",
      expect: "2 人的新本子：四条账目各 2 个数，局数和并列都是 0",
    },
    {
      rel: "src/node/table.ts",
      note: "5 新本子按老人数发（4 变 2 之后账上还留着第三、第四位）",
      from: "      this.book = openMatch(players);",
      to: "      this.book = openMatch(prev.players);",
      expect: "换成两把椅子那本账跟着重开",
    },
    {
      rel: "src/node/table.ts",
      note: "6 换完人数不重置 booked（新本子接第一局时它以为已经结过了）",
      from: "      this.maskFrom = -1;\n      this.last = null;\n      this.booked = false;",
      to: "      this.maskFrom = -1;\n      this.last = null;",
      expect: "重开之后这一局的账记满了两把椅子：一局、32 枚、没有第三位",
    },
    {
      rel: "src/node/table.ts",
      note: "7 桌又改回伸缩老本（把 resizeMatch 那条路接回来）",
      from: "      this.book = openMatch(players);",
      to: "      for (const a of [this.book.draws, this.book.drawWins, this.book.titles, this.book.cards]) {\n        a.length = players;\n        for (let i = 0; i < players; i++) if (a[i] === undefined) a[i] = 0;\n      }",
      expect: "换成两把椅子那本账跟着重开",
    },
  ],
};
