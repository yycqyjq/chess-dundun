/**
 * #47 清账重开这处的刀谱：一句 `{t:'reset'}` 背后有九道闸，一道一道拆掉看 `test:net` 红不红。
 * 每条 `expect` 都是 2026-09-28 量出来的那句实际红字——钉到断言文案，才不会因为别的断言先摔就冒充这把刀见了红。
 */
export default {
  id: 'clear-book',
  title: '清账重开（只有房主、只有没开打、账和牌面一起归零）',
  via: 'test',
  suite: 'test:net',
  knives: [
    {
      rel: 'src/node/table.ts',
      note: '谁按都算（不是房主也清得动这本账）',
      from: "    if (bySeat !== (this.setup.hostSeat ?? 0)) return { ok: false, why: '只有房主能清这桌的账' };",
      to: '    // 拆了：不查房主位',
      expect: '不是房主清不动，账照旧',
    },
    {
      rel: 'src/node/table.ts',
      note: '开打中也清（正打着那一局打完就没人记账了）',
      from: "    if (this.status === 'playing') return { ok: false, why: '这一局正在打，打完再清' };",
      to: '    // 拆了：正在打也照清',
      expect: '这一局正在打，清不动也不碰账',
    },
    {
      rel: 'src/node/table.ts',
      note: '局号不回 1（账清了还挂着第 2 局）',
      from: '    this.book = openMatch(this.setup.players);\n    this.gameNo = 1;',
      to: '    this.book = openMatch(this.setup.players);',
      expect: '房主清了：局号回 1，四条账目全归零',
    },
    {
      rel: 'src/node/table.ts',
      note: '账本不换新（清完还是原来那两笔）',
      from: '    this.book = openMatch(this.setup.players);\n    this.gameNo = 1;',
      to: '    this.gameNo = 1;',
      expect: '房主清了：局号回 1，四条账目全归零',
    },
    {
      rel: 'src/node/table.ts',
      note: 'booked 不跟着清（清完接着打的那局记不上账）',
      from: "    this.booked = false;\n    this.maskFrom = -1;\n    this.last = null;\n    this.log('房主清了这桌的账",
      to: "    this.maskFrom = -1;\n    this.last = null;\n    this.log('房主清了这桌的账",
      expect: '清完接着打完这一局',
    },
    {
      rel: 'src/node/table.ts',
      note: '牌面不重摊（还停在打完那一份）',
      from:
        '    this.state = createGame({\n      ...this.setup,\n      seed: (this.rng() * 0x100000000) | 0,\n      // 不带 drawer：账都归零了，「上一局的赢家」指的已经不是任何一个人，起抽重新抽\n    });',
      to: '    // 拆了：老牌面留着',
      expect: '牌面重摊了',
    },
    {
      rel: 'src/node/table.ts',
      note: '清完不推快照（客户端还留着老账那本）',
      from: "    this.log('房主清了这桌的账：跨局那本归零，牌面重摊，下一副算第 1 局');\n    this.push();",
      to: "    this.log('房主清了这桌的账：跨局那本归零，牌面重摊，下一副算第 1 局');",
      expect: '下去的快照跟着归零',
    },
    {
      rel: 'src/node/table.ts',
      note: '清账这句不念出来（人不知道账动过）',
      from: "    this.log('房主清了这桌的账：跨局那本归零，牌面重摊，下一副算第 1 局');",
      to: "    this.log('房主按了一下');",
      expect: '候场厅里念得出来：这本是从零重新起的',
    },
    {
      rel: 'src/net/wire.ts',
      note: '形闸不认这句（客户端按了等于没说）',
      from: "    case 'reset':\n      return { t: 'reset' };",
      to: '    // 拆了：这句没人认',
      expect: '清账重开那句认',
    },
  ],
};
