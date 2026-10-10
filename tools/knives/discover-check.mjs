/**
 * b13（批4 同网找桌）的刀谱：认答话那 12 把，全在 src/net/discover.ts。手抄 recovered/run-knives-b13.mjs 的第 1–12 刀。
 * 手抄是因为那几段 from 里带反引号模板字符串（还含 ${} 插值和 TS 的 as），没法 import 进来抠。
 * 抄完由 npm run knives 逐条验：刀口没找着就会报 ✗，不会蒙成绿。
 * 2026-10-09 添了 13（一把椅子都没人坐过的桌不列）与 14（桌名形状／长度要校）——
 * 那两条是「两个房主」那轮加进 listFound 与 parseOffer 的，各补一把刀。
 */
export default {
  id: "discover-check",
  title: "一份寻呼答话认不认：端口下限、私网来源、野字段、空位、掩码、回环、槽、自己那张桌、账会不会老、三秒",
  via: "test",
  suite: "test:discover",
  knives: [
    {
      rel: "src/net/discover.ts",
      note: "1 端口下限不查（22、25 那种也当一张桌列出来）",
      from: "  if (!isInt(raw.port) || raw.port < MIN_PORT || raw.port > 65535) return '那桌报的端口不像话';",
      to: "  if (!isInt(raw.port) || raw.port > 65535) return '那桌报的端口不像话';",
      expect: "端口 22 那种不谈",
    },
    {
      rel: "src/net/discover.ts",
      note: "2 来源是不是自家这块网不查（公网来的字节也归进账）",
      from: "  if (!isPrivate(ip)) return '这话不是自家这块网里来的';",
      to: "  // 拆了：谁答的都收",
      expect: "话不是自家这块网里来的拒",
    },
    {
      rel: "src/net/discover.ts",
      note: "3 照抄线上那一份（野字段跟着进清单，地址也就由它拼）",
      from: "  return {\n    ip,\n    port: raw.port,\n    name: raw.name,\n    players: raw.players,\n    gameNo: raw.gameNo,\n    mode: raw.mode as 'ming' | 'kou',\n    level: raw.level as Level,\n    status: raw.status as TableStatus,\n    free: raw.free,\n  };",
      to: "  return { ...raw, ip } as FoundRoom;",
      expect: "自己报的、自己听得回",
    },
    {
      rel: "src/net/discover.ts",
      note: "4 空位比座位还多不查（清单上凭空多把椅子）",
      from: "  if (!isInt(raw.free) || raw.free < 0 || raw.free > raw.players) return '空位比座位还多';",
      to: "  if (!isInt(raw.free) || raw.free < 0) return '空位比座位还多';",
      expect: "空位比座位还多拒",
    },
    {
      rel: "src/net/discover.ts",
      note: "5 掩码连片不查（往一个谁也不收的地址发）",
      from: "  if (inv !== 0 && (inv + 1) & inv) return null;",
      to: "  // 拆了：什么掩码都算",
      expect: "零散掩码不认",
    },
    {
      rel: "src/net/discover.ts",
      note: "6 /31 与 /0 那一档不查（算出来是别人的单播地址）",
      from: "  if (hostBits < 2 || hostBits > 24) return null;",
      to: "  // 拆了：几位都算",
      expect: "/32 没有广播地址可发",
    },
    {
      rel: "src/net/discover.ts",
      note: "7 回环那条不留（一台机器上两张桌互相寻不见）",
      from: "  const hits = new Set<string>(['127.0.0.1', '255.255.255.255']);",
      to: "  const hits = new Set<string>(['255.255.255.255']);",
      expect: "全网广播和回环都在",
    },
    {
      rel: "src/net/discover.ts",
      note: "8 槽不分了（一台机器两张桌抢同一口）",
      from: "  return ((httpPort % SLOTS) + SLOTS) % SLOTS;",
      to: "  return 0;",
      expect: "dev 5199 落在第 7 槽",
    },
    {
      rel: "src/net/discover.ts",
      note: "9 自己那张桌照列（给自己递一条「去别的桌」）",
      from: "    .filter((f) => !isMine(f, mine.ips, mine.port) && f.free < f.players)",
      to: "    .filter((f) => f.free < f.players)",
      expect: "自己绕回来的那两条不列",
    },
    {
      rel: "src/net/discover.ts",
      note: "13 一把椅子都没人坐过的桌照列（点进去当场被推上房主位）",
      from: "    .filter((f) => !isMine(f, mine.ips, mine.port) && f.free < f.players)",
      to: "    .filter((f) => !isMine(f, mine.ips, mine.port))",
      expect: "一把椅子都没人坐过的桌不列",
    },
    {
      rel: "src/net/discover.ts",
      note: "14 桌名形状不查（数字、超长的野话也跟着进清单）",
      from: "  if (typeof raw.name !== 'string' || raw.name.length > NAME_MAX) return '桌名不像话';",
      to: "  // 拆了：桌名是什么都收",
      expect: "桌名写成字之外的东西拒",
    },
    {
      rel: "src/net/discover.ts",
      note: "10 这本账不会老（收了杆的桌一直挂在屏上）",
      from: "  for (const [key, seen] of cache) if (now - seen.at > ttl) cache.delete(key);",
      to: "  for (const [, seen] of cache) void seen;",
      expect: "过了 TTL 先把没再报的那条抹了",
    },
    {
      rel: "src/net/discover.ts",
      note: "11 三秒那道闸不挡（一人连按十下就朝这块网打八十包）",
      from: "  return now - lastAt >= min;",
      to: "  return true;",
      expect: "三秒内不必再来一轮",
    },
    {
      rel: "src/net/discover.ts",
      note: "12 只比端口不比网口（别人机器上同端口那桌被当自己人抹了）",
      from: "  return f.port === myPort && (myIps.includes(f.ip) || f.ip === '127.0.0.1');",
      to: "  return f.port === myPort;",
      expect: "自己绕回来的那两条不列",
    },
  ],
};
