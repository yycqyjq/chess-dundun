/** 页面骨架：一次搭好，后面只改文字和位置。牌和座位标记都由 app.ts 摆 */
export interface Shell {
  board: HTMLElement;
  /** 提示文字，在顶栏下面单独一行（原来和按钮挤在桌子底下） */
  status: HTMLElement;
  /** 操作按钮条，浮在桌面里、手牌扇形上方 */
  ctrl: HTMLElement;
  chips: HTMLElement[];
  /** 摸签那一排「第 N 摞」标签：每块罩住一摞的领地，只管文字，点击目标是摞里的牌 */
  pileZones: HTMLElement[];
  toast: HTMLElement;
  drawer: HTMLElement;
  lines: HTMLElement;
  meta: HTMLElement;
  /** 顶栏的声音开关，文字由 app.ts 写（「声音 开」/「声音 关」） */
  sound: HTMLElement;
}

export function buildShell(
  root: HTMLElement,
  players: number,
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
  for (let seat = 0; seat < players; seat++) {
    const chip = div('chip');
    chip.dataset.seat = String(seat);
    chip.append(div('ord'), div('who'), div('tag'), div('count'), div('won'));
    chips.push(chip);
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
  return { board, status: hint, ctrl, chips, pileZones, toast, drawer, lines, meta, sound: btnSound };
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

/** 座位标记里的五格：本墩第几手出（顺时针序）/ 谁 / 此刻在干什么 / 手里几张 / 收了几个墩 */
export function paintChip(
  chip: HTMLElement,
  who: string,
  tag: string,
  count: number,
  won: number,
  ord: number | null,
): void {
  chip.querySelector('.ord')!.textContent = ord === null ? '' : String(ord);
  chip.querySelector('.who')!.textContent = who;
  chip.querySelector('.tag')!.textContent = tag;
  chip.querySelector('.count')!.textContent = count > 0 ? `${count} 张` : '';
  chip.querySelector('.won')!.textContent = won > 0 ? `收 ${won}` : '';
  // 没 tag 就是「这一墩轮到他的牌已经出完了」：不画出来的话，扣着的牌堆看着像在等他出
  chip.classList.toggle('off', ord === null && tag === '');
}

export function toast(el: HTMLElement, html: string, ms: number): void {
  el.innerHTML = html;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  window.setTimeout(() => {
    if (!el.hidden) el.classList.remove('show');
  }, ms);
}

/**
 * 居中弹一张卡：开桌、结算走它（分牌三选一走底部按钮条，牌还得看得见）。
 * build 里拿到 body 自己往里塞，close 由按钮调；lock=true 时点遮罩不算关（不然一局没打完就没了）。
 */
export function popup(
  root: HTMLElement,
  title: string,
  build: (body: HTMLElement, close: () => void) => void,
  lock = false,
): void {
  const veil = div('sheet');
  const card = div('sheet-card');
  const head = div('sheet-head');
  head.textContent = title;
  const body = div('sheet-body');
  const close = () => veil.remove();
  if (!lock) {
    // 点空白处能关，就得在空白处给出小手（卡里面不跟着给，免得读成哪儿都能点）
    veil.classList.add('tap-close');
    veil.addEventListener('click', (ev) => (ev.target === veil ? close() : undefined));
  }
  card.append(head, body);
  veil.append(card);
  root.append(veil);
  build(body, close);
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
