/**
 * 冗余保险（belt）：单拆一道谁也看不见——它旁边还有别的闸挡着。这类刀反着判：绿才算合格。
 * 捞回自 b11／b12 那两组当时跑出来的发现（原文在会话记录里，刀口逐条对过现源码）：
 * A5 在 Reader 里其实有四道闸（bail 清缓冲、dead 标记、'stop' 一路上递、fail 里 socket.destroy()）。
 * 拆「拼起来超限就掐」「上一段没完就另起一帧」当场就红（那两把在 ws-handshake.mjs）；
 * 拆下面这三把单看任何一道都还是绿的——前一道已经把字节清了，后一道又把连接整个拆了。
 * 它们不许以后有人把 destroy 改成异步，但也不冒充成绩，所以单列一档。
 * 跑法：npm run knives -- redundant-belts（要看红没红全句加 --verbose）
 */
export default {
  id: 'redundant-belts',
  title: '冗余保险：单拆一道本该谁也看不见（绿才算合格，红了是发现，不当成绩）',
  via: 'test',
  suite: 'test:net',
  knives: [
    {
      rel: 'src/net/ws.ts',
      note: 'b1 bail 不标 dead（只清缓冲、只说一次）',
      from: '      this.dead = true;',
      to: '      // 拆了：接着当它还活着',
      belt: true,
    },
    {
      rel: 'src/net/ws.ts',
      note: "b2 push 不再看 dead（掐过之后新到的字节照解）",
      from: '  push(chunk: Buffer): void {\n    if (this.dead) return;',
      to: '  push(chunk: Buffer): void {',
      belt: true,
    },
    {
      rel: 'src/net/ws.ts',
      note: "b3 consume 的 'stop' 不往上递",
      from: "    return this.consume(fin, opcode, payload) === 'stop' ? 'stop' : true;",
      to: "    this.consume(fin, opcode, payload);\n    return true;",
      belt: true,
    },
    {
      rel: 'src/net/table.ts',
      note: 'b4 新本子多长一位（真实 mutation 走不到「四条账目只剩两把椅子」那条路）',
      from: '      this.book = openMatch(players);',
      to: '      this.book = openMatch(players); this.book.ties = 7;',
      belt: true,
    },
  ],
};
