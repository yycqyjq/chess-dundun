/**
 * 摸签那套「手指和鼠标分两套」的刀谱（2026-10-11 安卓真机：一摞点得开、第二下抽不走）。
 *
 * 根子是原来拿**设备能力**猜指针：`matchMedia('(hover: hover)')` 在安卓 WebView 上谎报 true，
 * 于是触屏走了鼠标那一套（摊开靠 hover），可手指点下去没有**持续的** hover。
 * 现在判据全落在**指针事件自己报的 pointerType** 上（`ui.ts` 的 isTouch），
 * 下面每一把刀就拆这一路里的一处，看 `test:style`／`test:ui` 会不会红。
 *
 * 九把刀都是量过的——`expect` 是 2026-10-11 跑 `--verbose` 抄回来的，各钉各的那句。
 */
export default {
  id: 'touch-tap',
  title: '摸签交互：手指和鼠标分两套，判据是指针事件自己报的类型（2026-10-11 安卓真机）',
  via: 'test',
  suite: 'test:style',
  knives: [
    {
      rel: 'src/web/app.ts',
      note: '把那句设备能力猜又搬回来（(hover: hover) 一进代码，安卓就又开始谎报）',
      from:
        "  private pointer: 'mouse' | 'touch' = window.matchMedia('(any-pointer: coarse)').matches ? 'touch' : 'mouse';",
      to: "  private pointer: 'mouse' | 'touch' = window.matchMedia('(hover: hover)').matches ? 'mouse' : 'touch';",
      expect: '不再拿设备能力猜指针（app.ts 的代码里没有 (hover: hover) 那一句）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'pointerdown 上不记那一笔（同一台机器上手指／鼠标来回换就换不回来了）',
      from: "    this.shell.board.addEventListener('pointerdown', (ev) => this.notePointer(ev));",
      to: "    this.shell.board.addEventListener('pointerdown', () => {});",
      expect: 'pointerdown 上记一笔（手指／鼠标来回换都跟得上）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'pointermove 上不记那一笔（主指针是触摸、可也插着鼠标的机器就永远翻不过来）',
      from:
        "    this.shell.board.addEventListener('pointermove', (ev) => {\n      // 鼠标一挪就把这台机器认成鼠标：开头那个「有没有触摸屏」的猜法只撑到第一次真指针动\n      const p = ev as PointerEvent;\n      this.notePointer(p);\n      this.hoverAt(p);\n    });",
      to: "    this.shell.board.addEventListener('pointermove', (ev) => {\n      this.hoverAt(ev as PointerEvent);\n    });",
      expect: '鼠标一挪就把这台机器认成鼠标（pointermove 上也记一笔）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'hoverAt 不挡 touch（手指滑过去就把摊开状态改掉了）',
      from: "  private hoverAt(ev: PointerEvent): void {\n    // 手指挪动也会来 pointermove；摸签那套摊开在触屏上是「点」出来的，不能让手指滑过去改掉\n    if (this.pointer === 'touch') return;\n",
      to: '  private hoverAt(ev: PointerEvent): void {\n',
      expect: '手指挪动不改摊开（hoverAt 里第一句就挡 touch）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'peekPlay 不挡 touch（触屏也走「压上来亮一下」，和点按 toggle 打架）',
      from: "  private peekPlay(el: HTMLElement, on: boolean): void {\n    // 手指那套走「点一下摊开、再点一下收回」（见 tapPiece），不吃压上来亮一下这一路\n    if (this.pointer === 'touch') return;\n",
      to: '  private peekPlay(el: HTMLElement, on: boolean): void {\n',
      expect: '压上来亮一下那一路也挡 touch（触屏走点按 toggle）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'pointerleave 不挡 touch —— 这就是这次 bug 的正身：手指一抬就合上刚点开的那一摞',
      from: "    this.shell.board.addEventListener('pointerleave', () => {\n      if (this.pointer !== 'touch') this.hoverStack(null);\n    });",
      to: "    this.shell.board.addEventListener('pointerleave', () => this.hoverStack(null));",
      expect: '手指抬起那下不合上刚点开的那一摞（pointerleave 只在非 touch 时清）',
    },
    {
      rel: 'src/web/app.ts',
      note: '点牌那支不认触屏（点一下摊开亮给自己看那一路没了）',
      from: "    if (this.pointer === 'touch') {\n      const mine = this.view.freeze?.find((p) => p.seat === this.me && p.ids.includes(id));",
      to: "    if (this.pointer === 'pen') {\n      const mine = this.view.freeze?.find((p) => p.seat === this.me && p.ids.includes(id));",
      expect: '点牌那两套按指针分（触屏走 togglePeek）',
    },
    {
      rel: 'src/web/app.ts',
      note: '摸签那句提示不跟指针换（触屏上照着「鼠标压上来」念，人就更摸不着头脑）',
      from: "            ? this.pointer === 'mouse'",
      to: "            ? this.pointer === 'touch'",
      expect: '摸签那句提示跟着指针类型换（鼠标版／手指版）',
    },
    {
      rel: 'src/web/ui.ts',
      suite: 'test:ui',
      note: 'isTouch 只认 touch 这条口径改掉（手指被当成鼠标，整套判据作废）',
      from: "  return ev.pointerType === 'touch';",
      to: '  return false;',
      expect: '手指：pointerType 是 touch',
    },
  ],
};
