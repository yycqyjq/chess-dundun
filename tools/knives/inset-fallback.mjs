/**
 * inset 兜底的刀谱（2026-10-14 用户：「改吧」）。
 *
 * `inset` 简写要 **Chromium 87**，比这份代码的 JS 下限（**85**，`dist` 里真有 `??=` 与 `||=`）高两档。
 * 认不得它的内核把**整条**丢掉——不是丢一个方向，是四个方向一起丢 ⇒ 覆盖层／棋子当场没了定位：
 *   `.face`／`.back`（棋子正反面铺满）、`.back::after`（背面那圈虚线，`inset: 17%`）、
 *   `.home`（首页那一层铺满）、`.sheet`（卡片遮罩铺满）、`.drawer`（`auto 0 0 0`，贴底那格）、
 *   宽屏 `.drawer`（`auto auto 10px 10px`，左下角浮层）。
 * 修法是标准写法：同一规则里先按简写展开写 `top/right/bottom/left`，再写 `inset`——
 * 认 inset 的用后者，不认的用前者，两边结果一样。
 *
 * 三把刀拆三种漏法（测试那条是**通用检查**：逐规则取 `inset`，按简写展开算期望值，再跟四条逐一对）：
 *   A 只缺一条（`.face` 的 `left`）——四条不全；
 *   B 四条全缺（`.drawer`）——整条回退；
 *   C 四条都在、但**值不对**（`.drawer` 的 `top: auto` 写成 `top: 0`）——
 *     这条专治「只写四条空壳凑数」，光看有没有写是抓不住的。
 */
export default {
  id: 'inset-fallback',
  title: '每条 inset 都按简写展开拆了 top/right/bottom/left（2026-10-14 查兼容）',
  suite: 'test:style',
  knives: [
    {
      rel: 'src/web/style.css',
      note: 'A 只缺一条（.face 的 left）：四条不全，不认 inset 的内核上棋子正反面少一边定位',
      from: '  left: 0;\n  inset: 0;\n  border-radius: 50%;',
      to: '  inset: 0;\n  border-radius: 50%;',
      expect: '每条 inset 都按简写展开拆了 top/right/bottom/left',
    },
    {
      rel: 'src/web/style.css',
      note: 'B 四条全缺（.drawer 的 auto 0 0 0）：整条回退，复盘那格在旧内核上没了定位',
      from: '  top: auto;\n  right: 0;\n  bottom: 0;\n  left: 0;\n  inset: auto 0 0 0;',
      to: '  inset: auto 0 0 0;',
      expect: '每条 inset 都按简写展开拆了 top/right/bottom/left',
    },
    {
      rel: 'src/web/style.css',
      note: 'C 四条都在但值不对（.drawer 的 top: auto 写成 top: 0）：专治「只写四条空壳凑数」',
      from: '  top: auto;\n  right: 0;\n  bottom: 0;\n  left: 0;\n  inset: auto 0 0 0;',
      to: '  top: 0;\n  right: 0;\n  bottom: 0;\n  left: 0;\n  inset: auto 0 0 0;',
      expect: '每条 inset 都按简写展开拆了 top/right/bottom/left',
    },
  ],
};
