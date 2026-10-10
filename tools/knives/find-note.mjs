/**
 * 列表页那句「正在寻」（2026-10-09 用户：「同网搜索是不是有点慢，刚开始还以为没有，像有 bug」）。
 * 病根不在寻呼慢——第一轮 find 几乎总赶在握手之前发不出去，旧代码当场写一句吓人的断线提示，
 * 紧接着 onNet 收到「连上了」（空串）又把那行字擦成空白，下一轮要等五秒才来：头六秒屏上一个字都没有。
 * 三处一起改才算修完：进屏就摆字、首轮挂起等握手补发、连回来不擦空串。
 *
 * 这套闸全打在 `test:style` 那几条文本质疑上（app.ts 经 `rules.json?raw` 进不了 node 测试）。
 * `expect` 一律从 style.test 的实际题名抄回，改题名记得一起改。
 * 跑法：npm run knives -- find-note（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'find-note',
  title: '列表页「正在寻」：进屏就摆、首轮挂起等握手、连回来不擦空串',
  via: 'test',
  suite: 'test:style',
  knives: [
    {
      rel: 'src/web/app.ts',
      note: 'A 进屏那行字改回空白（人一进来先对着一屏什么都没有）',
      from: "    const note = div('note', SEARCHING);",
      to: "    const note = div('note');",
      expect: '进这一屏 note 的初值就是「正在寻」（不是空白）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'B 发不出去就不再挂起那一趟（第一轮寻呼白丢，只能等五秒后那一轮）',
      from: '      this.awaitFind = true;\n      return;',
      to: '      return;',
      expect: '发不出去时把这一趟挂起来等握手，不写断线那句',
    },
    {
      rel: 'src/web/app.ts',
      note: 'C 握手一成不补发（人对着空白干等五秒）',
      from: '      if (this.list && this.awaitFind) this.findNow();\n',
      to: '',
      expect: '握手一成当场补发那一趟',
    },
    {
      rel: 'src/web/app.ts',
      note: 'D 连回来照旧擦空串（「正在寻」那句提示当场消失，就是用户看到的那个 bug）',
      from: '      if (text) this.list.note.textContent = text;\n      else if (back) this.findNow();',
      to: '      this.list.note.textContent = text;',
      expect: '列表那一支只在断线时写话，连回来不擦空串',
    },
    {
      rel: 'src/web/app.ts',
      note: 'E 已经有清单了也照摆（那行字每五秒闪一下）',
      from: '    if (!this.listed) this.list.note.textContent = SEARCHING;',
      to: '    this.list.note.textContent = SEARCHING;',
      expect: '已经有清单了就不再摆「正在寻」（不闪）',
    },
  ],
};
