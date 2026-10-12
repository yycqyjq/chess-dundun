/**
 * 散桌那三道闸和「散完到底动了什么」（批10）：三道闸一把一把拆，四样该归零的一样一样不归零。
 * 2026-09-29 每把都跑过 `npm run knives -- disband-table --verbose`，`expect` 是从实际红的那几句里
 * 逐字抄的（不是凭记忆写的）。八把各钉各的那句，名字都跟「清账」那一族错开，免得红字互相蒙。
 * 跑法：npm run knives -- disband-table（全跑就 npm run knives；看每刀全红几句加 --verbose）
 */
export default {
  id: 'disband-table',
  title: '散桌：最后一个活人（房主位在谁手上不算），散完局号・账・椅子・牌面一起归零（批10）',
  via: 'test',
  suite: 'test:net',
  knives: [
    {
      // 2026-10-12：这把刀原来拆的是「必须是房主」那道闸。全面排查发现那道闸会挡住合法的
      // 「最后一个活人」（房主位可能正钉在一个已经掉线的人身上），所以整道拆了 ——
      // 现在只剩「这条连接已经不在桌上」那一挡，这把刀改拆它
      rel: 'src/node/table.ts',
      note: 'A 拆掉「这条连接已经不在桌上就不散」那一挡：一个已经掉线的座位也能把整桌带走',
      from: "    if (!slot?.online) return { ok: false, why: '这条连接已经不在桌上了，散不了这桌' };",
      to: '',
      expect: '一个已经掉线的座位散不动这桌：它已经不在桌上了，账照旧',
    },
    {
      // 2026-10-12：原来这把刀拆的是「正在打就不散」那道闸。那道闸拆掉了（最后一个人走，桌就该没，
      // 口径见 stale-disband 那张谱），于是改钉散完的收尾——`status` 不打回 waiting，这桌就永远开不了下一局
      rel: 'src/node/table.ts',
      note: 'B 散完不回候场：正在打时散掉的那一局没收尾，这桌挂着 playing 就永远开不了下一局',
      from:
        "    this.gameNo = 1;\n    // 正在打的那一局一起收：散完得回候场，不然这桌挂着 'playing'，那颗「开始这一局」永远按不动\n    this.status = 'waiting';",
      to: '    this.gameNo = 1;',
      expect: '只剩一个活人：那一局没打完也散得掉，散完回候场',
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
    {
      // 2026-10-12 全面排查：房主位钉在一个**已经掉线**的人身上时（`restHost` 只在非 playing 时跑），
      // 把「只有房主能散」搬回来就等于把那扇门焊死 —— 桌上只剩一个活人、他又不是房主，整桌散不掉
      rel: 'src/node/table.ts',
      note: 'I 把「只有房主能散」无条件搬回来：房主位钉在掉线那位身上时，最后一个活人也散不掉',
      from:
        "    // 这条连接已经不在桌上了（人早走了）：不替这张桌做决定\n    const slot = this.slots[bySeat];\n    if (!slot?.online) return { ok: false, why: '这条连接已经不在桌上了，散不了这桌' };",
      to: "    if (bySeat !== (this.setup.hostSeat ?? 0)) return { ok: false, why: '只有房主能散这桌' };",
      expect: '只剩一个活人时散得掉，哪怕房主位还钉在掉线那位身上（他不是房主）',
    },
  ],
};
