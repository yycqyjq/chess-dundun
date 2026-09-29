/**
 * 移动端布局那五处结构改动（批5 #38，捞回自 b7 A/B/C/D/E）：谁在滚、座位行摊两排、顶栏不裁字、
 * 名字条钉哪一头、底栏挂在哪儿。三套闸混在一本里——A/B/C 打 `style.css` 的三条契约（`test:style`），
 * D 打 `board.ts` 那句手写的 `edge`（`test:layout`），E 把底栏塞回滚动区里（`test:ui`）。
 * 五把的刀口都还对得上现源码，`expect` 是 2026-09-28 跑 `--verbose` 抄回来的，各钉各的那句。
 */
export default {
  id: 'mobile-stack',
  title: '手机竖屏那一套：卡不整张滚、座位行摊两排、顶栏不裁字、名字条钉对边、底栏不跟着滚（批5 #38，捞回自 b7 A/B/C/D/E）',
  via: 'test',
  suite: 'test:style',
  knives: [
    {
      rel: 'src/web/style.css',
      note: 'A 让整张卡自己滚（底栏跟着滚走，回到「先滚到底才摸到开始」）',
      from: '.sheet-body {\n  flex: 1;\n  min-height: 0;\n  overflow: auto;',
      to: '.sheet-body {\n  flex: 1;',
      expect: '内容那块才滚（.sheet-body: overflow: auto）',
    },
    {
      rel: 'src/web/style.css',
      note: 'B 座位行退回一行挤（状态那句跟按钮抢同一条横线）',
      from: '.seat-row .t {\n  grid-area: 2 / 1;',
      to: '.seat-row .t {\n  flex: 1;',
      expect: '状态那句落在第二行',
    },
    {
      rel: 'src/web/style.css',
      note: 'C 顶栏那行改回省略号裁字（手机上「第几局」「我是 P1」又被吃掉）',
      from: '  white-space: normal;\n  overflow-wrap: anywhere;',
      to: '  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;',
      expect: '.meta 不再用省略号裁字',
    },
    {
      rel: 'src/web/board.ts',
      suite: 'test:layout',
      note: 'D 左边那条名字条的 edge 写成 right（钉反半边）｜和 seat-rot 那三把同属一族断言，钉的是它自己那句 P1',
      from: "band(1, left, topBand(board) + LABEL_GAP, 'left')",
      to: "band(1, left, topBand(board) + LABEL_GAP, 'right')",
      expect: '手机竖屏 390×844｜4 人 我坐 P1 每条名字条和自家那摞同侧',
    },
    {
      rel: 'src/web/ui.ts',
      suite: 'test:ui',
      note: 'E 底栏挂进内容块里（CSS 再怎么钉也钉不住）｜那句 ✗ 打出来之后 ui.test.ts:298 会抛（find 不到 sheet-foot），后半套跑不到——这把只钉得住这一句',
      from: '  el.append(head, body, foot);',
      to: '  el.append(head, body);\n  foot.remove();\n  body.append(foot);',
      expect: '标题／内容／底栏都是卡的直接孩子',
    },
  ],
};
