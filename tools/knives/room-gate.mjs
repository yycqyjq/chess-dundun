/**
 * b13（批8-A）gate 那三道兜底 ＋ 协议里 find 那一句。
 * 原文手抄自 recovered/run-knives-b13.mjs 的第 20–23 刀；23 那把的 from 按现在 src/net/wire.ts:154 的重排过缩进（老那条是按六空格抄的，早就不认了）。
 */
export default {
  id: "room-gate",
  title: "一句话进来先过 gate 那三道兜底，形不合就拒、别当合法话递给桌",
  via: "test",
  suite: "test:net",
  knives: [
    {
      rel: "src/node/room.ts",
      note: "20 gate 不兜 JSON.parse（半截一句字节叫停整个房主）",
      from: "  let raw: unknown;\n  try {\n    raw = JSON.parse(text);\n  } catch {\n    return { close: '说的话看不懂' };\n  }",
      to: "  const raw: unknown = JSON.parse(text);",
      expect: "看不懂的那句该由 gate 咽下",
    },
    {
      rel: "src/node/room.ts",
      note: "21 gate 不兜 checkHost（闸里抛了就没人收）",
      from: "  try {\n    const checked = checkHost(raw, seats, rules);\n    return typeof checked === 'string' ? { reject: checked } : { msg: checked };\n  } catch (e) {\n    return { close: `这句办不了（${String((e as Error).message)}）` };\n  }",
      to: "  const checked = checkHost(raw, seats, rules);\n  return typeof checked === 'string' ? { reject: checked } : { msg: checked };",
      expect: "闸里抛出来的一句话：gate 自己咽下，只给一句 close",
    },
    {
      rel: "src/node/room.ts",
      note: "22 不合形的那句当成合法话递给桌（拒话当 msg，桌下一句就崩）",
      from: "    return typeof checked === 'string' ? { reject: checked } : { msg: checked };",
      to: "    return { msg: checked as ToHost };",
      expect: "合 JSON 不合形：回一句人话，线留着",
    },
    {
      rel: "src/net/wire.ts",
      note: "23 协议里 find 那一句反悔（客户端按了等于没说）",
      from: "    case 'find':\n      return { t: 'find' };",
      to: "    case 'find':\n      return '没听过这种话';",
      expect: "寻同网桌那句认",
    },
  ],
};
