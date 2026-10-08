/**
 * wire 两个量上限（2026-10-08 评审批）：join 的令牌、一手的 id 数。
 * 上一道闸管的是「形」：不是字、不是整数都进不来；这一道管的是「量」——
 * 一封 1MB 的消息别想把超长的字存进椅子（随每份 welcome、快照、落盘反复携带），
 * 也别拿十万级的数组来喂 sameAction 的比对。合法张数归桌按 legalActions 判，这儿只拒量级。
 */
export default {
  id: "wire-caps",
  title: "join 的令牌和一手的 id 数各有一道量上限，超长的字别想住进椅子、喂进比对",
  via: "test",
  suite: "test:net",
  knives: [
    {
      rel: "src/net/wire.ts",
      note: "令牌上限拆掉：多长的字都认进椅子",
      from: "      if (raw.token.length > TOKEN_MAX) return '这串令牌长得不像话，认不了';\n",
      to: "",
      expect: "令牌 65 字坐不下",
    },
    {
      rel: "src/net/wire.ts",
      note: "id 数上限拆掉：isIds 不再数个数",
      from: "  return Array.isArray(v) && v.length > 0 && v.length <= IDS_MAX && v.every(isInt);",
      to: "  return Array.isArray(v) && v.length > 0 && v.every(isInt);",
      expect: "一手 65 个 id 不收",
    },
  ],
};
