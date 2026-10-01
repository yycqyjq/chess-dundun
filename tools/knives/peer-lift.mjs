/**
 * 列表那一排的顶空，钉的是「够不够抬起那一截」这一层关系（2026-09-30 他真机看到的：地址那颗按钮 hover 时掉了个顶）。
 * 根因：`.peer-list` 是 `.sheet-body`（overflow: auto）的第一个孩子，里头那颗地址按钮 40px 高，
 * hover 又 translateY(-2px) 抬起来——顶部不留空，抬起那一截连同上边框就被滚动区的上边缘切掉。
 * A 摘掉让出的那 6px（该红：让出 0）；B 把抬起改大到 8px 而不去补空（该红：抬起 8／让出 6）。
 * 断言故意不写死 6px，所以 B 这类「只动一头」的改法才挡得住——两头谁单独变，这儿就红。
 * 跑法：npm run knives -- peer-lift（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'peer-lift',
  title: '列表顶空要盖住按钮抬起那一截（切顶边的根因在滚动区那条 overflow）',
  via: 'test',
  suite: 'test:style',
  knives: [
    {
      rel: 'src/web/style.css',
      note: 'A 摘掉让出的那 6px（按钮回到顶着滚动区上边缘）',
      from: '  padding-top: 6px;\n',
      to: '',
      expect: '列表那排让出的顶空，够地址按钮 hover 抬起那一截',
    },
    {
      rel: 'src/web/style.css',
      note: 'B 抬起从 2px 改成 8px，却没跟着补顶空（只动一头的改法）',
      from: '    transform: translateY(-2px);',
      to: '    transform: translateY(-8px);',
      expect: '列表那排让出的顶空，够地址按钮 hover 抬起那一截',
    },
  ],
};
