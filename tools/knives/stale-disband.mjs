/**
 * 「最后一个人离桌，桌跟着没」的刀谱（2026-10-12 用户报的：点了离桌没散，下次「开一桌」又接回上一局）。
 *
 * 三条链子断在不同地方：
 * ① 桌那头 `table.ts::disband` 有一道「这一局正在打，打完再散」的闸——别的位子早被电脑代打着、
 *    最后一个人走时它把人挡在门外，桌留着、存档留着；
 * ② 客户端牌桌右上角那颗「离桌」（`app.ts::resign`）压根没往桌递 disband，只断了连接；
 * ③ 宿主下次起桌 `restore()` 又把那份存档原样接回来（`room.ts`），于是点「在这台机器开一桌」
 *    进的还是上一局，一个字都不问。
 *
 * 每把刀拆一处，看对应的那套闸会不会红。第 2a／2b 两把长得一样（同一处刀口），
 * 因为那一处被两套闸各钉了一句：style 钉代码形状、host 钉牌桌行为。
 *
 * 七把刀的 `expect` 都是 2026-10-12 跑 `--verbose` 抄回来的，各钉各的那句。
 */
export default {
  id: 'stale-disband',
  title: '离桌散桌：最后一个人走，桌跟着没（2026-10-12 用户报的）',
  via: 'test',
  suite: 'test:style',
  knives: [
    {
      // 2026-10-12：这把刀原来连「必须是房主」那道闸一起搬回来。那道闸整道拆了——房主位可能正钉在
      // 一个已经掉线的人身上（`restHost` 只在非 playing 时跑），那道闸会把最后一个活人也挡在门外
      // （见 disband-table 的 I 刀）。现在只搬回「正在打就不散」这一挡，刀口跟着挪到 `aliveSeats` 那行。
      rel: 'src/node/table.ts',
      note: '把「这一局正在打，打完再散」那道闸搬回来（人走桌不走，存档就留在硬盘上了）',
      from: '    const alive = aliveSeats(this.slots);',
      to: "    if (this.status === 'playing') return { ok: false, why: '这一局正在打，打完再散' };\n    const alive = aliveSeats(this.slots);",
      expect: '散桌不再拿「这一局正在打」当门槛',
    },
    {
      rel: 'src/node/table.ts',
      note: '散桌不打回 waiting（正在打时散掉的那一局没收尾，这桌挂着 playing 就永远开不了下一局）',
      from:
        "    this.gameNo = 1;\n    // 正在打的那一局一起收：散完得回候场，不然这桌挂着 'playing'，那颗「开始这一局」永远按不动\n    this.status = 'waiting';",
      to: '    this.gameNo = 1;',
      expect: '只剩一个活人时散得掉，且散完回候场（status 打回 waiting）',
    },
    {
      rel: 'src/node/table.ts',
      suite: 'test:net',
      note: '同上那处，另一套闸也钉着：散完回候场这件事在牌桌上看得见（status 不再是 playing）',
      from:
        "    this.gameNo = 1;\n    // 正在打的那一局一起收：散完得回候场，不然这桌挂着 'playing'，那颗「开始这一局」永远按不动\n    this.status = 'waiting';",
      to: '    this.gameNo = 1;',
      expect: '只剩一个活人：那一局没打完也散得掉，散完回候场',
    },
    {
      rel: 'src/web/app.ts',
      note: '牌桌那颗「离桌」不再认「只剩我一个活人」（退回只断连接那条老路，桌就留在那儿了）',
      from: '    const alone = online && aliveSeats(this.seats ?? []) <= 1;',
      to: '    const alone = false;',
      expect: '牌桌那颗「离桌」也走散桌确认（原来只断连接，桌留着）',
    },
    {
      rel: 'src/web/app.ts',
      note: '确认散桌那颗不往桌递 disband（只断连接 ⇒ 桌没散、存档还在）',
      from:
        "          button('确认散桌', () => {\n            close();\n            this.link?.send({ t: 'disband' });\n            after();\n          }),",
      to: "          button('确认散桌', () => {\n            close();\n            after();\n          }),",
      expect: '两处出口共用一套确认（askDisband 里递的就是 disband 那句）',
    },
    {
      rel: 'src/web/app.ts',
      note: '「开一桌」撞上旧局不问那一句（静默把人丢进上一局，就是用户撞的那一下）',
      from: '          if (creating && seat !== null && aliveSeats(l.seats) === 0 && staleTable(l)) this.askStale(l);',
      to: '          if (creating && seat !== null && aliveSeats(l.seats) === 0 && false) this.askStale(l);',
      expect: '「在这台机器开一桌」撞上旧局会问一句（create 那条路）',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: '「上一桌」的判据整个作废（接回来的旧局被当成全新的一桌，一句都不问）',
      from: "  return lobby.gameNo > 1 || lobby.status === 'playing' || lobby.seats.some((s) => s.taken);",
      to: '  return false;',
      expect: '打过至少一局（局号 > 1）就算',
    },
  ],
};
