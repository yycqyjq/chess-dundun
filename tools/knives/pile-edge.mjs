/**
 * 牌桌那份「形」跟着档位走（批15）：几摞、一摞几张、摞标签建几块、座位那行念几枚。
 *
 * 3 人档是 30 枚 ÷ 一摞 3 张＝10 摞，比 2、4 人那 8 摞多两格，牌径也跟着涨。
 * 这一本的四个刀口都是「写死回 2、4 人那一档」：那种写法在两人桌上一点看不出来，
 * 加了第三档才露——所以每一把都钉在 3 人自己那一句上。
 *
 * 第 1 把（`pileUnit` 沿边那条 cap）是本轮实测出来的：牌径一涨（这一档 cw 43.3），挂在左右两条竖边那两家
 * 沿边排不开，会搭到自己那坨手牌上。拆掉 cap 只有六块桌面里的一格量得到——
 * `平板横屏 844×390｜3 人 手 4/4/4 摞 0/18/0` 红成「摞压手牌 9」，其余五块全绿（横边那两家不量这条，
 * 竖屏那条矮边本来就够排），所以 expect 抄的是这一整格的名字，不是那句共用的「摞压手牌」。
 */
export default {
  id: 'pile-edge',
  title: '摞数／牌径／标签／枚数都随档位走，不许写死 2、4 人那一档（批15）',
  via: 'test',
  suite: 'test:layout',
  knives: [
    {
      rel: 'src/web/board.ts',
      note: '1 收牌摞沿边排不开时不缩档（3 人档牌径涨了，竖边那两家排进自己的手牌里）',
      from: '  return Math.min(cw * PILE_SCALE, pileBox(cw).i / (GROUP_STEP_I * (rows - 1) + GROUP_I), alongRoom / span);',
      to: '  return Math.min(cw * PILE_SCALE, pileBox(cw).i / (GROUP_STEP_I * (rows - 1) + GROUP_I));',
      expect: '平板横屏 844×390｜3 人 手 4/4/4 摞 0/18/0',
    },
    {
      rel: 'src/web/board.ts',
      note: '2 那份形自己写死一摞 4 张（3 人档该是 10 摞 × 3，量出 8 摞）',
      from: '  const layers = state.rules.draft.stackSize;',
      to: '  const layers = 4;',
      expect: 'board.ts 自己算的那份形和规则表一致（3 人 10 摞）',
    },
    {
      rel: 'src/web/ui.ts',
      suite: 'test:ui',
      note: '3 壳子里的摞标签写死八块（3 人档那两格没得亮，改人数也不重搭壳子）',
      from: '  for (let i = 0; i < maxStacks; i++) {',
      to: '  for (let i = 0; i < 8; i++) {',
      expect: '十摞标签建够十块',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: '4 座位那行拿整张表去除（没先按这一档落定，3 人那一行念的枚数是上一桌的牌堆）',
      from: '  const r = rulesFor(rules, n);',
      to: '  const r = rules;',
      expect: '座位那行念的是这一档自己的枚数：2 人 12÷2、3 人 6÷3',
    },
  ],
};
