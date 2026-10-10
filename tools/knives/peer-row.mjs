/**
 * 同网桌那一行：一行三排，三排共用左边缘那一根锚（2026-09-30 他真机说的「飘」）。
 * 旧写法是「情况｜地址」两列，`auto` 把地址那颗推到最右、情况那句缩在最左，
 * 一行里两个起点隔着一条空缝——读的人得在一条横线上找两次落脚点。
 * A 退回两列，钉的是列数；B 把对齐改成居中／撑满，钉的是那一根锚。
 * 两句各钉一半：只数列数的话，一列里把两颗都推到右边照样绿。
 * C/D/E 是 2026-10-09 加的头一排桌名（用户点名「分不清是哪一桌」）：C 钉那排还在且排在最前，
 * D 钉它比底下那排大一档，E 钉长桌名换行、不截成省略号。
 * 跑法：npm run knives -- peer-row（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'peer-row',
  title: '同网桌那一行只有一列，且三排对齐到左边',
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
      note: 'B 一列是把第二列删了，但三排各自居中：左边缘那根锚又没了',
      from: '  justify-items: start;\n  gap: 4px;',
      to: '  justify-items: center;\n  gap: 4px;',
      expect: '那一行的三排对齐到左边',
    },
    {
      rel: 'src/web/home.ts',
      note: 'C 桌名那排不挂上去了（两台设备各开一张，光看 IP:端口分不清哪张是谁的）',
      from: "  row.append(span('peer-name', roomName(f)), line, span('peer-addr', `${f.ip}:${f.port}`));",
      to: "  row.append(line, span('peer-addr', `${f.ip}:${f.port}`));",
      expect: '桌名那排是整行第一个孩子，且走的是 roomName',
    },
    {
      rel: 'src/web/style.css',
      note: 'D 桌名压到跟底下那排一样小（整行第一眼又落回地址上）',
      from: '.peer-name {\n  font-size: 13px;',
      to: '.peer-name {\n  font-size: 11px;',
      expect: '桌名比底下那排情况大一档',
    },
    {
      rel: 'src/web/style.css',
      note: 'E 桌名放不下改成不换行（长桌名溢出去，或者被截成省略号）',
      from: '.peer-name {\n  font-size: 13px;\n  word-break: break-all;',
      to: '.peer-name {\n  font-size: 13px;\n  white-space: nowrap;',
      expect: '桌名放不下就换行，不截成省略号',
    },
  ],
};
