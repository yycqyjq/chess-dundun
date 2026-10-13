/**
 * 牌桌顶栏的刀谱（2026-10-13 用户两轮点名：①「这桌子里面之后声音开关没必要了吧，
 * 还有复盘和离桌这俩在手机上感觉有点碍事」；②「移动端把这个文字移下来，这几个开关图标放到右上角」）。
 * 六处改动：
 *   ① 牌桌不再摆声音开关——它住在首页「设置」那一屏，两处同一个 `this.sound`，牌桌那颗是重复入口；
 *   ② 复盘／离桌换成只画字形的小按钮（宽度压到 40px，点击高度不动，那条 40px 是无障碍底线）；
 *   ③ 那两颗挂上 title／aria-label，认得出是「复盘」「离桌」；
 *   ④ 顶栏顺序改成 品牌 → 图标 → 配置 → 战绩（配置那段挪到品牌下面、图标放右上角）；
 *   ⑤ `.meta` basis 100% 独占一行；
 *   ⑥ `.btns` margin-left:auto 钉在右上。
 * A/B/F 跑 test:ui（`ui.test.ts` 里那三条），C/D/E 跑 test:style（`style.test.ts` 里那四条）。
 * 刀口全抄源码现成的那一段（凭记忆写的刀会「刀口没找着」）；`expect` 从实际红字抄。
 * 跑法：npm run knives -- topbar-trim
 */
export default {
  id: 'topbar-trim',
  title: '牌桌顶栏瘦身：摘掉声音开关、复盘／离桌换小图标',
  via: 'test',
  suite: 'test:ui',
  knives: [
    {
      rel: 'src/web/ui.ts',
      note: 'A 复盘那颗退回带文字的宽按钮（`icon` 类一没，顶栏按钮区又回到文字按钮的老样子，手机窄屏继续为它多占一行）',
      from: "  const btnLog = iconButton('≡', '复盘', onLog);",
      to: "  const btnLog = button('复盘', onLog);",
      expect: '顶栏按钮区只剩两颗（复盘／离开），牌桌上不再摆声音开关',
    },
    {
      rel: 'src/web/ui.ts',
      note: 'B 图标按钮不挂 aria-label：读屏念不出这颗是干什么的，长按也没有一句说明（只剩个字形给人猜）',
      from: "  el.setAttribute('aria-label', label);\n",
      to: '',
      expect: '两颗都是图标按钮：字形当正文，说明挂 title 与 aria-label（读屏／长按认得出）',
    },
    {
      rel: 'src/web/style.css',
      note: 'C 顶栏图标按钮的宽度没写（靠 padding 撑宽）：手机上又变回一颗占七八十像素的宽按钮',
      suite: 'test:style',
      from: '  width: 40px;\n  min-width: 40px;',
      to: '',
      expect: '顶栏图标按钮宽度＝40（跟 .btn 的高度一般大，点击面积不缩水）',
    },
    {
      rel: 'src/web/style.css',
      note: 'D 配置那段退回跟品牌挤一行（basis 160px）：窄屏上又被右上角那两颗图标顶得忽左忽右、「第几局／我是谁」常被挤到换行',
      suite: 'test:style',
      from: '  flex: 1 1 100%;\n  min-width: 0;',
      to: '  flex: 1 1 160px;\n  min-width: 0;',
      expect: '顶栏配置那段整条独占一行（.meta basis 100%）',
    },
    {
      rel: 'src/web/style.css',
      note: 'E 那两颗图标不钉右上（margin-left:auto 一没，它们贴着品牌挤在左边）',
      suite: 'test:style',
      from: '  /* 推到顶栏右上角：品牌留在左边，这两颗钉在右上（2026-10-13 用户点名） */\n  margin-left: auto;\n',
      to: '  /* 推到顶栏右上角：品牌留在左边，这两颗钉在右上（2026-10-13 用户点名） */\n',
      expect: '顶栏那两颗图标钉在右上角（.btns margin-left: auto）',
    },
    {
      rel: 'src/web/ui.ts',
      note: 'F 顶栏顺序写回旧样（品牌 → 配置 → 图标 → 战绩）：配置那段不再另起一行、图标也回不到右上角',
      from: '  bar.append(brand, btns, meta, stand);',
      to: '  bar.append(brand, meta, btns, stand);',
      expect: '顶栏顺序是 品牌 → 图标 → 配置 → 战绩（图标排在品牌后面、配置前面）',
    },
  ],
};
