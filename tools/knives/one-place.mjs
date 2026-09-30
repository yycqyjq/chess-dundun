/**
 * 同网桌只摆一处，退出那颗只认数出来的活人（批10）：`app.ts` 经 `rules.json?raw` 进不了 node 测试，
 * 所以这一本的刀全打在 `test:style` 那几条文本质疑上（它读 style.css 和 app.ts 的原文）。
 * 2026-09-29 每把跑过 `npm run knives -- one-place --verbose`，`expect` 从实际红字逐字抄回。
 * 刀口 A 在批11 之后重指过一次：候场厅那一列多了一块「房主位交接那句」（`handed`），append 那行变了。
 * 刀口 C、D 在批12 之后重指过一次：那颗不再按「身后有没有牌桌」分两种名字，改成了共用一份 `BACK`，
 * `test:style` 里那一条的题名也跟着从「退出这桌」改成了「返回」。
 * 跑法：npm run knives -- one-place（全跑就 npm run knives；看每刀全红几句加 --verbose）
 */
export default {
  id: 'one-place',
  title: '同网桌只在列表页那一处：候场厅不摆第二份，「返回」那颗按活人数决定问不问（批10）',
  via: 'test',
  suite: 'test:style',
  knives: [
    {
      rel: 'src/web/app.ts',
      note: 'A 把同网桌那块容器塞回候场厅那一列（两处入口同一件事，早晚走岔）',
      from: '    seatCol.append(rows, handed, invite);',
      to: '    seatCol.append(rows, peers, handed, invite);',
      expect: '椅子那一列只收座位表和邀请，不挂同网桌容器',
    },
    {
      rel: 'src/web/style.css',
      note: 'B 给那块已经没人使的容器留一条 CSS（摘干净了就不该还有 .peers）',
      from: '.peer-list {',
      to: '.peers {\n  display: flex;\n}\n\n.peer-list {',
      expect: 'CSS 里也没留那条没人使的 .peers',
    },
    {
      rel: 'src/web/app.ts',
      note: 'C 那颗出口的字又写回「找同网的桌」（候场厅里不该有这一颗，同网桌的入口只剩列表页）',
      from: '      leave.textContent = BACK;',
      to: "      leave.textContent = '找同网的桌';",
      expect: '整页没有那颗「找同网的桌」（同网桌的入口只剩列表页）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'D 二次确认的门槛从「只剩一个活人」松成「两个以内」（两个人连着也照样散桌）',
      from: '        this.exitTable(this.seated && alive <= 1);',
      to: '        this.exitTable(this.seated && alive <= 2);',
      expect: '那颗「返回」认的是「只剩一个活人」',
    },
    {
      rel: 'src/web/app.ts',
      note: 'E 确认那颗递成清账那句：账归零、椅子一把不动，人还坐在这张要散的桌上',
      from: "            this.link?.send({ t: 'disband' });",
      to: "            this.link?.send({ t: 'reset' });",
      expect: '确认那颗递的是 disband 那句',
    },
  ],
};
