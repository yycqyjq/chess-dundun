/**
 * parseRules 对换玩法那几枚开关（tieBreak / nextLeader / groupCompare / mustBeatIfAble / discardCost）
 * 不设白名单时的账（架构体检 2026-10-02 的 H2）：写错一个字符静默走默认分支，改规则的人以为换了玩法、牌桌纹丝不动；
 * 更狠的是 discardCost 填个「很像人话」的 'all' —— game.ts:360 那句 Math.min(NaN,…) 让压不过的人凑不出抵押，
 * legalActions 返回 0 项，整桌走到那步再也动不了、且无一句人话（探针坐实过：首出红帅后应战者合法动作 0，对照 'same' 时 15 项）。
 * 与 game.ts 里 checkDraft 自述的「宁可开不起来念一句人话」直接矛盾——这张谱子把矛盾抹平：每段白名单都拆一遍，看那套测试红不红、红的是不是它该红的那句。
 * 跑法：npm run knives -- rules-enums（要看每刀全红几句加 --verbose，把 expect 从实际红字里抄回来）
 */
export default {
  id: 'rules-enums',
  title: '换玩法那几枚开关写错要当场拒，别静默走默认分支或把整桌锁死',
  via: 'test',
  suite: 'test:rules',
  knives: [
    {
      rel: 'src/core/game.ts',
      note: 'A 摘掉 tieBreak 白名单：「laer」那种拼写错误静默按 leader 跑，改玩法的人看不出来',
      from: "  if (!TIE_BREAKS.includes(rules.tieBreak))\n    throw new Error(`rules.json：tieBreak（一样大算谁赢）只有 ${TIE_BREAKS.join(' / ')} 这两种，写的是「${rules.tieBreak}」`);\n",
      to: '',
      expect: '拒掉「tieBreak 写错',
    },
    {
      rel: 'src/core/game.ts',
      note: 'B 摘掉 nextLeader 白名单：「clockwise 」尾空格那类静默走 trick-winner 分支',
      from: "  if (!NEXT_LEADERS.includes(rules.nextLeader))\n    throw new Error(`rules.json：nextLeader（下一墩谁先出）只有 ${NEXT_LEADERS.join(' / ')} 这两种，写的是「${rules.nextLeader}」`);\n",
      to: '',
      expect: '拒掉「nextLeader 多个尾空格',
    },
    {
      rel: 'src/core/game.ts',
      note: 'C 摘掉 groupCompare 白名单：大小写写歪（samesize）本该拒，摘了就放行',
      from: "  if (!GROUP_COMPARES.includes(mode.groupCompare))\n    throw new Error(`rules.json：${at}.groupCompare 只有 ${GROUP_COMPARES.join(' / ')} 这三种，写的是「${mode.groupCompare}」`);\n",
      to: '',
      expect: '拒掉「groupCompare 大小写写歪',
    },
    {
      rel: 'src/core/game.ts',
      note: 'D 摘掉 mustBeatIfAble 布尔校验：写成字符串「yes」会被当 truthy 走明棋分支',
      from: "  if (typeof mode.mustBeatIfAble !== 'boolean')\n    throw new Error(`rules.json：${at}.mustBeatIfAble 得是 true 或 false，写的是 ${JSON.stringify(mode.mustBeatIfAble)}`);\n",
      to: '',
      expect: '拒掉「mustBeatIfAble 写成字符串',
    },
    {
      rel: 'src/core/game.ts',
      note: 'E 摘掉 discardCost 白名单（最狠的一条）：「all」放行后 Math.min(NaN,…) 让整桌死锁',
      from: "  if (!(mode.discardCost === 'same' || (Number.isInteger(mode.discardCost) && mode.discardCost >= 0)))\n    throw new Error(\n      `rules.json：${at}.discardCost 得是 'same'（对方几张抵几张）或非负整数（固定弃几张），写的是 ${JSON.stringify(mode.discardCost)}——填错会让压不过的人凑不出抵押那一步，整桌走到那儿就再也动不了`,\n    );\n",
      to: '',
      expect: '拒掉「discardCost 填个像人话的 all',
    },
    {
      rel: 'src/core/game.ts',
      note: 'F 摘掉 discardCost 的非负这一半：负数那把刀口只挡住 Integer 检查、放行 -1',
      from: "  if (!(mode.discardCost === 'same' || (Number.isInteger(mode.discardCost) && mode.discardCost >= 0)))",
      to: "  if (!(mode.discardCost === 'same' || Number.isInteger(mode.discardCost)))",
      expect: '拒掉「discardCost 填负数',
    },
    {
      rel: 'src/core/game.ts',
      note: 'G 摘掉 mode 整档存在性校验：mingqi 整个没写时不该放行到后面 Math.min 才炸',
      from: "  if (!mode || typeof mode !== 'object')\n    throw new Error(`rules.json：${at} 这一档的比牌规则没写（得是个对象，带 mustBeatIfAble、groupCompare、discardCost 三格）`);\n",
      to: '',
      expect: '拒掉「mingqi 整档没写',
    },
  ],
};
