/**
 * 首页往哪儿走：裸地址回首页、两个入口不挂串、版本行没注上就不印（批6 的三处判断，捞回自 b8 D/E/F）。
 * D 那条 2026-09-30 跟着「进门落哪一屏改看地址上的标记」改了口径：原来量的是 host 是不是本机。
 * from／to 是从会话记录里捞回的原文逐字搬的（2026-09-28），expect 是跑出来抄回去的红字，不是凭记忆写的。
 * 跑法：npm run knives -- home-nav（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: "home-nav",
  title: "首页往哪儿走：裸地址回首页、两个入口不挂串、版本行没注上就不印（批6 的三处判断，捞回自 b8 D/E/F）",
  via: "test",
  suite: "test:ui",
  knives: [
    {
      rel: "src/web/home.ts",
      note: "D 谁进门都直落候场厅（initialScreen 不看地址上那句意图了）",
      from: "  return wantsJoin(search) ? 'room' : 'home';",
      to: "  return 'room';",
      expect: "裸地址一律先落首页",
    },
    {
      rel: "src/web/home.ts",
      note: "E 两个入口挂串（点「自己玩」却去开连接）",
      from: "  list.append(entry('solo', onSolo), entry('room', onRoom));",
      to: "  list.append(entry('solo', onRoom), entry('room', onSolo));",
      expect: "点第一块只去单机，不顺手把连接也开起来",
    },
    {
      rel: "src/web/home.ts",
      note: "F 版本行无条件印（没注上时念 undefined）",
      from: "  if (version) foot.append(div('v', `v${version}`));",
      to: "  foot.append(div('v', `v${version}`));",
      expect: "没注上版本时宁可少那一行，也不念一个 undefined",
    },
  ],
};
