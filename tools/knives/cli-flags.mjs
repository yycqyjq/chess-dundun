/**
 * 命令行那几个数一路都得查：范围、玩法表、档位（批8-A 从 room.ts 挪出来那几道，捞回自 b11 10–13）。
 * from／to 是从会话记录里捞回的原文逐字搬的（2026-09-28），expect 是跑出来抄回去的红字，不是凭记忆写的。
 * 跑法：npm run knives -- cli-flags（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: "cli-flags",
  title: "命令行那几个数一路都得查：范围、玩法表、档位（批8-A 从 room.ts 挪出来那几道，捞回自 b11 10–13）",
  via: "test",
  suite: "test:net",
  knives: [
    {
      rel: "src/node/room.ts",
      note: "10 intFlag 不看范围（--players=9999 一路送进桌）",
      from: "  if (n < lo || n > hi) throw new Error(`--${name} 只能在 ${lo} 到 ${hi} 之间，你给的是 ${n}`);",
      to: "  // 拆了：数出多少算多少",
      expect: "--host-seat=9 超出一把椅子都没有",
    },
    {
      rel: "src/node/room.ts",
      note: "11 setupFrom 不查椅子数（--players=3 开一桌三人棋）",
      from: "  if (!rules.playerCounts.includes(players))\n    throw new Error(`--players 只能是 ${rules.playerCounts.join(' 或 ')}，你给的是 ${players}`);",
      to: "  // 拆了：引擎那张清单不作数",
      expect: "--players=3 不是这桌的档位",
    },
    {
      rel: "src/node/room.ts",
      note: "12 玩法不从引擎那张清单里挑（--mode=zzz 硬转进 GameState）",
      from: "  const mode = rules.modes.find((m) => m === said);",
      to: "  const mode = said as 'ming' | 'kou';",
      expect: "--mode=明 认不出这种玩法",
    },
    {
      rel: "src/node/room.ts",
      note: "13 档位也不查（--level=easy2 交给 aiPick 去猜）",
      from: "  const picked = LEVELS.find((l) => l === level);",
      to: "  const picked = level as typeof LEVELS[number];",
      expect: "--level=zzz 认不出这档",
    },
  ],
};
