/**
 * 线上来的一句话先过形闸：座位号是整数、在范围里、玩法在表里、张数不为零、认下来不带野字段（捞回自 b10 1–5）。
 * from／to 是从会话记录里捞回的原文逐字搬的（2026-09-28），expect 是跑出来抄回去的红字，不是凭记忆写的。
 * 跑法：npm run knives -- wire-args（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: "wire-args",
  title: "线上来的一句话先过形闸：座位号是整数、在范围里、玩法在表里、张数不为零、认下来不带野字段（捞回自 b10 1–5）",
  via: "test",
  suite: "test:net",
  knives: [
    {
      rel: "src/net/wire.ts",
      note: "1 是数就收（座位写成 1.5 也认）",
      from: "  return typeof v === 'number' && Number.isInteger(v);",
      to: "  return typeof v === 'number';",
      expect: "座位是小数坐不下",
    },
    {
      rel: "src/net/wire.ts",
      note: "2 座位不查范围（负数、超出椅子数都递到桌前）",
      from: "      if (!isInt(raw.seat) || raw.seat < 0 || raw.seat >= seats) return `没这个座位：这桌只 ${seats} 把椅子`;",
      to: "      if (!isInt(raw.seat)) return '座位说不清';",
      expect: "座位超出这桌的椅子数坐不下",
    },
    {
      rel: "src/net/wire.ts",
      note: "3 玩法不查表（mode:\"zzz\" 直接进 GameState）",
      from: "        if (!oneOf(rules.modes, raw.mode)) return `没听过这种玩法：这桌只有 ${rules.modes.join('、')}`;",
      to: "        out.mode = raw.mode as 'ming' | 'kou';",
      expect: "没听过的玩法进不了桌",
    },
    {
      rel: "src/net/wire.ts",
      note: "4 出零张也算一手（sameAction 里那圈循环又空了）",
      from: "  return Array.isArray(v) && v.length > 0 && v.every(isInt);",
      to: "  return Array.isArray(v) && v.every(isInt);",
      expect: "出零张不收",
    },
    {
      rel: "src/net/wire.ts",
      note: "5 认下来的那句照原样带回野字段",
      from: "      return { t: 'setup', ...out };",
      to: "      return { t: 'setup', ...raw, ...out };",
      expect: "改配置那句带的野字段也不跟着往下递",
    },
  ],
};
