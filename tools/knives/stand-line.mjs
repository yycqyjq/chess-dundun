/**
 * 系列战绩搬上顶栏（用户点名：「把这个能不能放到个地方而不是只有结束才能知道」——
 * 指的是结算卡上那条「累计 11 局：你 冠 6　P2 冠 1　P3 冠 3｜并列 1 局」）。
 *
 * 做法是两条：① 那句文案抽成 `local.ts` 的 `bookLine`，顶栏／结算卡／复盘原文三处共用一份；
 * ② 顶栏加一行 `.stand`，一局都没打完（games 0）时整条藏掉，不念一句「累计 0 局」。
 * 四把刀分别拆这四条里的一条——少哪一条都会退回「只有打完那一屏才知道」或者「顶栏漂成第二个说法」。
 *
 * 刀口全抄源码现成的那一段（凭记忆写的刀会「刀口没找着」）。
 * `expect` 从实际红字抄：跑过 `npm run knives -- stand-line --verbose` 之后回填。
 * 跑法：npm run knives -- stand-line（全跑就 npm run knives）
 */
export default {
  id: 'stand-line',
  title: '系列战绩上顶栏：三处同源一句文案，一局没打完不占位，那行独占顶栏一行',
  via: 'test',
  knives: [
    {
      rel: 'src/web/app.ts',
      suite: 'test:style',
      note: '1 顶栏那行不走 bookLine（顶栏自己又抄了一遍「累计 N 局」，改口径就漂）',
      from: "    this.shell.stand.textContent = this.book.games === 0 ? '' : bookLine(this.book, (s) => this.who(s));",
      to: "    this.shell.stand.textContent = this.book.games === 0 ? '' : '‹刀：顶栏自己又抄了一遍›';",
      expect: '顶栏那行走的是 bookLine',
    },
    {
      rel: 'src/web/app.ts',
      suite: 'test:style',
      note: '2 一局没打完也不藏（顶栏天天挂着一句「累计 0 局」占位）',
      from: '    this.shell.stand.hidden = this.book.games === 0;',
      to: '    this.shell.stand.hidden = false;',
      expect: '一局没打完时整条藏掉',
    },
    {
      rel: 'src/web/app.ts',
      suite: 'test:style',
      note: '3 结算卡那行不走 bookLine（跟顶栏各写一遍，两处迟早对不上）',
      from: '    total.textContent = bookLine(this.book, (s) => this.who(s));',
      to: "    total.textContent = '‹刀：结算卡自己又抄了一遍›';",
      expect: '结算卡那行也走同一个 bookLine',
    },
    {
      rel: 'src/web/style.css',
      suite: 'test:style',
      note: '4 那行不逼它换行（跟右上角那三颗按钮挤同一行，按钮位置跟着字数忽左忽右）',
      from: '.stand {\n  flex: 0 0 100%;',
      to: '.stand {',
      expect: '那行在顶栏独占一行',
    },
    {
      rel: 'src/web/local.ts',
      suite: 'test:local',
      note: '5 那句文案的口径改了（「累计」改「总共」，三处跟着一起漂）',
      from: '  return `累计 ${book.games} 局：',
      to: '  return `总共 ${book.games} 局：',
      expect: '局数／各家夺冠／并列都念到了',
    },
  ],
};
