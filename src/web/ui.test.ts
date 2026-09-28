/**
 * 画面那层的守卫测试：ui.ts／pieces.ts／sound.ts 是全桌仅有的往 DOM 和浏览器存储上伸手的三处。
 * 没有浏览器（自动化那条路被拦着），所以这儿捏一套够它们用的假 DOM，
 * 钉住五件真会出事的事：别人自填的代号被当 HTML 解析、名字条的条数跟不上桌的人数、
 * 一桌子牌挪一拍逼一次重排（不是每张逼一次）、无痕模式的存储一碰就抛把整张桌白屏、
 * 寻到的那条桌是一个真 href 的 <a>（不拿 JS 拼跳转、也不往 HTML 里写字）。
 *
 * 放 src/web 是有原因的：tsconfig.json 不带 DOM 库。
 * 全文件（连假元素自己）都不许用构造器参数属性——`--experimental-strip-types` 只抹类型，不改写赋值。
 */
import { anchor, buildShell, button, card, paintChip, popup, rich, segment, toast, type Shell } from './ui.ts';
import { appVersion, homePanel, initialScreen, isLoopback } from './home.ts';
import { buildPieceSet, buildRanks, type Piece } from '../core/pieces.ts';
import { Pieces } from './pieces.ts';
import { Sound } from './sound.ts';
import type { Placed } from './board.ts';

let failures = 0;
/** 这一拍里问了DOM多少次布局（每次都是一场强制重排） */
let reads = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 一个假元素：ui.ts 用到哪几个洞就挖哪几个洞，别多 */
class FEl {
  tag: string;
  children: FEl[] = [];
  parent: FEl | undefined;
  names = new Set<string>();
  attrs: Record<string, string> = {};
  listeners = new Map<string, ((ev: unknown) => void)[]>();
  hidden = false;
  disabled = false;
  type = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  isText = false;
  raw = '';
  /** 谁往这儿写过一段 HTML，全记下来 */
  html: string[] = [];

  constructor(tag: string) {
    this.tag = tag;
  }

  get classList(): {
    add: (...n: string[]) => void;
    remove: (...n: string[]) => void;
    contains: (n: string) => boolean;
    toggle: (n: string, on?: boolean) => void;
  } {
    const self = this;
    return {
      add: (...n) => n.forEach((x) => self.names.add(x)),
      remove: (...n) => n.forEach((x) => self.names.delete(x)),
      contains: (n) => self.names.has(n),
      toggle: (n, on) => {
        const want = on ?? !self.names.has(n);
        if (want) self.names.add(n);
        else self.names.delete(n);
      },
    };
  }
  set classList(_v: unknown) {
    // 没人往回赋，留着是让 TS 别把只读 getter 当成不可写
  }

  get className(): string {
    return [...this.names].join(' ');
  }
  set className(v: string) {
    this.names.clear();
    for (const c of v.split(' ')) if (c) this.names.add(c);
  }

  get textContent(): string {
    return this.isText ? this.raw : this.children.map((c) => c.textContent).join('') + this.raw;
  }
  set textContent(v: string) {
    this.children.length = 0;
    this.raw = v ?? '';
  }

  set innerHTML(v: string) {
    this.html.push(v);
    if (!v) this.children.length = 0;
  }

  append(...ns: FEl[]): void {
    for (const n of ns) {
      n.parent = this;
      this.children.push(n);
    }
  }
  remove(): void {
    const p = this.parent;
    if (p) p.children.splice(p.children.indexOf(this), 1);
  }
  addEventListener(kind: string, fn: (ev: unknown) => void): void {
    const at = this.listeners.get(kind) ?? [];
    at.push(fn);
    this.listeners.set(kind, at);
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn({ target: this });
  }
  /** 读一次布局，浏览器就得先把刚写的那些样式算一遍——掉帧就掉在这儿，测试盯着这个数 */
  get offsetWidth(): number {
    reads++;
    return 40;
  }
  /** 整棵子树里按标签名找 */
  findAll(tag: string): FEl[] {
    const hit = this.children.filter((c) => c.tag === tag);
    for (const c of this.children) hit.push(...c.findAll(tag));
    return hit;
  }
  find(cls: string): FEl | undefined {
    return this.children.find((c) => c.names.has(cls));
  }
  /** 这棵子树里所有写过 HTML 的地方 */
  get allHtml(): string[] {
    const out = [...this.html];
    for (const c of this.children) out.push(...c.allHtml);
    return out;
  }
  countHtml(): number {
    return this.allHtml.length;
  }
}

interface Seen {
  chips: FEl[];
  chipEls: { ord: FEl; who: FEl; tag: FEl; count: FEl; won: FEl }[];
  pileZones: FEl[];
  status: FEl;
  ctrl: FEl;
  toast: FEl;
  board: FEl;
}

const H = (x: unknown): HTMLElement => x as unknown as HTMLElement;
const F = (x: HTMLElement): FEl => x as unknown as FEl;
const seen = (s: Shell): Seen => s as unknown as Seen;

const doc = {
  createElement: (tag: string) => new FEl(tag),
  createTextNode: (s: string) => {
    const el = new FEl('#text');
    el.isText = true;
    el.raw = s;
    return el;
  },
};
const G = globalThis as unknown as Record<string, unknown>;
G.document = doc;
G.window = { setTimeout: () => 1 };

// ---------- 壳子：名字条建够，多的藏起来 ----------

{
  const root = new FEl('div');
  const shell = buildShell(H(root), 2, 4, () => {}, () => {}, () => {});
  const v = seen(shell);
  ok(
    '台面建足四把名字条，只亮这桌两人在的那两条',
    v.chips.length === 4 && !v.chips[0]!.hidden && !v.chips[1]!.hidden && v.chips[2]!.hidden && v.chips[3]!.hidden,
    v.chips.map((c, i) => `${i}:${c.hidden ? '藏' : '亮'}`).join(' '),
  );
  ok('每条里那五个格一次记全，画的时候不必再翻 DOM', v.chipEls.every((p) => Object.values(p).every((el) => el instanceof FEl)));
  ok(
    '那五个格还是原来那五个名头',
    [...Object.values(v.chipEls[0]!)].map((el) => [...el.names][0]).join(',') === 'ord,who,tag,count,won',
    [...Object.values(v.chipEls[0]!)].map((el) => [...el.names].join('+')).join(','),
  );
  ok('八摞标签照旧八块', v.pileZones.length === 8);
  ok(
    '五格都挂在自己那条名字条下面',
    v.chipEls.every((p) => Object.values(p).every((el) => el.parent === v.chips[v.chipEls.indexOf(p)])),
  );
  ok(
    '整台壳子里唯一一次 HTML 写入是把 root 清空',
    root.allHtml.length === 1 && root.allHtml[0] === '',
    root.allHtml.join('｜'),
  );
}

// ---------- 座位标记写进对的格子 ----------

{
  const v = seen(buildShell(H(new FEl('div')), 4, 4, () => {}, () => {}, () => {}));
  const chip = v.chips[2]!;
  const parts = v.chipEls[2]!;
  const paint = (who: string, tag: string, count: number, won: number, ord: number | null): void =>
    paintChip(H(chip), H(parts) as never, who, tag, count, won, ord);
  paint('你', '已出', 3, 2, 1);
  ok(
    '五格各归各：次序／谁／在干什么／几张／收了几枚',
    parts.ord.raw === '1' && parts.who.raw === '你' && parts.tag.raw === '已出' && parts.count.raw === '3 张' && parts.won.raw === '收 2',
  );
  paint('你', '', 0, 0, null);
  ok(
    '空手又没 tag 就是「这墩他出完了」：亮 off，两格留白',
    chip.names.has('off') && parts.count.raw === '' && parts.won.raw === '',
  );
  paint('你', '在想', 0, 0, null);
  ok('有 tag 就不算出完：off 撤掉', !chip.names.has('off'));
  ok('写进条里的字全走 textContent，一路没拼 HTML', chip.countHtml() === 0);
}

// ---------- 浮一句话：不许当 HTML 解析 ----------

{
  const el = new FEl('div');
  const words = 'P2 的代号 <img onerror=alert(1)> 两分钟没回来';
  toast(H(el), words, 1200);
  ok('带尖括号的代号原样显出来，一个元素都没多', el.raw === words && el.children.length === 0, el.textContent);
  ok('这条路根本不碰 innerHTML', el.html.length === 0);
  ok('浮条亮起来了', !el.hidden && el.names.has('show'));
}

// ---------- 状态栏那句带粗体的 ----------

{
  const el = new FEl('div');
  rich(H(el), ['P1 翻出 ', { b: '红车' }, '，5 点从自己数到 ', { b: '你' }, '：这 8 摞怎么分你定']);
  ok('粗体是拼出来的节点，不是拼出来的字符串', el.findAll('b').map((b) => b.raw).join('|') === '红车|你');
  ok('连起来读还是那句话', el.textContent === 'P1 翻出 红车，5 点从自己数到 你：这 8 摞怎么分你定', el.textContent);
  ok('这一路也没走 innerHTML', el.countHtml() === 0);
  const evil = new FEl('div');
  rich(H(evil), ['有人翻了 ', { b: '<script>alert(1)</script>' }]);
  ok('就算塞进来的是标签也当字面显示', evil.findAll('script').length === 0 && evil.textContent === '有人翻了 <script>alert(1)</script>');
}

// ---------- 一排互斥选项 ----------

{
  const picked: number[] = [];
  const row = F(segment('坐几个人', [{ text: '2 人', value: 2 }, { text: '4 人', value: 4 }], 4, (v) => picked.push(v)));
  const btns = row.findAll('button');
  ok('两颗选项，选中的那颗标着 on', btns.length === 2 && btns[1]!.names.has('on') && !btns[0]!.names.has('on'));
  btns[0]!.click();
  ok(
    '点一下就把 on 挪过来，另一颗自己退下去',
    picked.join(',') === '2' && btns[0]!.names.has('on') && !btns[1]!.names.has('on'),
  );
  btns[0]!.click();
  ok('连着点同一颗只挂一个监听：点两下报两回，不重不漏', picked.join(',') === '2,2' && btns[0]!.listeners.get('click')!.length === 1);
}

// ---------- 居中的那张卡 ----------

{
  const root = new FEl('div');
  let closed = 0;
  const given: FEl[] = [];
  popup(H(root), '这一局打完', (body, close, foot) => {
    given.push(F(foot));
    body.append(
      button('收下', () => {
        closed++;
        close();
      }),
    );
  });
  const veil = root.children[0]!;
  const card = veil.find('sheet-card')!;
  const btn = card.findAll('button').find((b) => b.raw === '收下')!;
  btn.click();
  ok('卡里的按钮按得动，按完那张卡就从根上摘了', closed === 1 && root.children.length === 0, `closed=${closed} 根上还有 ${root.children.length} 张`);
  ok('搭卡全程没写过 HTML', root.countHtml() === 0);
  ok('build 拿到的第三块就是那张底栏', given.length === 1 && given[0]!.names.has('sheet-foot'));
}

// ---------- 卡分三块：标题、会滚的内容、钉住的底栏 ----------

{
  const root = new FEl('div');
  const c = card(H(root), '候场厅', 'room');
  const veil = root.children[0]!;
  const el = veil.find('sheet-card')!;
  const body = el.find('sheet-body')!;
  const foot = el.find('sheet-foot')!;
  ok('标题／内容／底栏都是卡的直接孩子', el.children.length === 3 && el.children[1] === body && el.children[2] === foot);
  // 主按钮住在会滚的那块里，手机上就得先滚到底才摸得到——这条钉的是「底栏不在内容块里面」
  ok('底栏不在内容块里（它不跟着滚）', !body.children.includes(foot) && foot.parent === el);
  ok('底栏排在最后（钉在卡底那一头）', el.children[el.children.length - 1] === foot);
  ok('滚的那块是内容块', [...body.names].includes('sheet-body'));
  ok('cls 挂在卡上：.room 那些选择器才有得挑', [...el.names].includes('room') && [...el.names].includes('sheet-card'));
  ok('标题写着传进去那句', el.find('sheet-head')!.textContent === '候场厅');
  c.close();
  ok('close 摘掉的是整张遮罩', root.children.length === 0);
}

// ---------- 挪牌：整桌逼一次重排，不是每张逼一次 ----------

const deck: Piece[] = buildPieceSet(
  buildRanks([
    { name: '车', redLabel: '红车', blackLabel: '黑车', count: [2, 2] },
    { name: '马', redLabel: '红马', blackLabel: '黑马', count: [2, 2] },
  ]),
);

function spot(x: number, over: Partial<Placed> = {}): Placed {
  return { x, y: 0, rot: 0, scale: 1, down: false, z: 1, delay: 0, cls: '', ...over };
}

function planOf(spotFor: (i: number) => Placed): Map<number, Placed> {
  const out = new Map<number, Placed>();
  deck.forEach((p, i) => out.set(p.id, spotFor(i)));
  return out;
}

{
  const root = new FEl('div');
  const ps = new Pieces(H(root), deck);
  const els = root.children;
  ok('一副牌一颗不落摆进台面，落位之前全扣着', els.length === deck.length && els.every((e) => e.hidden));

  reads = 0;
  ps.place(planOf((i) => spot(i * 10)), true);
  ok('第一帧没有上一帧可比：一次布局都不问', reads === 0, `reads=${reads}`);
  ok('八颗都亮了，各按各的坐标落', els.every((e) => !e.hidden) && els[3]!.style.transform === 'translate(30px, 0px) rotate(0deg) scale(1)');

  reads = 0;
  ps.place(planOf((i) => spot(200 + i * 10, { delay: i * 30, rot: 90 })), true);
  ok('八颗一起挪：只逼一次重排', reads === 1, `reads=${reads}`);
  ok(
    '落的是新位置，补间带着各自那点延迟',
    els[3]!.style.transform === 'translate(230px, 0px) rotate(90deg) scale(1)' && els[3]!.style.transition.includes('90ms'),
    `${els[3]!.style.transform}｜${els[3]!.style.transition}`,
  );

  reads = 0;
  ps.place(planOf((i) => spot(200 + i * 10, { delay: i * 30, rot: 90 })), true);
  ok('原样再摆一遍：一张都没挪，也就不问布局', reads === 0, `reads=${reads}`);

  reads = 0;
  ps.place(planOf((i) => spot(400 + i)), false);
  ok('桌面尺寸变了那种重摆不补间：照样落位，一次都不问', reads === 0 && els[0]!.style.transform === 'translate(400px, 0px) rotate(0deg) scale(1)', `reads=${reads}`);

  for (let k = 0; k < 6; k++) ps.place(planOf((i) => spot(500 + k * 40 + i)), true);
  ok(
    '连挪六拍，每颗牌身上还是只有一个收尾监听（不攒半路掐下一拍的）',
    els.every((e) => (e.listeners.get('transitionend') ?? []).length === 1),
    els.map((e) => (e.listeners.get('transitionend') ?? []).length).join(','),
  );

  ps.place(planOf((i) => spot(700 + i, { cls: 'sel hand' })), false);
  ok('附加类按这一拍的写', els[1]!.names.has('sel') && els[1]!.names.has('hand'));
  ps.place(planOf((i) => spot(700 + i, { cls: 'dim' })), false);
  ok('上一拍的类撤得干净：sel／hand 没了，dim 才是这一拍的', !els[1]!.names.has('sel') && !els[1]!.names.has('hand') && els[1]!.names.has('dim'));

  const only = new Map<number, Placed>();
  only.set(deck[0]!.id, spot(900));
  reads = 0;
  ps.place(only, true);
  ok('只挪一颗也只问一次；不在这一拍计划里的牌扣起来', reads === 1 && els[5]!.hidden);
}

// ---------- 无痕模式：一碰 localStorage 就抛，桌不能因此白屏 ----------

{
  const boom = () => {
    throw new Error('SecurityError：这台设备不让存东西');
  };
  G.localStorage = { getItem: boom, setItem: boom, removeItem: boom };
  let threw = '';
  let s: Sound | null = null;
  try {
    s = new Sound();
  } catch (e) {
    threw = String((e as Error).message);
  }
  ok('开桌第一下就要读音量开关：存不下来也得开得出去', threw === '' && s !== null, threw);
  let later = '';
  try {
    s!.cue('flip');
    s!.toggle();
  } catch (e) {
    later = String((e as Error).message);
  }
  ok('先响一声（这台机器没有 AudioContext，就该安静地当没声音），再翻开关，一路都不抛', later === '', later);
  ok('记不住也认这次翻的结果', s!.enabled === false);
  const store = new Map<string, string>();
  G.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const t = new Sound();
  ok('存得下来的那台机器：翻一次就记住，下次开桌还认', t.toggle() === false && store.get('chess-dundun:sound') === 'off' && new Sound().enabled === false);
}

// ---------- 首页：进门落在哪一页、那两个入口点了往哪儿走 ----------

{
  const homeHosts = ['localhost', '127.0.0.1', '127.8.9.9', '::1', '[::1]'];
  const roomHosts = ['192.168.1.7', '10.0.0.3', '172.16.0.9', 'chess.lan', 'example.com'];
  const badHome = homeHosts.filter((h) => initialScreen(h) !== 'home');
  const badRoom = roomHosts.filter((h) => initialScreen(h) !== 'room');
  ok('本机那几个地址都停在首页', badHome.length === 0, badHome.join(','));
  ok('别处的地址一律直落候场厅：拿着链接进来的人不再被问一遍', badRoom.length === 0, badRoom.join(','));
  ok('首页不写进邀请那把尺子是同一个口径', isLoopback('127.0.0.1') && !isLoopback('192.168.1.7'));

  let solo = 0;
  let net = 0;
  const panel = F(homePanel(() => solo++, () => net++));
  const names = [...panel.names];
  ok('首页是一整块 .home，里头四块依序排', names.includes('home'), names.join('+'));
  const kids = panel.children.map((c) => [...c.names][0]);
  ok('抬头／要点／入口／脚，四块一块不多一块不少', kids.join(',') === 'home-title,home-brief,home-entries,home-foot', kids.join(','));
  ok('抬头是名字、要点是那三个数', panel.children[0]!.raw === '棋墩墩' && /32 枚.*黑 < 红/.test(panel.children[1]!.raw), panel.children[1]!.raw);

  const entries = panel.findAll('button');
  ok('两个入口各是一整块按钮，不是 div（键盘 Tab 走得到）', entries.length === 2 && entries.every((e) => e.tag === 'button' && e.type === 'button'));
  ok('顺序是「自己玩」在前、「同一张网」在后', entries[0]!.textContent.includes('自己玩') && entries[1]!.textContent.includes('同一张网'));
  ok(
    '每块里两个格：大字说做什么、小字说谁来补',
    entries.every((e) => {
      const head = e.find('e');
      const note = e.find('n');
      return !!head && !!note && head.raw !== '' && note.raw !== '';
    }),
    entries.map((e) => e.children.map((c) => [...c.names][0]).join('+')).join(','),
  );
  entries[0]!.click();
  ok('点第一块只去单机，不顺手把连接也开起来', solo === 1 && net === 0, `solo ${solo}／net ${net}`);
  entries[1]!.click();
  entries[1]!.click();
  ok('点第二块去联机，点两下就是走两下（没串到单机那半）', solo === 1 && net === 2, `solo ${solo}／net ${net}`);
  ok('首页这一整块不往 HTML 里塞任何一句话', panel.countHtml() === 0, panel.allHtml.join('｜'));

  const foot = panel.find('home-foot')!;
  ok('没注上版本时宁可少那一行，也不念一个 undefined', !foot.find('v') && appVersion() === '', foot.children.map((c) => c.raw).join(','));
  G.__APP_VERSION__ = '0.1.0';
  const withVersion = F(homePanel(() => {}, () => {})).find('home-foot')!;
  ok('注上了就在脚上念 v0.1.0，那句联机提示还在', withVersion.find('v')!.raw === 'v0.1.0' && withVersion.children.length === 2, withVersion.children.map((c) => c.raw).join(','));
  delete G.__APP_VERSION__;
}

// ---------- 寻到的那张桌：一行情况加一条真能点的地址 ----------

{
  const url = 'http://192.168.1.41:5200/';
  const el = F(anchor('2 人 · 扣棋', url, 'btn mini peer-link'));
  const read = (k: string) => (el as unknown as Record<string, string>)[k];
  ok('是一条 <a>：进桌就是让浏览器自己走一趟，不拿 JS 拼跳转', el.tag === 'a' && !(el.listeners.get('click') ?? []).length, `tag=${el.tag} 监听 ${el.listeners.get('click')?.length ?? 0} 个`);
  ok('地址挂在 href 上，一个字都没往 HTML 里写', read('href') === url && el.countHtml() === 0, `${read('href')}｜${el.allHtml.join('｜')}`);
  ok('屏幕上那行字点之前就看得见去哪儿', el.textContent === '2 人 · 扣棋' && read('href') !== el.textContent);
  ok('名头带着 btn：跟旁边那颗按钮一样是个能点的东西', el.className === 'btn mini peer-link', el.className);
  const plain = F(anchor(url, url));
  ok('不点名头也是颗按钮的样子（候场厅那条默认值）', plain.className === 'btn', plain.className);
}

console.log(failures ? `\n${failures} 条没过` : '\n全部通过');
(G.process as { exit(code: number): void }).exit(failures ? 1 : 0);
