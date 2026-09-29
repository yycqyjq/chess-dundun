/**
 * 摊开手牌那块地盘的刀谱（批3.6 #40，捞回自 b5）。
 *
 * b5 当年三把都见红，#48「宽度优先」改版后 A／B 两把量不到了（2026-09-28 一把一把跑过）。2026-09-29 把 A 捞了回来：
 * - **A（第 2 把，已搬进来）** `top: board.h - ctrlLift(board) + SPREAD_PAD` 拆成 `- 86`：原来量不到，是因为牌从
 *   `band.bottom` 往上铺、行数又只到 1～2 排，上界往哪儿挪都不改变落点，而测试算带子读的是被测代码同一个 `handBand()`，
 *   自洽。现在 `layout.test.ts` 里加了一条自己算按钮条底边的断言（「摊开地盘上界只让一条缝…」），这把就有 6 条专属红字可钉。
 * - **B 仍是第三类（拆了对得上、一句都不红）**：`const step = Math.min(stepFull, bandH / rows)` 拆成 `stepFull` 量不到，
 *   2026-09-29 在临时副本里又跑了一遍那把探针：`test:layout` 基准 999 条绿、拆完**退出码 0、红了 0 条**。理由量过了
 *   （`band.top` 那份几何探针，六块桌面）：`bandH / rows < stepFull` **只在 rows=3 那一档成立**
 *   （rows=1、2 六块桌面全是 false，最大那块也只差 0.1 像素），而合法手牌最多 16 张、现有断言「16 张不超过两排每张原样大」
 *   在六块桌面上全绿 ⇒ 那一档在真牌局里走不到。这不是 belt（belt 要「旁边另有闸挡着」，这里是那段根本到不了），
 *   所以照 README 第三类不搬。要它重新有闸，得先造一张两排都排不下 16 张的桌面，那是另一件事。
 * - **C（第 1 把）** `bottom: board.h - labelBand()` 拆成 `board.h`：红 ✓，钉在「压名字条」那句上。
 */
export default {
  id: 'band-lift',
  title: '摊开那块地盘那两条边：下界认名字条，上界只让按钮条底边一条缝（批3.6 #40 的 C＋A；同批 B 仍量不到，见头部注释）',
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
    {
      rel: 'src/web/board.ts',
      note: 'A 地盘上界爬进按钮条的地里（b5 A，2026-09-29 靠新那条「band 自己那两条边」量回来了）',
      from: '    top: board.h - ctrlLift(board) + SPREAD_PAD,',
      to: '    top: board.h - ctrlLift(board) - 86,',
      expect: '摊开地盘上界只让一条缝、下界正落在名字条上沿',
    },
  ],
};
