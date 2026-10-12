/**
 * 「一个活人都没连着，桌自己散掉」的刀谱（2026-10-12 用户报的另一半：
 * 「这两个人都掉线了 这桌还留着干啥呢，还有必要留着吗」——附的是候场厅截图，两个位子都掉线、第三台设备进不来）。
 *
 * 上一条（`stale-disband.mjs`）修的是**主动离桌**：最后一个人点「离桌」桌就散。
 * 这一条修的是**掉线**：一个活人都不剩时没人递得上那句话，桌得自己判。
 * 原来那一档只长在候场期（`sweepIdle`），`playing` 时只做代打、椅子一律不收，
 * 于是两位都掉线的桌挂着 'playing' 由电脑替双方一直打下去，桌和存档都留在那儿。
 *
 * 拆法：桌那头五处（那一档挂在哪、等多久、起算点跟谁清零、散完翻哪一格、收尾走哪份），
 * 宿主一处（那一格翻起来之后抹存档）。第 1、2 两把拆的是同一行代码的两面：
 * 第 1 把整条拿掉（回到「只有候场期扫椅子」那一版），第 2 把只挪位置（挪进候场期那条分支里）。
 *
 * `expect` 都是从实际红字里抄回来的（先 `npm run knives -- empty-disband --verbose` 跑一遍再抄）。
 */
export default {
  id: 'empty-disband',
  title: '一个活人都没连着：满两分钟桌自己散掉（局打没打完都一样）',
  via: 'test',
  suite: 'test:net',
  knives: [
    {
      rel: 'src/node/table.ts',
      note: 'A 整条拆掉：一个活人都没连着也不散，回到「只有候场期扫椅子」那一版（两位都掉线的桌永远留着）',
      from: '    if (this.sweepEmpty()) return false;\n',
      to: '    // 刀：拆了——这一档不再挂上表\n',
      expect: '满两分钟一个活人都没回来：这桌自己散了（局号回 1、回候场、椅子连令牌一起收）',
    },
    {
      rel: 'src/node/table.ts',
      suite: 'test:style',
      note: 'B 同一处刀口另一面：把这一档挪到「候场期」那条分支之后（开打中照旧不散，正是用户撞的那一版）',
      from: "    if (this.sweepEmpty()) return false;\n    if (this.status !== 'playing') return this.sweepIdle();",
      to: "    if (this.status !== 'playing') return this.sweepIdle();\n    if (this.sweepEmpty()) return false;",
      expect: '一个活人都没连着满两分钟就散：那一档挂在 tick 上，不在「候场期」那条分支里',
    },
    {
      rel: 'src/node/table.ts',
      note: 'C 等待时长缩成 1 毫秒：掉线那一刻就散桌（路由器抖一下、人锁一下屏，桌就没了）',
      from: '    if (t - this.emptySince < EMPTY_MS) return false;',
      to: '    if (t - this.emptySince < 1) return false;',
      expect: '差一毫秒不到：桌还在，椅子还挂在他们名下',
    },
    {
      rel: 'src/node/table.ts',
      note: 'D 起算点不跟着活人回来清零：他掉线过的那两分钟一直算着，人再一走桌当场就散',
      from: '    if (aliveSeats(this.slots) > 0) {\n      this.emptySince = 0;\n      return false;\n    }',
      to: '    if (aliveSeats(this.slots) > 0) return false;',
      expect: '人回来过就把起算点清零：他再走之后重新数两分钟，不是接着上一次那笔账',
    },
    {
      rel: 'src/node/table.ts',
      note: 'E 散完不翻那一格：桌是散了，可宿主不知道要抹存档，硬盘上那份接得回来',
      from: '    this.wipe();\n    this.wiped = true;',
      to: '    this.wipe();',
      expect: '桌把「我刚散了」这一格翻起来：宿主看见才知道要抹存档',
    },
    {
      rel: 'src/node/table.ts',
      suite: 'test:style',
      note: 'F 桌自己判的那条路不走共用收尾（跟 disband 各写一遍，迟早走岔）',
      from: '    this.emptySince = 0;\n    this.wipe();\n    this.wiped = true;',
      to: '    this.emptySince = 0;\n    this.wiped = true;',
      expect: '两条路走同一份收尾：disband 和 sweepEmpty 都调 wipe',
    },
    {
      rel: 'src/node/room.ts',
      note: 'G 宿主那一秒看见桌散了也不抹存档（「散了」成了「这一秒看不见」，下一回起桌照旧接回来）',
      from: '  if (table.wiped) {\n    table.wiped = false;\n    discard();\n  }',
      to: '  // 刀：桌散了也不抹存档',
      expect: '满两分钟：那一秒抹的是存档，不是落盘',
    },
  ],
};
