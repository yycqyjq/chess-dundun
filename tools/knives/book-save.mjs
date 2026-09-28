/**
 * 账本跟着桌走：局末记账、booked 幂等、快照发的是这本、存档带 rngSteps 和 seq、welcome 排在快照前（安全批 B7＋E 组，捞回自 b11 4–9）。
 * from／to 是从会话记录里捞回的原文逐字搬的（2026-09-28），expect 是跑出来抄回去的红字，不是凭记忆写的。
 * 跑法：npm run knives -- book-save（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: "book-save",
  title: "账本跟着桌走：局末记账、booked 幂等、快照发的是这本、存档带 rngSteps 和 seq、welcome 排在快照前（安全批 B7＋E 组，捞回自 b11 4–9）",
  via: "test",
  suite: "test:net",
  knives: [
    {
      rel: "src/net/table.ts",
      note: "4 局末不记账（B7：下去的那本还差刚打完的一局）",
      from: "      this.settleOver();\n      this.status = 'waiting';",
      to: "      this.status = 'waiting';",
      expect: "局末那一刻这一局就记进账了",
    },
    {
      rel: "src/net/table.ts",
      note: "5 booked 那道幂等闸拆掉（换牌面每条路都再结一遍）",
      from: "    if (!this.booked) {",
      to: "    if (true) {",
      expect: "改玩法那一趟不会把它再结一遍",
    },
    {
      rel: "src/net/table.ts",
      note: "6 快照里发的不是桌这本账（下去的永远是空账）",
      from: "        book: this.book,\n        status: this.status,",
      to: "        book: openMatch(this.state.players),\n        status: this.status,",
      expect: "打完那一刻：下去的账本已经记上这一局",
    },
    {
      rel: "src/net/table.ts",
      note: "7 存档不写 rngSteps（重启把打过的牌面重放一遍）",
      from: "      rngSteps: this.rngSteps,",
      to: "      rngSteps: undefined,",
      expect: "重启后接着开的那局，种子跟没重启时是同一个",
    },
    {
      rel: "src/net/table.ts",
      note: "8 存档不写 seq（重启后号从 1 重发，还开着的页从此一份不演）",
      from: "      seq: this.seq,\n      booked: this.booked,",
      to: "      seq: undefined,\n      booked: this.booked,",
      expect: "重启后头一份快照的号接着往上走",
    },
    {
      rel: "src/net/table.ts",
      note: "9 welcome 又排回快照后面（客户端拿到牌面还不知道自己坐哪）",
      from: "    this.send(seat, msg);\n    this.push();",
      to: "    this.push();\n    this.send(seat, msg);",
      expect: "新坐下的那位先收到 welcome，再收到快照",
    },
  ],
};
