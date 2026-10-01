/**
 * 命令行开关认 `--名=值`（2026-09-30）：以前只认「整项等于 --名」，于是 `--fresh=1` 静默不生效——
 * 加了开关的人以为桌重开了，其实接回的是上一桌，这跟「没加这个开关」是两种结果，却一点看不出来。
 * 口径：光写算开；`0／false／no`（大小写都算）是关；其余都是开——包括空值和认不出的值。
 * 「认不出的值算开、不报错」是我的判断（他可能推翻：另一种做法是当场说一句 `--fresh=maybe 认不下`），
 * 所以那一档单独有一把 G 钉着，改口径时必然红在这里，不会静漂。
 * A 钉回到旧口径；B 钉「没开口」那张清单整个没了；C 钉不折大小写；D 钉「写了等号又留空」被当成关；
 * E 钉前缀撞上同名的另一档（--discover-slot=0 被当成 --discover）；F 钉值切早一位（等号算进值头里）。
 * 没配刀的两条是同一件事的第二道影子：「根本没写就是关」E 一放宽就跟着红，「--fresh=1 关不掉别人的档」同理。
 * 跑法：npm run knives -- has-flag（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'has-flag',
  title: '--fresh=1 不再静默无效：开关认值，但不猜值',
  via: 'test',
  suite: 'test:net',
  knives: [
    {
      rel: 'src/node/room.ts',
      note: 'A 回到旧口径「整项等于 --名」：--fresh=1 又静默不生效了',
      from: '  const hit = argv.find((a) => a.startsWith(`--${name}=`));\n  if (hit) return !NOT_OFF.has(hit.slice(name.length + 3).toLowerCase());\n  return argv.includes(`--${name}`);',
      to: '  return argv.includes(`--${name}`);',
      expect: '--fresh 光写算开，写成 --fresh=1／--fresh=yes 也算开',
    },
    {
      rel: 'src/node/room.ts',
      note: 'B 「没开口」那三种写法一张清单都没有：--fresh=0 照样重开一桌，写着关的人被骗',
      from: "const NOT_OFF = new Set(['0', 'false', 'no']);",
      to: 'const NOT_OFF = new Set<string>([]);',
      expect: '--fresh=0／false／no 才是关，大小写都算',
    },
    {
      rel: 'src/node/room.ts',
      note: 'C 不折大小写：终端上敲 --fresh=NO 的人说的就是关',
      from: '  if (hit) return !NOT_OFF.has(hit.slice(name.length + 3).toLowerCase());',
      to: '  if (hit) return !NOT_OFF.has(hit.slice(name.length + 3));',
      expect: '--fresh=0／false／no 才是关，大小写都算',
    },
    {
      rel: 'src/node/room.ts',
      note: 'D 写了等号又留空被当成关：--fresh= 是手断了，不是「我要接上一桌」',
      from: '  if (hit) return !NOT_OFF.has(hit.slice(name.length + 3).toLowerCase());',
      to: '  if (hit) return hit.slice(name.length + 3).length > 0 && !NOT_OFF.has(hit.slice(name.length + 3).toLowerCase());',
      expect: '--fresh= 空值算开：写了个等号不是把开关关掉',
    },
    {
      rel: 'src/node/room.ts',
      note: 'E 认开关放宽成前缀：--discover-slot=0 被当成 --discover，一颗寻呼换槽的写法顺手把寻呼关了',
      from: '  return argv.includes(`--${name}`);',
      to: '  return argv.some((a) => a.startsWith(`--${name}`));',
      expect: '前缀撞不上名字：--no-discover 不是 --discover，--discover-slot=0 也不是那一档',
    },
    {
      rel: 'src/node/room.ts',
      note: 'F 值切早一位，等号算进值头里：--fresh=0 成了 "=0"，那张清单白列',
      from: '  if (hit) return !NOT_OFF.has(hit.slice(name.length + 3).toLowerCase());',
      to: '  if (hit) return !NOT_OFF.has(hit.slice(name.length + 2).toLowerCase());',
      expect: '--fresh=0／false／no 才是关，大小写都算',
    },
    {
      rel: 'src/node/room.ts',
      note: 'G 认不出的值从「算开」改成「当场报错」：这一档是判断点，改口径必须红在这里，不许静漂',
      from: '  if (hit) return !NOT_OFF.has(hit.slice(name.length + 3).toLowerCase());',
      to: '  if (hit) {\n    const v = hit.slice(name.length + 3).toLowerCase();\n    if (NOT_OFF.has(v)) return false;\n    if (v && v !== "1" && v !== "yes" && v !== "true") throw new Error(`--${name} 的值 ${v} 认不下`);\n    return true;\n  }',
      expect: '认不出的值（--fresh=maybe）算开',
    },
  ],
};
