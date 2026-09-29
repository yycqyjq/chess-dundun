/**
 * 批3（流畅度＋两处一碰就白屏）里界面那三把的刀谱，搬自会话老脚本 `run-knives-b3.mjs`（A／B／E，刀口一字未改，2026-09-29 核对仍在源码里）。
 * 三把都跑 `test:ui`：浮话写回 innerHTML、名字条只建这桌这几条、音量开关直接读 localStorage。
 * `expect` 是 2026-09-29 从 `--verbose` 的实际红字里抄的（第 1 把红 2 条、第 2 把红 1 条、第 3 把红 2 条）。
 * 第 3 把拆完之后 `src/web/ui.test.ts:396` 会抛（`s!` 是 null），后半套跑不到——它前面已经打出自己那句 ✗，所以钉得住。
 */
export default {
  id: 'ui-no-crash',
  title: '界面这三处不许当场炸：浮话走 textContent、名字条建够 maxSeats、开关读得到才写',
  via: 'test',
  suite: 'test:ui',
  knives: [
    {
      rel: 'src/web/ui.ts',
      note: 'A 浮话回到 innerHTML（别人的代号里带标签就当场执行）',
      from: `export function toast(el: HTMLElement, text: string, ms: number): void {
  el.textContent = text;`,
      to: `export function toast(el: HTMLElement, text: string, ms: number): void {
  el.innerHTML = text;`,
      expect: '带尖括号的代号原样显出来，一个元素都没多',
    },
    {
      rel: 'src/web/ui.ts',
      note: 'B 名字条只建这桌这几条（2 人桌涨到 4 人就按一下空位）',
      from: `  for (let seat = 0; seat < maxSeats; seat++) {`,
      to: `  for (let seat = 0; seat < players; seat++) {`,
      expect: '台面建足四把名字条，只亮这桌两人在的那两条',
    },
    {
      rel: 'src/web/sound.ts',
      note: 'C 音量开关直接读 localStorage（无痕模式一碰就抛＝整桌白屏）',
      from: `  private on = remembered() !== 'off';`,
      to: `  private on = localStorage.getItem(KEY) !== 'off';`,
      expect: '开桌第一下就要读音量开关：存不下来也得开得出去',
    },
  ],
};
