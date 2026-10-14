/**
 * 摸签那排摞标签的刀谱（2026-10-14 用户：「这个第几摞 不能换行 不行就修改展示形式」）。
 *
 * 病根是几何，不是文案品味：领地的宽度是 board.ts 的 `cw × 1.12`，10 摞那一档手机上
 * 只有 29～33px（360 屏 33.2、320 屏 29.4），而「第 N 摞」在 11px 字号下最少要 33.5px、
 * 「第 10 摞」要 40.5px——一超就折成两行，折出来的「第 1／摞」比没标签还难认。
 * 真浏览器量过四档（360／320／430 三档 3 人 10 摞 ＋ 360 的 2 人 8 摞）：
 * 「N 摞」19.3／26.3px，**四档全部一行装得下**；「第 N 摞」在 10 摞那三档全折。
 *
 * 两头各钉一把：
 *   A 文案写回「第 N 摞」——10 摞那一档当场折行；
 *   B 抽掉 `white-space: nowrap`——领地里没了「宁可溢出也不折行」这条底线，
 *     哪天文案或回退字体（系统没有 PingFang 时）又把它撑宽了，就悄悄折成两行。
 * A 跑 test:ui（读 DOM 里首末两块标签的字），B 跑 test:style（读 `.pile-zone .cap` 那条声明）。
 */
export default {
  id: 'pile-cap',
  title: '摸签那排摞标签一行装得下、且不许折行（2026-10-14 用户点名）',
  knives: [
    {
      rel: 'src/web/ui.ts',
      note: 'A 摞标签写回「第 N 摞」：10 摞那一档领地只有 29～33px，比它最短的写法还窄，当场折成两行',
      suite: 'test:ui',
      from: '    cap.textContent = `${i + 1} 摞`;',
      to: '    cap.textContent = `第 ${i + 1} 摞`;',
      expect: '摞标签只写「N 摞」',
    },
    {
      rel: 'src/web/style.css',
      note: 'B 抽掉 white-space: nowrap：没了「宁可溢出也不折行」这条底线，文案或回退字体一变就折行',
      suite: 'test:style',
      from: '  opacity: 0.8;\n  transition: opacity 150ms ease-out;\n  white-space: nowrap;\n',
      to: '  opacity: 0.8;\n  transition: opacity 150ms ease-out;\n',
      expect: '摞标签不许折行',
    },
  ],
};
