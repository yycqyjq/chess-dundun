/**
 * #48 摊开手牌「宽度优先」这处的刀谱：一处一处拆，看 `test:layout` 会不会红。
 * 六把刀都是量过的——每一把都钉在它要防的那句断言上（2026-09-28 跑出来的）。
 */
export default {
  id: 'spread',
  title: '摊开是宽度优先（每排按自己那段空地算、牌摞真要让它让位）',
  via: 'test',
  suite: 'test:layout',
  knives: [
    {
      rel: 'src/web/board.ts',
      note: '每排先一律让出 CORNER_KEEP（宽度优先被推翻，回到扇形那套口径）',
      from: '  let at = 0;\n  let best = { x: 0, w: 0 };',
      to: '  let at = row.h * CORNER_KEEP;\n  let best = { x: 0, w: 0 };',
      expect: '8 张桌上没摞',
    },
    {
      rel: 'src/web/board.ts',
      note: '排数从三排往下挑（先摊小牌那条）',
      from: '  for (let rows = 1; rows <= HS_ROWS; rows++) {',
      to: '  for (let rows = HS_ROWS; rows >= 1; rows--) {',
      expect: '不超过两排',
    },
    {
      rel: 'src/web/board.ts',
      note: 'freeLane 的空地起点回成整桌宽（让位是个摆设）',
      from: '  let best = { x: 0, w: 0 };',
      to: '  let best = { x: 0, w: board.w };',
      expect: '压摞',
    },
    {
      rel: 'src/web/board.ts',
      note: '调用点不把摞喂给摊开（谁挡路它不知道）',
      from: 'handSpread(fans.length, board, pileBoxes(out.values(), cw))',
      to: 'handSpread(fans.length, board)',
      expect: '压摞',
    },
    {
      rel: 'src/web/board.ts',
      note: '挤紧那一档只解线性式、不按整数格再收一步',
      from: '    const next = n > r ? Math.min(step - 1, room / (n - r)) : step - 1;',
      to: '    const next = n > r ? room / (n - r) : step - 1;',
      expect: '左边占掉',
    },
    {
      rel: 'src/web/board.ts',
      note: '最上那排不兜底（装不下的牌直接没了）',
      from: '    const c = i === lanes.length - 1 ? left : Math.min(left, laneCards(lanes[i]!.w, step, full));',
      to: '    const c = Math.min(left, laneCards(lanes[i]!.w, step, full));',
      expect: '一张不少',
    },
  ],
};
