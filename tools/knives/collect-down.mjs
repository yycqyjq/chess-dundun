/**
 * 收牌扣着收（用户点名）：翻开看一眼 → 翻回背面落定 → 再整墩收进牌摞，摞里一律背面。
 *
 * 他原话是「棋在收起来的时候不是扣着收的，是边扣边收，这个不行，能看到那个棋放在了哪里」。
 * 改动前实测（连拍 30 帧看真动画）：扣棋收牌那一段根本没人翻面，整墩是**亮着面**飞进摞、亮着面留在摞里——
 * 所以毛病是「收进去的还是正面」，不是「翻面挪位撞在一起」。两处一起改才收得住：
 *   A 桌面那一拍：翻开之后先在原地翻回背面、落定，再收（`FLIP_COVER_MS`，只走扣棋）；
 *   B 摞里那一支：扣棋的摞一律扣着，翻过的牌收进去也不许又亮回来。
 * 两处各配一把刀——少 A 是「边翻边收」，少 B 是「收进去又亮回来」，两种都回到他说的那个画面上。
 *
 * `expect` 从实际红字抄：A/B 各自跑过 `npm run knives -- collect-down --verbose` 之后回填。
 * 跑法：npm run knives -- collect-down（全跑就 npm run knives）
 */
export default {
  id: 'collect-down',
  title: '收牌扣着收：翻回背面那一拍在收之前，且扣棋的摞一律背面',
  via: 'test',
  knives: [
    {
      rel: 'src/web/board.ts',
      suite: 'test:layout',
      note: '1 摞里的牌只按公开口径翻（扣棋收进去的牌又亮回正面）',
      from: "        down: state.mode === 'kou' || isFaceDown(state, id),",
      to: '        down: isFaceDown(state, id),',
      expect: '全扣着',
    },
    {
      rel: 'src/web/board.ts',
      suite: 'test:layout',
      note: '4 摞里的牌一律扣着（顺手把明棋的摞也扣了——那边出牌即亮，收进去就该亮着）',
      from: "        down: state.mode === 'kou' || isFaceDown(state, id),",
      to: '        down: true,',
      expect: '明棋收牌不跟着翻回背面',
    },
    {
      rel: 'src/web/app.ts',
      suite: 'test:style',
      note: '2 收之前那拍翻回背面整个摘掉（翻转和挪位挤在同一拍里，牌在半路变脸）',
      from: `    if (this.state.mode === 'kou') {
      this.view.holdDown = new Set(ids);
      this.render(true);
      await this.nap(FLIP_COVER_MS);
    }`,
      to: '    // 刀：收之前翻回背面那一拍摘掉',
      expect: '翻回背面那一拍排在「收进摞」前面',
    },
    {
      rel: 'src/web/app.ts',
      suite: 'test:style',
      note: '3 那一拍的扣棋那道闸摘掉（明棋收牌也跟着翻回背面）',
      from: `    if (this.state.mode === 'kou') {
      this.view.holdDown = new Set(ids);`,
      to: `    if (true) {
      this.view.holdDown = new Set(ids);`,
      expect: '那一拍只挂在扣棋那一路',
    },
  ],
};
