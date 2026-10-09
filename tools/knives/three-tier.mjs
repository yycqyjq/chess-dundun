/**
 * 3 人档那几道闸（批15）：这一档的牌怎么发、发得平那道查不查、落定那份转得回来吗、档位文案是不是一个出口。
 *
 * 第 1 把是本轮真撞到的那个洞：`GameState.rules` 存的是**按人数落定之后**那一份，
 * 线上快照和存档带下去的也是它，还原时还要再进一次 `parseRules`（那道门是给手写 rules.json 设的）。
 * 落定那份要是还留着整张档位清单，2 人那一档就被拿去查「一摞 3 张」，当场自己拒自己——
 * 网页端每份快照读不回、host 重启接不回这一桌。
 * 这一把原来量不到：拆完 `Table.load` 在 `net.test.ts`「清账重开」那段的裸调用上就抛，整套死在第一句，
 * 一句 ✗ 都打不出来（架子只会报「红了 0 条」）。2026-10-01 照 README 那个思路接住——
 * 在它前面加一段「三档各往线上和硬盘上走一遍」，自己 try/catch，闸一拆就先打出这两句专属红字；
 * 后面那几处裸 `Table.load` 照样抛，但那已经是红字打完之后的下游，不算 crash（同 `rejoin-same-conn` 第 1、2 把）。
 *
 * 没搬进来的那条：`rules.json` 里 3 人档那两行覆盖（`兵卒 [4,4]` 与 `draft`）。摘掉任何一行，
 * 整套 `test:rules` 在模块顶层 `loadRules()` 就抛了，一句 ✗ 都打不出来——那是 crash 刀，
 * 而这套架子的规矩是把闸的错变成钉得住的断言，所以宁可不搬，改在代码这一头下刀（第 2、3 把）。
 */
export default {
  id: 'three-tier',
  title: '3 人档：落定那份只说这一档、发得平两道查得到、拒人那句一个出口（批15）',
  via: 'test',
  suite: 'test:net',
  knives: [
    {
      rel: 'src/core/game.ts',
      note: '1 落定那份还留着整张档位清单（三人桌的快照／存档转一圈回来自己拒自己）',
      from: '    playerCounts: [players],',
      to: '    playerCounts: rules.playerCounts,',
      expect: '三档的快照各转一圈都接得回来：落定那份不再带着整张档位清单',
    },
    {
      rel: 'src/core/game.ts',
      suite: 'test:rules',
      note: '2 整摞拿不查摞数除不尽家数（10 摞分 3 家必然 12／9／9，配置却照过）',
      from: "  if (draft.ways.some((way) => way !== 'layered') && (total / draft.stackSize) % players !== 0)",
      to: "  if (false && draft.ways.some((way) => way !== 'layered') && (total / draft.stackSize) % players !== 0)",
      expect: '3 人档加回整摞轮流拿',
    },
    {
      rel: 'src/core/game.ts',
      suite: 'test:rules',
      note: '3 一摞张数（＝层数）不查除不尽家数（一人一层拿牌分不匀，也照过）',
      from: '  if (draft.stackSize % players !== 0)',
      to: '  if (false && draft.stackSize % players !== 0)',
      expect: '一摞张数除不尽家数',
    },
    {
      rel: 'src/node/table.ts',
      note: '4 桌这一头的拒人话自己拼一遍（三处文案漂开，这句还念「2 或 3 或 4」）',
      from: '      return { ok: false, why: `这桌只能 ${countsText(this.setup.rules.playerCounts)} 人` };',
      to: "      return { ok: false, why: `这桌只能 ${this.setup.rules.playerCounts.join(' 或 ')} 人` };",
      expect: '那句回绝话也走同一个出口',
    },
    {
      rel: 'src/net/wire.ts',
      note: '5 闸那头的拒人话也自己拼一遍（同一条清单两处写法）',
      from: '          return `这桌只能 ${countsText(rules.playerCounts)} 人`;',
      to: "          return `这桌只能 ${rules.playerCounts.join(' 或 ')} 人`;",
      expect: '人数不在档位上改不动，那句念 2、3 或 4',
    },
    {
      rel: 'src/node/table.ts',
      note: '6 档位清单从落定那份取（room.ts 那句 gate 拿它认人数，三人桌就再也改不回四人）',
      from: '    return this.setup.rules;\n  }',
      to: '    return this.state.rules;\n  }',
      expect: '档位清单还是开桌那份：2、3、4 都在',
    },
  ],
};
