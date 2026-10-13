/**
 * 桌层／引擎两处「定向钉子」的刀谱（2026-10-13 第三批补的 `src/test/guards.test.ts`）。
 * 这两条分支原先只有随机整局偶尔路过、没有断言盯着：引擎 `legalActions` 空手只给虚着（game.ts），
 * 桌层 `act` 头一句「没这个座位」（table.ts）。第三批直接构造局面钉死，这儿补上负向验证。
 * 两把都跑 `test:guards`。
 *
 * A 那把特别：闸一拆，`act(9, …)` 会一路走到 `slot.queued` 上抛——测试里 `table.act` 那一手
 * 包了一层 catch 接住（`guards.test.ts`），把「抛了」落成一条专属 ✗；不包的话整套被带走、
 * 刀架那边就钉不住这句（README 那条「别急着记 crash」的路子）。
 * 刀口全抄源码现成的那一段（凭记忆写的刀会「刀口没找着」）；`expect` 从实际红字抄。
 * 跑法：npm run knives -- guards（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'guards',
  title: '桌层 act 的头道闸（没这个座位）＋引擎空手分支（只给虚着）',
  via: 'test',
  suite: 'test:guards',
  knives: [
    {
      rel: 'src/node/table.ts',
      note: 'A 摘掉「没这个座位」那道闸：不存在的座位递一手，一路走到 slot.queued 上抛（客户端拿一串裸栈，人不知道出了什么事）',
      from: "    if (!slot) return { ok: false, why: '没这个座位' };",
      to: '',
      expect: '桌层 act 头一道闸：不存在的座位递什么都不认（不抛、不动状态）',
    },
    {
      rel: 'src/core/game.ts',
      note: 'B 摘掉空手那一支：轮到的人手上没牌时 legalActions 回空表（原先回一手虚着），整桌走到这一步再也动不了、且无一句人话',
      from: '    if (hand.length === 0) return [{ kind: \'noop\' }];\n',
      to: '',
      expect: '空手那一方的合法着法只有虚着一手',
    },
  ],
};
