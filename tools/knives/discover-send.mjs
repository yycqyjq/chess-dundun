/**
 * b13（批4 UDP 寻呼）剩下那几把：真往网上发字节那几手，4 把全在 src/node/discover.ts。
 * 原文手抄自 recovered/run-knives-b13.mjs 的第 13–16 刀；认答话那 12 把在 discover-check.mjs。
 */
export default {
  id: "discover-send",
  title: "真往网上发字节那几手：口令比对、口占不住就撒手、find 不重发、close 真松口",
  via: "test",
  suite: "test:discover",
  knives: [
    {
      rel: "src/node/discover.ts",
      note: "13 口令不比对，什么字节都答一句（自己的口成了反射器）",
      from: "    if (text === WHOAMI) {",
      to: "    if (true) {",
      expect: "不是口令、也不是像样的答话：一个字都不回",
    },
    {
      rel: "src/node/discover.ts",
      note: "14 口占不住还当它活着（一直往发不出的口发包）",
      from: "      o.log(why);\n      socket = null;",
      to: "      o.log(why);",
      expect: "断了之后既不再答话，也不再发包",
    },
    {
      rel: "src/node/discover.ts",
      note: "15 find 里那道「刚寻过」不挡（每次按都重发八个包）",
      from: "      if (!sweepDue(lastAt, now))",
      to: "      if (false)",
      expect: "三秒内再按不再发一个包",
    },
    {
      rel: "src/node/discover.ts",
      note: "16 close 不松口（桌收了杆，那个口还守着、还答话）",
      from: "      const s = socket;\n      socket = null;",
      to: "      const s = socket;",
      expect: "关了以后再按：回一句空的，不再发包",
    },
  ],
};
