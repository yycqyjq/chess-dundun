/**
 * 局末先结清再换牌面、局号跟着涨、掉线计时跟着椅子挪、代打只代 ai（捞回自 b10 6–10）。
 * from／to 是从会话记录里捞回的原文逐字搬的（2026-09-28），expect 是跑出来抄回去的红字，不是凭记忆写的。
 * 跑法：npm run knives -- table-over（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: "table-over",
  title: "局末先结清再换牌面、局号跟着涨、掉线计时跟着椅子挪、代打只代 ai（捞回自 b10 6–10）",
  via: "test",
  suite: "test:net",
  knives: [
    {
      rel: "src/net/table.ts",
      note: "6 换牌面前不先结打完那一局（账上永远少一局）",
      from: "      const drawer = this.settleOver();",
      to: "      const drawer: number | null = null;",
      // 2026-10-02 换过这一句：原来钉的是「起抽人照旧往上一局的赢家传」，那是单局比对，
      // 拆了 settleOver 之后起抽人改由新牌面的种子掷出来，撞中赢家就是二分之一的运气——
      // 椅子令牌改走 node:crypto、那条流少走了两步，恰好撞中，这把刀当场磨绿。
      // 现在钉的是连翻六局那一条（net.test.ts 里那一圈），六局全撞中才是 1/64。
      expect: "连翻六局牌面，起抽人局局接的是上一局那一位（不是新牌面上掷出来的）",
    },
    {
      rel: "src/net/table.ts",
      note: "7 结清一局不改局号（新牌面还印着老局号）",
      from: "      if (sameSeats) this.gameNo += drawer === null ? 0 : 1;",
      to: "      if (sameSeats) this.gameNo += 0;",
      expect: "局号跟着账走：这副新牌是第 2 局",
    },
    {
      rel: "src/net/table.ts",
      note: "8 换人数时掉线计时不跟着椅子挪（那把椅子永远收不回）",
      from: "          ? { ...slot, name: was.name, token: was.token, nick: was.nick, online: was.online, gone: was.gone }",
      to: "          ? { ...slot, name: was.name, token: was.token, nick: was.nick, online: was.online }",
      expect: "满两分钟那一秒桌动了手",
    },
    {
      rel: "src/net/table.ts",
      note: "9 代打落了一手也当没动手（宿主那一秒就不落盘）",
      from: "      if (this.state.log.length > before) changed = true;",
      to: "      void before; // 刀：这一秒不认账",
      expect: "电脑替掉线那位落一手：这一秒同样算动了手",
    },
    {
      rel: "src/net/table.ts",
      note: "10 不现代打就替在线的人出手（想牌被桌催着走）",
      from: "      if (!this.slots[seat]?.ai) continue;",
      to: "      // 刀：谁轮上就替谁出",
      expect: "全桌都在想牌：这一秒一个字没改，别惊动硬盘",
    },
  ],
};
