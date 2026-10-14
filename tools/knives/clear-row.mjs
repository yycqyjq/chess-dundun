/**
 * 「清空」不再跟「出牌」抢贴底那一行的刀谱（2026-10-13 用户：「看看这个的清空按钮怎么能到第二行，
 * 其他时候这个位置都是出牌，太容易点错了，改掉」）。
 *
 * 病根：`.ctrl` 是绝对定位 + `bottom` 固定，所以**最后一行永远贴着底边**——而贴底那一格正是手指
 * 最熟的位置（平时那儿站的是「出牌」）。清空排在出牌后头，窄屏一换行就落到那一格，一抬手就把
 * 刚选好的牌清光。playwright 实测：宽 360 时改前「出牌在上、清空贴底」，改后三档宽度
 * （360／390／430）一律「出牌贴底居中、清空在它上面一行」。
 *
 * 四处改动，四把刀各拆一处：
 *   ① 清空退出按钮条的行流（`position: absolute`）——出牌的位置一个字不动；
 *   ② 浮到按钮条上面一行（`bottom: calc(100% + 6px)`）；
 *   ③ 左右 auto 外边距居中（不碰 transform，那个留给 hover／:active 的抬起落下）；
 *   ④ app.ts 里把清空排到出牌前头（CSS 之外再兜一层：样式没加载上时顺序还是对的）。
 *
 * 全跑 test:style（`style.test.ts` 里那四条）。刀口全抄源码现成的那一段（凭记忆写的刀会「刀口没找着」）。
 * 跑法：npm run knives -- clear-row
 */
export default {
  id: 'clear-row',
  title: '「清空」浮到按钮条上面一行，不再占「出牌」的贴底位',
  via: 'test',
  suite: 'test:style',
  knives: [
    {
      rel: 'src/web/style.css',
      note: 'A 清空退回按钮条的行流：窄屏一换行，它又落回「出牌」平时待的贴底那一格',
      from: '.ctrl .btn.clear {\n  position: absolute;',
      to: '.ctrl .btn.clear {',
      expect: '「清空」退出按钮条的行流（绝对定位），不跟出牌抢贴底那一行',
    },
    {
      rel: 'src/web/style.css',
      note: 'B 清空不往上抬：它跟出牌叠在同一行，按钮条只剩一行高',
      from: '  right: 0;\n  bottom: calc(100% + 6px);',
      to: '  right: 0;',
      expect: '「清空」浮在按钮条上面一行',
    },
    {
      rel: 'src/web/style.css',
      note: 'C 清空不居中：left/right 都是 0 又没有 auto 外边距，它被拉满一行',
      from: '  margin-left: auto;\n  margin-right: auto;',
      to: '',
      expect: '「清空」靠左右 auto 外边距居中',
    },
    {
      rel: 'src/web/app.ts',
      note: 'D 顺序写回旧样（出牌在前、清空在后）：样式万一没加载上，清空又压在出牌下面',
      from: "    if (this.view.sel.size > 0) {\n      this.takeBtn('清空', () => {\n        this.view.sel.clear();\n        this.render(true);\n      }, 'btn clear');\n    }\n    if (match) this.takeBtn(this.describe(match), () => this.commit(match), 'btn primary');\n    else if (this.view.sel.size > 0) this.takeBtn(this.whyNot(this.view.sel), null);",
      to: "    if (match) this.takeBtn(this.describe(match), () => this.commit(match), 'btn primary');\n    else if (this.view.sel.size > 0) this.takeBtn(this.whyNot(this.view.sel), null);\n    if (this.view.sel.size > 0) {\n      this.takeBtn('清空', () => {\n        this.view.sel.clear();\n        this.render(true);\n      }, 'btn clear');\n    }",
      expect: 'app.ts 里「清空」排在「出牌」前头',
    },
  ],
};
