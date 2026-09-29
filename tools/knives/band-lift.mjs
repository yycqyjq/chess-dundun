/**
 * 摊开手牌那块地盘的刀谱（批3.6 #40，捞回自 b5，只搬得回一把）。
 *
 * b5 当年三把都见红，#48「宽度优先」改版后只剩 C 还量得到（2026-09-28 一把一把跑过）：
 * - A `top: board.h - ctrlLift(board) + SPREAD_PAD` 拆成 `- 86`：**绿 ✗，搬不进来**。
 *   现在牌是从 `band.bottom` 往上铺、间距又被 `bandH / rows` 收住，把上界往下挪只会让地盘更小＝更保守，
 *   物理上压不到按钮条；而 `layout.test.ts` 算带子用的是被测代码同一个 `handBand()`，自洽，量不出差别。
 * - B `const step = Math.min(stepFull, bandH / rows)` 拆成 `stepFull`：**同样绿 ✗，搬不进来**（同一个理由）。
 *   想让这两处重新有闸，得改测试（断言自己按「条的底边」算一条带子，别读 `handBand()`），那是另一件事。
 * - C `bottom: board.h - labelBand()` 拆成 `board.h`：红 ✓，钉在「压名字条」那句上，就是这本谱子。
 */
export default {
  id: 'band-lift',
  title: '摊开那块地盘的下界认名字条（批3.6 #40 的 C；同批 A/B 两把在 #48 改版后拆了没人红，见头部注释）',
  via: 'test',
  suite: 'test:layout',
  knives: [
    {
      rel: 'src/web/board.ts',
      note: 'C 地盘下界不认名字条（摊开的牌压到自己家那条 pill 上）',
      from: '    bottom: board.h - labelBand(),',
      to: '    bottom: board.h,',
      expect: '摊开 16 张 —— 互压 0｜出界 0｜越界带 0｜压按钮条 0｜压名字条 4',
    },
  ],
};
