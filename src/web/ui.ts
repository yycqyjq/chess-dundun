import { qrMatrix } from './qr.ts';

/** 页面骨架：一次搭好，后面只改文字和位置。牌和座位标记都由 app.ts 摆 */
export interface Shell {
  board: HTMLElement;
  /** 提示文字，在顶栏下面单独一行（原来和按钮挤在桌子底下） */
  status: HTMLElement;
  /** 操作按钮条，浮在桌面里、手牌扇形上方 */
  ctrl: HTMLElement;
  /** 右上角那张：文字由 app.ts 定——单机「换桌」，联机「离桌」 */
  setup: HTMLElement;
  chips: HTMLElement[];
  /** 每条名字条里那五个格：搭壳子那一次就记下来，画面一秒刷十来回，别再一格一格 querySelector */
  chipEls: ChipEls[];
  /** 摸签那一排「第 N 摞」标签：每块罩住一摞的领地，只管文字，点击目标是摞里的牌 */
  pileZones: HTMLElement[];
  toast: HTMLElement;
  drawer: HTMLElement;
  lines: HTMLElement;
  meta: HTMLElement;
  /** 顶栏的声音开关，文字由 app.ts 写（「声音 开」/「声音 关」） */
  sound: HTMLElement;
}

export interface ChipEls {
  ord: HTMLElement;
  who: HTMLElement;
  tag: HTMLElement;
  count: HTMLElement;
  won: HTMLElement;
}

/**
 * 台面壳子。座位标记按 `maxSeats` 建够、只亮 `players` 条：
 * 房主在候场厅把 2 人改成 4 人，画面这边不用重搭壳子——重搭会把牌、事件、动画全丢在原地。
 */
export function buildShell(
  root: HTMLElement,
  players: number,
  maxSeats: number,
  onSetup: () => void,
  onLog: () => void,
  onSound: () => void,
): Shell {
  root.innerHTML = '';
  const bar = div('bar');
  const brand = div('brand');
  brand.textContent = '棋墩墩';
  const meta = div('meta');
  const btns = div('btns');
  const btnLog = button('复盘');
  const btnSetup = button('换桌');
  const btnSound = button('声音');
  btnLog.addEventListener('click', onLog);
  btnSetup.addEventListener('click', onSetup);
  btnSound.addEventListener('click', onSound);
  btns.append(btnSound, btnLog, btnSetup);
  bar.append(brand, meta, btns);

  const stage = div('stage');
  const board = div('board');
  const chips: HTMLElement[] = [];
  const chipEls: ChipEls[] = [];
  for (let seat = 0; seat < maxSeats; seat++) {
    const chip = div('chip');
    chip.dataset.seat = String(seat);
    chip.hidden = seat >= players;
    const parts: ChipEls = { ord: div('ord'), who: div('who'), tag: div('tag'), count: div('count'), won: div('won') };
    chip.append(parts.ord, parts.who, parts.tag, parts.count, parts.won);
    chips.push(chip);
    chipEls.push(parts);
    board.append(chip);
  }
  const pileZones: HTMLElement[] = [];
  for (let i = 0; i < 8; i++) {
    const zone = div('pile-zone');
    const cap = div('cap');
    cap.textContent = `第 ${i + 1} 摞`;
    zone.append(cap);
    pileZones.push(zone);
    board.append(zone);
  }
  const ctrl = div('ctrl');
  board.append(ctrl);
  stage.append(board);

  const hint = div('status');
  const toast = div('toast');
  toast.hidden = true;
  const drawer = div('drawer');
  drawer.hidden = true;
  const head = div('drawer-head');
  const close = button('收起');
  close.addEventListener('click', () => (drawer.hidden = true));
  head.append(document.createTextNode('复盘'), close);
  const lines = div('lines');
  drawer.append(head, lines);

  root.append(bar, hint, stage, toast, drawer);
  return {
    board,
    status: hint,
    ctrl,
    setup: btnSetup,
    chips,
    chipEls,
    pileZones,
    toast,
    drawer,
    lines,
    meta,
    sound: btnSound,
  };
}

export function div(cls: string, text = ''): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  return el;
}

export function span(cls: string, text = ''): HTMLElement {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

export function button(text: string, onClick?: () => void, cls = 'btn'): HTMLButtonElement {
  const el = document.createElement('button');
  el.className = cls;
  el.type = 'button';
  el.textContent = text;
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

/** 一条真能点的地址（不是按钮）：长按能拷、鼠标悬上去看得见去哪儿，这正是要人自己挑桌时该有的样子 */
export function anchor(text: string, href: string, cls = 'btn'): HTMLAnchorElement {
  const el = document.createElement('a');
  el.className = cls;
  el.href = href;
  el.textContent = text;
  return el;
}

/**
 * 把一句话画成能扫的二维码。canvas 底图一格一像素，靠 CSS 整数倍放大配 pixelated，
 * 放大多少倍都还是方块，不会糊成一片灰。装不下（超 78 字节）回 null，让界面退回只显文字。
 */
export function qrCanvas(text: string, wantPx = 200): HTMLCanvasElement | null {
  const grid = qrMatrix(text);
  if (!grid) return null;
  const quiet = 4; // 规范要求四周留 4 格留白，扫的人贴得再近也找得到边
  const n = grid.length + quiet * 2;
  const c = document.createElement('canvas');
  c.width = n;
  c.height = n;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, n, n);
  ctx.fillStyle = '#000';
  for (let y = 0; y < grid.length; y++)
    for (let x = 0; x < grid.length; x++) if (grid[y]![x]!) ctx.fillRect(x + quiet, y + quiet, 1, 1);
  // 显示尺寸必须是格数的整数倍，不然浏览器又要自己插值
  c.style.width = `${n * Math.max(3, Math.round(wantPx / n))}px`;
  c.className = 'qr';
  c.setAttribute('aria-label', text);
  return c;
}

/** 座位标记里的五格：本墩第几手出（顺时针序）/ 谁 / 此刻在干什么 / 手里几张 / 收了几个墩 */
export function paintChip(
  chip: HTMLElement,
  parts: ChipEls,
  who: string,
  tag: string,
  count: number,
  won: number,
  ord: number | null,
): void {
  parts.ord.textContent = ord === null ? '' : String(ord);
  parts.who.textContent = who;
  parts.tag.textContent = tag;
  parts.count.textContent = count > 0 ? `${count} 张` : '';
  parts.won.textContent = won > 0 ? `收 ${won}` : '';
  // 没 tag 就是「这一墩轮到他的牌已经出完了」：不画出来的话，扣着的牌堆看着像在等他出
  chip.classList.toggle('off', ord === null && tag === '');
}

/**
 * 状态栏那句提示：加粗的两个名字是拼出来的，别再走 innerHTML——
 * 这一条路现在也给了 toast，而 toast 里会有别人自填的代号，那是要能原样显示的文本。
 */
export function rich(el: HTMLElement, parts: (string | { b: string })[]): void {
  el.textContent = '';
  for (const p of parts) {
    if (typeof p === 'string') el.append(document.createTextNode(p));
    else {
      const b = document.createElement('b');
      b.textContent = p.b;
      el.append(b);
    }
  }
}

/** 一句话浮在台面上。文字照原样显，别当 HTML 解析——桌上别人的代号里可能带尖括号 */
export function toast(el: HTMLElement, text: string, ms: number): void {
  el.textContent = text;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  window.setTimeout(() => {
    if (!el.hidden) el.classList.remove('show');
  }, ms);
}

/**
 * 一张卡：标题在顶、内容自己滚、底栏不跟着滚。`build` 拿到 body 往里塞配置，
 * 主按钮塞 foot——那颗按钮要是住在 body 里，手机上滚到底才看得见它，等于按不到。
 * `close` 由按钮调；lock=true 时点遮罩不算关（不然一局没打完就没了）。
 */
export function popup(
  root: HTMLElement,
  title: string,
  build: (body: HTMLElement, close: () => void, foot: HTMLElement) => void,
  lock = false,
): void {
  const c = card(root, title);
  if (!lock) {
    // 点空白处能关，就得在空白处给出小手（卡里面不跟着给，免得读成哪儿都能点）
    c.veil.classList.add('tap-close');
    c.veil.addEventListener('click', (ev) => (ev.target === c.veil ? c.close() : undefined));
  }
  build(c.body, c.close, c.foot);
}

/** 摆一张卡进 root，返回那三块。候场厅常驻，直接用它，不走 popup 那层临场搭拆 */
export function card(
  root: HTMLElement,
  title: string,
  cls = '',
): { veil: HTMLElement; head: HTMLElement; body: HTMLElement; foot: HTMLElement; close: () => void } {
  const veil = div('sheet');
  const el = div(`sheet-card ${cls}`);
  const head = div('sheet-head', title);
  const body = div('sheet-body');
  const foot = div('sheet-foot');
  // 三块都是卡片的直接孩子：滚动只发生在 body 里，foot 因此在 CSS 上钉得住
  el.append(head, body, foot);
  veil.append(el);
  root.append(veil);
  return { veil, head, body, foot, close: () => veil.remove() };
}

/** 一排互斥选项，点谁把谁标上 on。开桌那张卡用它选人设、玩法、难度 */
export function segment<T>(
  caption: string,
  options: { text: string; value: T }[],
  initial: T,
  onPick: (value: T) => void,
): HTMLElement {
  const row = div('seg-row');
  row.append(span('seg-cap', caption));
  const group = div('seg');
  options.forEach((opt) => {
    const b = button(opt.text, () => {
      for (const el of group.children) el.classList.remove('on');
      b.classList.add('on');
      onPick(opt.value);
    }, 'btn seg-btn');
    if (opt.value === initial) b.classList.add('on');
    group.append(b);
  });
  row.append(group);
  return row;
}
