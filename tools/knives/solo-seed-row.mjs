/**
 * 单机那一屏不收「种子／重掷」那一排（2026-09-30 他问「这个重置和种子是干什么的」）。
 * 开桌前种子只是一个谁摇都摇得出来的随机数，摆在那儿是多一道没人看得懂的题；
 * 它该露脸的地方是打完以后那三处（状态栏／战报抬头／报错那句），这一轮一条没动。
 * A 钉那一排没收回来；B 钉 CSS 没留孤儿规则；C 钉主按钮还在底栏（收掉一排之后，
 * 开桌那颗要是跟着滚，这一屏就更像要人先滚到底再摸黑点）。
 * 跑法：npm run knives -- solo-seed-row（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'solo-seed-row',
  title: '单机那一屏没有种子那一排，CSS 与底栏都跟着收了',
  via: 'test',
  suite: 'test:style',
  knives: [
    {
      rel: 'src/web/app.ts',
      note: 'A 把那一排整个摆回去',
      from: "    const go = div('sheet-row');\n    const launch = (setup: Setup): void => {",
      to: "    const seedNote = div('note', `种子 ${chosen.seed}`);\n    const dice = div('sheet-row');\n    dice.append(seedNote, button('重掷', () => {}, 'btn mini'));\n    const go = div('sheet-row');\n    go.append(\n      button(\n        '开桌',",
      expect: '单机那一屏没有「种子／重掷」那一排',
    },
    {
      rel: 'src/web/style.css',
      note: 'B 那一排收了，CSS 里那条 .sheet-row .note 没跟着收：留了条没人使的选择器',
      from: '.sheet-row .btn.mini {',
      to: '.sheet-row .note {\n  align-self: center;\n  margin-right: auto;\n}\n\n.sheet-row .btn.mini {',
      expect: 'CSS 里也没留那条没人使的 .sheet-row .note',
    },
    {
      rel: 'src/web/app.ts',
      note: 'C 开桌那颗从底栏搬回跟着滚的那一层',
      from: 'foot.append(go);',
      to: 'body.append(go);',
      expect: '单机那一屏的底栏就那一排（开桌加返回）',
    },
  ],
};
