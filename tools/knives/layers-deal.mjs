/**
 * 摊开朝向 ＋ 一人一层拿牌（用户点名，2026-10-09）。
 *
 * 他原话：「a 和 b 都要改，方向还是朝上的，但最上面那个是第一层的牌，也得改成一人一层拿牌」。
 * 他看见的是「我抽到第一层的帅，怎么归了 P3」，两处口径对不上合起来才是那个画面：
 *   A 摊开是**摞口朝下**画的：数组末尾那张（摞口＝不指定时引擎抽的那张）落在最下面那格，
 *     于是画面上从上到下正好是发牌顺序的**倒序**——他说的「第一层」（画面最上面那张）其实最后才轮到。
 *     现在翻成**摞口朝上**：最上面那格就是摞口，画面上从上到下＝发牌顺序。
 *   B 口径说的是「一人一层」：从最上面那层起整层归一家，从处置人开始顺时针一层一家。
 *
 * **B 这里量过一件要紧事（别再白改一遍）**：旧那句「一摞一摞地走、每摞从摞口起一人一张」
 * 在数学上**本来就等价于一人一层**——每摞反过来依次发，第 j 张正好落给 (处置人 + j) % 家数，
 * 跟「第 j 层整个归 (处置人 + j) % 家数」是同一个式子。所以那不是规则 bug，是**叫法**误导：
 * 3 人桌一摞 3 张看不出来，2 人桌一摞 4 张也一样（4 层轮两圈＝一人两层）。
 * 据此：① 循环改成一层一层写（读起来就是名字那个意思，输出逐张一字不差）；
 * ② 「把循环退回一摞一张」**不能当刀**——拆了红 0 条（第三类，见 README 刀谱那节），
 *    量不到的东西不搬进来；改钉的是**用户看得见的那行日志**（复盘里念的就是它）。
 *
 * 跑法：npm run knives -- layers-deal --verbose（全跑就 npm run knives）
 */
export default {
  id: 'layers-deal',
  title: '摊开摞口朝上（画面上到下＝发牌顺序）＋ 分牌一人一层（最上面那层整个归处置人）',
  via: 'test',
  knives: [
    {
      rel: 'src/web/board.ts',
      suite: 'test:layout',
      note: 'A 摊开翻回摞口朝下（画面上从上到下又成了发牌顺序的倒序）',
      from: '        const slot = depth;',
      to: '        const slot = stack.length - 1 - depth;',
      expect: '摞口朝上',
    },
    {
      rel: 'src/core/game.ts',
      suite: 'test:rules',
      note: 'B1 层从最下面那层数起（最上面那张反而最后才轮到）',
      from: '      for (const stack of draft.stacks) state.hands[seat].push(stack[stack.length - 1 - k]);',
      to: '      for (const stack of draft.stacks) state.hands[seat].push(stack[k]);',
      expect: '最上面那层（每摞的摞口）整个归处置人',
    },
    {
      rel: 'src/core/game.ts',
      suite: 'test:rules',
      note: 'B2 分牌那行日志退回旧口径（复盘里念的还是「一人一张」，跟实际拿法对不上）',
      from: '    state.log.push(`${seatName(draft.decider)} 定：一人一层拿牌，从最上面那层起，从自己开始顺时针一层一家`);',
      to: '    state.log.push(`${seatName(draft.decider)} 定：从自己开始顺时针一人一张`);',
      expect: '分牌那行日志念的是这一档的口径',
    },
  ],
};
