/**
 * 同网桌那一行：一行两排，两排共用左边缘那一根锚（2026-09-30 他真机说的「飘」）。
 * 旧写法是「情况｜地址」两列，`auto` 把地址那颗推到最右、情况那句缩在最左，
 * 一行里两个起点隔着一条空缝——读的人得在一条横线上找两次落脚点。
 * A 退回两列，钉的是列数；B 把对齐改成居中／撑满，钉的是那一根锚。
 * 两句各钉一半：只数列数的话，一列里把两颗都推到右边照样绿。
 * 跑法：npm run knives -- peer-row（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'peer-row',
  title: '同网桌那一行只有一列，且两排对齐到左边',
  via: 'test',
  suite: 'test:style',
  knives: [
    {
      rel: 'src/web/style.css',
      note: 'A 退回旧写法：地址那颗另起一列（auto）被推到最右',
      from: '  grid-template-columns: minmax(0, 1fr);\n  justify-items: start;',
      to: '  grid-template-columns: minmax(0, 1fr) auto;\n  justify-items: start;',
      expect: '同网桌那一行只有一列',
    },
    {
      rel: 'src/web/style.css',
      note: 'B 一列是把第二列删了，但两排各自居中：左边缘那根锚又没了',
      from: '  justify-items: start;\n  gap: 4px;',
      to: '  justify-items: center;\n  gap: 4px;',
      expect: '那一行的两排对齐到左边',
    },
  ],
};
