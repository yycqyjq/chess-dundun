/**
 * 散桌那三道闸和「散完到底动了什么」（批10）：三道闸一把一把拆，四样该归零的一样一样不归零。
 * 2026-09-29 每把都跑过 `npm run knives -- disband-table --verbose`，`expect` 是从实际红的那几句里
 * 逐字抄的（不是凭记忆写的）。八把各钉各的那句，名字都跟「清账」那一族错开，免得红字互相蒙。
 * 跑法：npm run knives -- disband-table（全跑就 npm run knives；看每刀全红几句加 --verbose）
 */
export default {
  id: 'disband-table',
  title: '散桌：只有房主、只有没开打、只有他一个活人，散完局号・账・椅子・牌面一起归零（批10）',
  via: 'test',
  suite: 'test:net',
  knives: [
    {
      rel: 'src/node/table.ts',
      note: 'A 拆掉「只有房主能散」这道闸：谁递上来都散得成',
      from: "    if (bySeat !== (this.setup.hostSeat ?? 0)) return { ok: false, why: '只有房主能散这桌' };",
      to: '',
      expect: '不是房主散不动，账照旧',
    },
    {
      rel: 'src/node/table.ts',
      note: 'B 拆掉「正在打不散」这道闸：那一局的账还没落地就收椅子',
      from: "    if (this.status === 'playing') return { ok: false, why: '这一局正在打，打完再散' };",
      to: '',
      expect: '这一局正在打，散不动也不碰椅子',
    },
    {
      rel: 'src/node/table.ts',
      note: 'C 拆掉「还有别人就不散」这道闸：调用方自报「就我一个」也能散',
      from: '    if (alive > 1) return { ok: false, why: `这桌还有 ${alive - 1} 个活人连着：要散得等别人先走` };',
      to: '',
      expect: '还连着别人：房主也散不动，要散得等别人先走',
    },
    {
      rel: 'src/node/table.ts',
      note: 'D 散完不洗椅子：令牌还挂在各把椅子上（跟清账一个样了）',
      from: '    this.slots = this.freshSlots(this.setup.players);',
      to: '',
      expect: '椅子一把不剩：令牌也跟着收（不像清账那样留着人）',
    },
    {
      rel: 'src/node/table.ts',
      note: 'E 散完局号不回 1：下一台设备寻到这张「空桌」，看见的还是「第 3 局」',
      from: '    this.setup.hostSeat = this.setup.homeSeat ?? 0;\n    this.book = openMatch(this.setup.players);\n    this.gameNo = 1;',
      to: '    this.setup.hostSeat = this.setup.homeSeat ?? 0;\n    this.book = openMatch(this.setup.players);',
      expect: '房主散了：局号回 1，四条账目全归零',
    },
    {
      rel: 'src/node/table.ts',
      note: 'F 散完房主位不回家：那张开局还钉在已经下桌的代持那位手上',
      from: '    this.slots = this.freshSlots(this.setup.players);\n    this.setup.hostSeat = this.setup.homeSeat ?? 0;',
      to: '    this.slots = this.freshSlots(this.setup.players);',
      expect: '散完房主位回「家」那把：代持那位按不动开局，家那把按得动',
    },
    {
      rel: 'src/node/table.ts',
      note: 'G 散完不重摊牌面：候场厅留着打完那一份等开局',
      from: '    this.state = createGame({\n      ...this.setup,\n      seed: this.rollSeed(),\n      // 不带 drawer：跟 resetBook 同一个理——账都归零了，「上一局的赢家」指的已经不是任何一个人\n    });',
      to: '',
      expect: '散了也重摊牌面：不再是打完那一份',
    },
    {
      rel: 'src/net/wire.ts',
      note: 'H「活人」改成数椅子不数人：掉线那把也算连着，一个人退不出这张桌',
      from: '  return seats.filter((s) => s.online).length;',
      to: '  return seats.length;',
      expect: '掉线那把不算活人（椅子还挂着令牌，可人不在这条线上）',
    },
  ],
};
