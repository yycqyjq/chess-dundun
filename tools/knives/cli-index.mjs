/**
 * 「按下标报牌」那两头的刀谱（2026-09-30：覆盖对账查出 `cli/menu.ts::indexedHand` 一份测试都没引用过）。
 *
 * 那一套是这么用的：屏上把 16 张牌按 1..n 列出来（`indexedHand`），人回一句「16 15 14 13 12」，
 * 那头切开出下标、查合法表（`pickByIndices`）。列跟查原先各管各的，中间没人对账——
 * 一旦号错位、或者分隔符两头不是一套，人看到的那张跟引擎打出去的就不是同一张，
 * 而 terminal 上不会报错，只会平平淡淡地打错牌。这 11 把就是钉这一条对账的。
 *
 * 五处说明（2026-09-30 逐把实测，红字条数抄自 `npm run knives -- cli-index --verbose`）：
 * ① 9 把红刀的条数是 A 2／B 5／C 5／D 5／E 3／F 2／G 1／H 1／I 1。B／C 那两条 5 红里，
 *    「号从 1 连着排到 n」「逐号报回去」是共用的：列出来读不成一张一张的，那两句谁都挡不住；
 *    所以每把只钉自己那句名字对得上错法的红字，重叠处在此写明，不算各自独占。
 * ② 头一版 A（编号从 0 起）只红一句——「逐号报回去」当时是拿循环里的 i+1 去报的，等于绕过了屏上那个号。
 *    改成照 `t.slice(0, t.indexOf('.'))`（人照屏上写的号敲）之后，A 才红两条。这条是量出来的，不是推的。
 * ③ J／K 两把在 belt 档：单摘「0 号算超范围」或「重号不算」都红 0 条、退出码 0——
 *    那两样报上来最后都被「回查合法表」那一步挡成 null，同一条路上两道闸，摘一道还剩一道，不是断言是摆设。
 * ④ G 与 I 各钉一句（4368 条要不要折／折了告诉人出几张）：那句原本是 `tooLong(…) && sizesOf(…) === '5'`
 *    一句 compound，两把刀共用一条红字，拆成两句才分得开谁挡的事。
 * ⑤ 「牌名里不许夹空白、逗号、顿号」那句配不了刀：改牌名只能动 rules.json，实测把 `卒` 改成「小 卒」
 *    ⇒ 退出码 1、一句 ✗ 都没打（整套在 `id('卒')` 那步就抛穿）⇒ 只认退出码的 crash 刀钉不住它自己，故不录。
 *
 * 跑法：npm run knives -- cli-index（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'cli-index',
  title: '列出来的号跟报回去吃到的必须是同一张牌：编号、分隔、界外、key 拼法、菜单线那两头',
  via: 'test',
  suite: 'test:rules',
  knives: [
    {
      rel: 'src/cli/menu.ts',
      note: 'A 编号从 0 起（屏上写 0.红车，报回去吃的是「号要减一」那头）',
      from: "  return state.hands[seat]!.map((id, i) => `${i + 1}.${pieceLabel(state.byId.get(id)!)}`).join('  ');",
      to: "  return state.hands[seat]!.map((id, i) => `${i}.${pieceLabel(state.byId.get(id)!)}`).join('  ');",
      expect: '列出来的张数跟手里一样，号从 1 连着排到 n',
    },
    {
      rel: 'src/cli/menu.ts',
      note: 'B 号跟号之间不空两格，改成一根竖线（报回来那头只切空白跟标点）',
      from: "  return state.hands[seat]!.map((id, i) => `${i + 1}.${pieceLabel(state.byId.get(id)!)}`).join('  ');",
      to: "  return state.hands[seat]!.map((id, i) => `${i + 1}.${pieceLabel(state.byId.get(id)!)}`).join('|');",
      expect: '号跟号之间那分隔，报回来那头切得开：两头用的是同一套切法',
    },
    {
      rel: 'src/cli/menu.ts',
      note: 'C 列的是头一位手里的牌（谁问都念同一家的手牌）',
      from: "  return state.hands[seat]!.map((id, i) => `${i + 1}.${pieceLabel(state.byId.get(id)!)}`).join('  ');",
      to: "  return state.hands[0]!.map((id, i) => `${i + 1}.${pieceLabel(state.byId.get(id)!)}`).join('  ');",
      expect: '列的是这一位手里的牌，不是隔壁那位的',
    },
    {
      rel: 'src/cli/menu.ts',
      note: 'D 报回来的下标错一位（hand[n - 1] 写成 hand[n]）',
      from: '  const ids = nums.map((n) => hand[n - 1]!);',
      to: '  const ids = nums.map((n) => hand[n]!);',
      expect: '按下标报回引擎认的那条',
    },
    {
      rel: 'src/cli/menu.ts',
      note: 'E 手里最后一号被当成超范围（> 写成 >=）',
      from: '  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > hand.length)) return null;',
      to: '  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n >= hand.length)) return null;',
      expect: '长菜单那头第 16 号（手里最后一张）报得回去，不算超范围',
    },
    {
      rel: 'src/cli/menu.ts',
      note: 'F 回查那份 key 按字典序排（en10 插到 en2 前头那一类：10 排在 2 前）',
      from: "  const key = [...ids].sort((a, b) => a - b).join(',');",
      to: '  const key = [...ids].sort().join(\',\');',
      expect: '逗号顿号也当分隔，别逼人数空格',
    },
    {
      rel: 'src/cli/menu.ts',
      note: 'G 菜单线抬到 99999（4368 行照旧一行行数着点）',
      from: 'export const MENU_LIMIT = 40;',
      to: 'export const MENU_LIMIT = 99999;',
      expect: '长菜单收口：4368 条组合不数行号，改成按下标报牌',
    },
    {
      rel: 'src/cli/menu.ts',
      note: 'H 菜单线压到 3（只有四种的弃三张也被折成报下标）',
      from: 'export const MENU_LIMIT = 40;',
      to: 'export const MENU_LIMIT = 3;',
      expect: '短菜单照旧数行号：只有四种的弃三张不折成下标',
    },
    {
      rel: 'src/cli/menu.ts',
      note: 'I 这一轮该出几张不告诉人（张数一律报 0）',
      from: "  return [...new Set(actions.map((a) => ('pieceIds' in a ? a.pieceIds.length : 0)))].sort((a, b) => a - b);",
      to: '  return [...new Set(actions.map(() => 0))].sort((a, b) => a - b);',
      expect: '折成报下标时得告诉人这一轮出几张',
    },
    {
      rel: 'src/cli/menu.ts',
      note: 'J 低界那道（0 号）单摘：后面回查合法表还挡着',
      from: '  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > hand.length)) return null;',
      to: '  if (nums.some((n) => !Number.isInteger(n) || n > hand.length)) return null;',
      belt: true,
    },
    {
      rel: 'src/cli/menu.ts',
      note: 'K 重号那道单摘：后面回查合法表还挡着',
      from: '  if (new Set(ids).size !== ids.length) return null;',
      to: '',
      belt: true,
    },
  ],
};
