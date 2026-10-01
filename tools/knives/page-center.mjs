/**
 * 整屏页那一列横着居中（2026-09-30 他真机看着说的「飘了」）。
 * 根因不在卡，在遮罩：`.sheet` 本来是 `place-items: center`，整屏化时改成 `stretch` 想让卡撑满一屏，
 * 忘了 `place-items` 一条管两个轴——水平也跟着变 stretch，而卡是定宽（--card-w），
 * 定宽的东西 stretch 不动，浏览器就按 start 摆，于是整列贴左、右边空一条，跟居中的首页对不上。
 * A 钉这一句的解法；B 钉另一头（首页那列也居中），两句合起来才是「一进一出同一根轴」，
 * 只量一头的话谁把首页改成贴左这儿也不会红。
 * 跑法：npm run knives -- page-center（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'page-center',
  title: '整屏页那一列横着居中，且跟首页同一根轴',
  via: 'test',
  suite: 'test:style',
  knives: [
    {
      rel: 'src/web/style.css',
      note: 'A 退回旧写法：place-items 只写 stretch（水平跟着变 start ⇒ 定宽的卡贴左）',
      from: '  place-items: stretch center;',
      to: '  place-items: stretch;',
      expect: '整屏页那一列横着居中（不贴左）',
    },
    {
      rel: 'src/web/style.css',
      note: 'B 首页那列改成贴左：两层不再同一根轴，一进一出就跳',
      from: '  flex-direction: column;\n  align-items: center;\n  gap: 6px;',
      to: '  flex-direction: column;\n  align-items: flex-start;\n  gap: 6px;',
      expect: '首页那一列也居中：一进一出同一根轴，别跳',
    },
  ],
};
