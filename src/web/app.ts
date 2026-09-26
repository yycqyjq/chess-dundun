import { choose, LEVELS, type Level } from '../ai/agent.ts';
import {
  apply,
  createGame,
  legalActions,
  pendingSeats,
  seatName,
  type Action,
  type GameState,
} from '../core/game.ts';
import { pieceLabel } from '../core/pieces.ts';
import { nextDrawer, openMatch, recordGame, winners, type MatchBook } from '../core/match.ts';
import { mulberry32 } from '../core/rng.ts';
import { viewFor } from '../core/view.ts';
import { ctrlLift, labelBands, LABEL_W, layout, pieceSize, stackSpots, type Board, type TableView } from './board.ts';
import { MOVE_MS, Pieces } from './pieces.ts';
import { rules } from './rules.ts';
import { Sound } from './sound.ts';
import { buildShell, button, div, paintChip, popup, segment, toast, type Shell } from './ui.ts';

/** 真人永远坐 0 号位，其余座位交给电脑 */
const HUMAN = 0;
const LEVEL_CN: Record<Level, string> = { easy: '随手出', greedy: '挑省的', hard: '算赢面' };
/** 电脑想想再出：太即时看着不像人，太长磨叽 */
const AI_MS = 620;
/** 扣棋里一墩出完，全桌扣着停这么久再一起翻——现实里就是大家把牌摁一起掀的那口气 */
const FLIP_HOLD_MS = 2000;
/**
 * 摸签八拍的节奏表，数值只管这一处，要调节奏改这里就行（顺序见 drawShow 的注释）。
 * spread/tuck 是整列补间的落位时间；lift/cover 那张牌在原地放大、缩回，补间一样长。
 */
const BEAT = {
  /** 摊开：那一摞四张彻底铺开，互不遮挡，每张都能单独点 */
  spread: 700,
  /** 选中：点中这张描一道金、原地大一圈，其余七摞降透明 */
  pick: 260,
  /** 抽出：这张在自己那一格里放大到 1.3 倍并翻面 */
  lift: MOVE_MS,
  /** 亮牌：就在摞上给你看清点数 */
  show: 900,
  /** 数点：一家一下 */
  countStep: 360,
  /** 定人：亮出「这 8 摞怎么分归谁定」 */
  decider: 1200,
  /** 送回：缩回原来那一格并扣下 */
  cover: MOVE_MS + 150,
  /** 收拢：整列退回原位 */
  tuck: 420,
} as const;

interface Setup {
  players: number;
  mode: 'ming' | 'kou';
  level: Level;
  seed: number;
}

/** 摊在桌面的这一墩快照。引擎结算完就不给了，动画得自己留着 */
interface OnTable {
  seat: number;
  ids: number[];
  pledge: boolean;
  best: boolean;
}

function keyOf(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(',');
}

/** 换桌顶掉代号，正在等动画的循环拿它散伙 */
class Aborted extends Error {}

/** 每次开桌摇一个新种子：固定种子会把牌序、起抽人、整桌布局一模一样的重演一遍 */
function rollSeed(): number {
  return Date.now() % 1_000_000_000;
}

export class App {
  private shell!: Shell;
  private pieces!: Pieces;
  private state!: GameState;
  private view!: TableView;
  private book!: MatchBook;
  private setup: Setup = { players: 2, mode: 'kou', level: 'greedy', seed: 0 };
  private rng = mulberry32(1);
  private gen = 0;
  private gameNo = 0;
  private drawer = -1;
  /** 此刻人能按的动作，点选判合法性、亮 hint 都靠它 */
  private acts: Action[] = [];
  /** 动画演完之前不给按：抢点会把这一步吞掉，人就得干等 */
  private busy = false;
  /** 每摞的领地矩形，跟着桌面尺寸重算；pointermove 只查这张表，不在事件里量 DOM */
  private spots: { x: number; y: number; w: number; h: number }[] = [];
  /** 这台设备有没有真正的鼠标：没有就没有 hover，摊开/亮牌全改成点一下 */
  private hasHover = window.matchMedia('(hover: hover)').matches;
  private sound = new Sound();
  private ask: ((a: Action | null) => void) | null = null;
  /** 暗棋里这一墩的日志从第几行起还不能给看；-1 = 没有藏着 */
  private maskFrom = -1;
  private noMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private rober: ResizeObserver | null = null;

  constructor(private root: HTMLElement) {
    this.pickTable();
  }

  // ---------- 开桌 ----------

  private pickTable(): void {
    for (const el of this.root.querySelectorAll('.sheet')) el.remove();
    const chosen: Setup = { ...this.setup, seed: rollSeed() };
    popup(
      this.root,
      '摆一桌',
      (body, close) => {
        body.append(
          segment(
            '坐几个人',
            rules.playerCounts.map((n) => ({ text: `${n} 人 · 每人 ${this.state ? this.state.pieces.length / n : 32 / n} 枚`, value: n })),
            chosen.players,
            (v) => (chosen.players = v),
          ),
          segment(
            '玩法',
            rules.modes.map((m) => ({ text: m === 'ming' ? '明棋 · 出牌即亮' : '扣棋 · 一墩打完才翻', value: m })),
            chosen.mode,
            (v) => (chosen.mode = v),
          ),
          segment(
            '电脑水平',
            LEVELS.map((l) => ({ text: `${l === 'greedy' ? '默认 · ' : ''}${LEVEL_CN[l]}`, value: l })),
            chosen.level,
            (v) => (chosen.level = v),
          ),
        );
        const row = div('sheet-row');
        const seedNote = div('note', `种子 ${chosen.seed}`);
        const roll = () => {
          chosen.seed = rollSeed();
          seedNote.textContent = `种子 ${chosen.seed}`;
        };
        row.append(
          seedNote,
          button('重掷', roll, 'btn mini'),
          button('开桌', () => {
            close();
            this.setup = chosen;
            void this.match(chosen);
          }, 'btn primary'),
        );
        body.append(row);
      },
      true,
    );
  }

  private async match(setup: Setup): Promise<void> {
    const gen = ++this.gen;
    this.setup = setup;
    this.rng = mulberry32(setup.seed ^ 0x9e3779b9);
    this.book = openMatch(setup.players);
    this.gameNo = 0;
    this.drawer = -1;
    this.state = createGame({ rules, players: setup.players, mode: setup.mode, seed: setup.seed });
    this.shell = buildShell(this.root, setup.players, () => this.resign(), () => this.toggleLog(), () => this.toggleSound());
    this.paintSound();
    this.pieces = new Pieces(this.shell.board, this.state.pieces);
    this.wire();
    let crashed = false;
    try {
      for (;;) {
        this.newGame();
        if ((await this.playOne()) === 'abort' || gen !== this.gen) return;
        if (!(await this.askAgain()) || gen !== this.gen) return;
      }
    } catch (e) {
      if (e instanceof Aborted || gen !== this.gen) return;
      // 循环一死牌面就废了。静默吞掉的话按钮还画着但点了没反应——把话撂在状态栏，别把玩家丢在那儿
      crashed = true;
      console.error(e);
      this.shell.status.textContent = `出了点问题：${(e as Error).message}｜种子 ${this.state.seed}｜按右上角「换桌」重开`;
    } finally {
      // 收杆回到开桌，别把玩家丢在一幅打完的牌面上；崩了就留着牌面，好截图看
      if (gen === this.gen && !crashed) this.pickTable();
    }
  }

  private newGame(): void {
    this.state = createGame({
      rules,
      players: this.setup.players,
      mode: this.setup.mode,
      seed: this.setup.seed + this.gameNo * 7919,
      ...(this.drawer >= 0 ? { drawer: this.drawer } : {}),
    });
    this.gameNo++;
    this.view = {
      mine: HUMAN,
      piles: Array.from({ length: this.setup.players }, () => [] as number[]),
      sel: new Set(),
      hint: new Set(),
      justWon: new Set(),
      freeze: null,
      deal: false,
      holdDown: new Set(),
      peek: new Set(),
      hover: null,
      pick: null,
      lift: null,
      spread: false,
    };
    this.maskFrom = -1;
    this.shell.meta.textContent = `${this.setup.mode === 'ming' ? '明棋' : '扣棋'} · ${this.setup.players} 人 · 电脑${
      LEVEL_CN[this.setup.level]
    } · 第 ${this.gameNo} 局 · 种子 ${this.state.seed}`;
    this.render(false);
    toast(this.shell.toast, `第 ${this.gameNo} 局｜${this.who(this.state.drawer)} 起抽`, 1800);
  }

  private async playOne(): Promise<'done' | 'abort'> {
    for (;;) {
      const seats = pendingSeats(this.state);
      if (seats.length === 0) return 'done';
      // 扣棋里几家是并列的：先把真人要的那手收走，他才不会看见别人已经出了什么
      if (seats.includes(HUMAN)) {
        const action = await new Promise<Action | null>((res) => {
          this.ask = res;
          this.render(true); // 先挂上 ask 再画：按钮只在「点了真有人接」时出现
        });
        if (action === null) return 'abort';
        await this.act(HUMAN, action);
        continue;
      }
      const seat = seats[0]!;
      this.render(true);
      await this.nap(AI_MS);
      // 命令行和网页走同一个 choose：抽签、分牌这类同分选项由它内部随机挑，两边不会各学各的
      await this.act(seat, choose(viewFor(this.state, seat), legalActions(this.state, seat), this.setup.level, this.rng));
    }
  }

  // ---------- 一步棋 ----------

  private async act(seat: number, action: Action): Promise<void> {
    const logBefore = this.state.log.length;
    const wonBefore = [...this.state.won];
    const onTable = this.view.freeze;
    this.busy = true;
    try {
      apply(this.state, seat, action);
      this.view.sel.clear();
      this.view.spread = false;
      this.mask(logBefore);
      // 一墩打完引擎就把 trick 清了，最后这一手得自己补进桌面快照，不然它飞不进牌摞
      const table = this.state.trick ? this.snapshot() : this.closedTable(seat, action, onTable, wonBefore);
      this.view.freeze = table;
      switch (action.kind) {
        case 'draw': {
          // 先按扣着画一帧，再放开让它翻，不然一上来就知道点数了
          this.view.holdDown = new Set([this.state.draft!.drawn]);
          this.render(true);
          await this.drawShow();
          break;
        }
        case 'allocate': {
          // 摸签收尾时那张签被强制扣着，分牌一开始就得放开，不然它进我手也画成背面
          this.view.holdDown = new Set();
          this.view.deal = true;
          this.render(true);
          await this.dealShow();
          break;
        }
        default: {
          const closing = this.state.trick === null && onTable;
          this.sound.cue(action.kind === 'discard' ? 'pledge' : 'play');
          // 扣棋收尾：这一墩的牌先全扣着压两秒，别一落桌就掀
          if (closing && this.state.mode === 'kou') this.view.holdDown = new Set(table!.flatMap((e) => e.ids));
          this.render(true);
          if (closing) await this.settleShow(table!, wonBefore);
        }
      }
    } finally {
      this.busy = false;
      this.render(true);
    }
  }

  private snapshot(): OnTable[] {
    const trick = this.state.trick!;
    // 扣棋是同时暗出，没翻开之前桌上没有「谁最大」，别拿金光提前泄底
    const champ = this.state.mode === 'ming' ? trick.plays[trick.championIdx] : null;
    return [
      ...trick.plays.map((p) => ({ seat: p.player, ids: [...p.pieceIds], pledge: false, best: p === champ })),
      ...trick.discards.map((d) => ({ seat: d.player, ids: [...d.pieceIds], pledge: true, best: false })),
    ];
  }

  /** 收尾那一手的完整桌面＝之前的快照 + 刚出的这张；赢家那家亮起来，抵押的照常跟着收 */
  private closedTable(
    seat: number,
    action: Action,
    before: OnTable[] | null,
    wonBefore: number[],
  ): OnTable[] | null {
    if (!before) return null;
    const ids = 'pieceIds' in action ? [...action.pieceIds] : [];
    const winner = this.state.won.findIndex((w, i) => w !== wonBefore[i]);
    return [...before, { seat, ids, pledge: action.kind === 'discard', best: false }].map((e) => ({
      ...e,
      best: !e.pledge && e.seat === winner,
    }));
  }

  /** 暗棋这一墩没翻开之前，日志里「谁出了什么」那几行不能给看——和命令行同一套口径 */
  private mask(logBefore: number): void {
    if (this.state.mode !== 'kou' || !this.state.trick) this.maskFrom = -1;
    else if (this.maskFrom < 0) this.maskFrom = logBefore;
  }

  /** 摸签这八拍就是桌上那套动作：摊开→选中→抽出→亮牌→数点→定人→送回→收拢 */
  private async drawShow(): Promise<void> {
    const state = this.state;
    const open = state.opening!;
    const piece = state.byId.get(open.pieceId)!;
    // 鼠标已经压在这摞上时它就是摊开的，再等一拍摊开就成了倒带
    const wasSpread = this.view.hover === open.stackIdx;
    this.view.hover = open.stackIdx;
    this.render(true);
    if (!wasSpread) await this.nap(BEAT.spread);
    this.view.pick = open.pieceId;
    this.render(true);
    await this.nap(BEAT.pick);
    this.view.pick = null;
    this.view.lift = open.pieceId;
    this.view.holdDown = new Set();
    this.sound.cue('flip');
    this.render(true);
    await this.nap(BEAT.lift);
    toast(this.shell.toast, `翻出 ${pieceLabel(piece)}｜${piece.point} 点`, 1200);
    await this.nap(BEAT.show);
    for (let i = 1; i <= piece.point; i++) {
      const seat = (open.drawer + i - 1) % state.players;
      this.chip(seat).classList.add('tick');
      this.shell.status.textContent = `${this.who(open.drawer)} 从自己起数到 ${i}：${this.who(seat)}`;
      await this.nap(BEAT.countStep);
      this.chip(seat).classList.remove('tick');
    }
    this.chip(open.seat).classList.add('decider');
    toast(this.shell.toast, `数到 ${this.who(open.seat)}｜这 ${this.state.draft!.stacks.length} 摞怎么分归他定，第一轮也由他先出`, 2000);
    await this.nap(BEAT.decider);
    // 拿完就扣：缩回原来那一格、当场翻回背面，画面上不留标记
    this.view.lift = null;
    this.view.holdDown = new Set([open.pieceId]);
    this.render(true);
    await this.nap(BEAT.cover);
    this.view.hover = null;
    this.render(true);
    await this.nap(BEAT.tuck);
  }

  private async dealShow(): Promise<void> {
    const n = Math.max(0, ...this.state.hands.map((h) => h.length));
    await this.nap(n * 45 + MOVE_MS + 160);
    this.view.deal = false;
    for (const chip of this.shell.chips) chip.classList.remove('decider');
    this.render(false);
  }

  private async settleShow(onTable: OnTable[], wonBefore: number[]): Promise<void> {
    const ids = onTable.flatMap((e) => e.ids);
    const winner = this.state.won.findIndex((w, i) => w !== wonBefore[i]);
    // 扣棋：全员出完先闷两秒，再一起翻开
    if (this.state.mode === 'kou') {
      await this.nap(FLIP_HOLD_MS);
      this.view.holdDown = new Set();
      this.render(true);
    }
    // 刚翻开，多留一会儿让人看清这一墩谁最大
    await this.nap(this.state.mode === 'kou' ? 1000 : 560);
    if (winner >= 0) {
      this.sound.cue('collect');
      this.view.piles[winner]!.push(...ids);
    }
    this.view.freeze = null;
    this.view.peek = new Set();
    this.view.justWon = new Set(ids);
    this.render(true);
    await this.nap(MOVE_MS + 320);
    this.view.justWon = new Set();
    this.render(false);
  }

  private async askAgain(): Promise<boolean> {
    const state = this.state;
    recordGame(this.book, state);
    this.drawer = nextDrawer(state);
    const no = this.gameNo;
    const top = winners(state);
    const title =
      top.length === 1
        ? `第 ${no} 局｜${this.who(top[0]!)} 夺冠`
        : top.length > 1
          ? `第 ${no} 局｜${top.map((s) => this.who(s)).join('、')} 并列`
          : `第 ${no} 局｜谁都没收到牌`;
    this.sound.cue('win');
    return new Promise((res) => {
      popup(
        this.root,
        title,
        (body, close) => {
          const rank = [...state.won.keys()].sort((a, b) => state.won[b]! - state.won[a]!);
          for (const seat of rank) {
            const row = div('rank-row');
            row.append(
              div('who', this.who(seat)),
              div('n', `${state.won[seat]} 枚`),
              div('t', seat === this.drawer ? '下一局起抽' : ''),
            );
            body.append(row);
          }
          const note = div('note');
          note.textContent =
            top.length === 1
              ? `下一局由 ${this.who(this.drawer)} 起抽`
              : `这局并列，下一局仍由 ${this.who(this.drawer)} 起抽`;
          body.append(note);
          const row = div('sheet-row');
          row.append(
            button('再来一局', () => {
              close();
              res(true);
            }, 'btn primary'),
            button('收杆', () => {
              close();
              res(false);
            }),
            button('复制战报', () => void this.copyReport(body, title)),
          );
          body.append(row);
          const total = div('note');
          total.textContent = `累计 ${this.book.games} 局：${this.book.titles
            .map((t, seat) => `${this.who(seat)} 冠 ${t}`)
            .join('　')}｜并列 ${this.book.ties} 局`;
          body.append(total);
        },
        true,
      );
    });
  }

  /** 结算那份复盘原文：座位名跟屏上口径一致（P1 就是你），日志里本来就写的 P1/P2 */
  private reportText(title: string): string {
    const state = this.state;
    const head = `棋墩墩 · ${state.mode === 'ming' ? '明棋' : '扣棋'} · ${state.players} 人（我是 P1）· 种子 ${state.seed}`;
    const total = `累计 ${this.book.games} 局：${this.book.titles
      .map((t, seat) => `${this.who(seat)} 冠 ${t}`)
      .join('　')}｜并列 ${this.book.ties} 局`;
    return `${head}\n${title}\n\n${state.log.join('\n')}\n\n${total}`;
  }

  /** 剪贴板不给用（非 https、或者浏览器直接拒）就把原文摊在卡里，选中照样能抄 */
  private async copyReport(host: HTMLElement, title: string): Promise<void> {
    const text = this.reportText(title);
    try {
      await navigator.clipboard.writeText(text);
      toast(this.shell.toast, '战报已复制', 1200);
      return;
    } catch {
      // 落不到剪贴板上，走下面这段
    }
    const box = document.createElement('textarea');
    box.className = 'report';
    box.readOnly = true;
    box.value = text;
    host.append(box);
    box.select();
    toast(this.shell.toast, '复制不成，已摊开——长按/选中自己抄', 2000);
  }

  private resign(): void {
    const go = () => {
      this.gen++;
      const ask = this.ask;
      this.ask = null;
      ask?.(null);
      this.pickTable();
    };
    if (this.state.phase === 'over') {
      go();
      return;
    }
    popup(this.root, '换桌', (body, close) => {
      const p = div('note');
      p.textContent = '这一局还没打完，换桌就不记账了。';
      const row = div('sheet-row');
      row.append(
        button('确认换桌', () => {
          close();
          go();
        }),
        button('接着打', () => close()),
      );
      body.append(p, row);
    });
  }

  // ---------- 交互 ----------

  private wire(): void {
    this.shell.board.addEventListener('click', (ev) => {
      const piece = (ev.target as HTMLElement).closest<HTMLElement>('.piece');
      // 点空白处＝收回：手牌摊开了就握回扇形，摸签摊开了那摞也合上（动画正在演时不动，别倒带）
      if (!piece) {
        if (this.busy || !this.view) return;
        if (this.view.spread) this.view.spread = false;
        else if (this.state.phase === 'draft' && this.view.hover !== null) this.view.hover = null;
        else return;
        this.render(true);
        return;
      }
      this.tapPiece(Number(piece.dataset.id));
    });
    // 触屏没有 hover，一按就是抽牌，所以只在真有鼠标的设备上挂展开
    if (this.hasHover) {
      // 摊开靠的是「鼠标落进这一摞的领地」，不是某张牌自己的 enter/leave：
      // 摊开后牌缝只有两三个像素，挂在牌上会在缝里反复合上又摊开
      this.shell.board.addEventListener('pointermove', (ev) => this.hoverAt(ev as PointerEvent));
      this.shell.board.addEventListener('pointerleave', () => this.hoverStack(null));
      // 扣棋里我自己那套也扣着，鼠标压上去单独亮给我看
      this.shell.board.addEventListener('pointerover', (ev) => this.peekPlay(ev.target as HTMLElement, true));
      this.shell.board.addEventListener('pointerout', (ev) => this.peekPlay(ev.target as HTMLElement, false));
    }
    this.watchResize();
  }

  private hoverAt(ev: PointerEvent): void {
    if (this.state.phase !== 'draft') return;
    const rect = this.shell.board.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const i = this.spots.findIndex((s) => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h);
    this.hoverStack(i < 0 ? null : i);
  }

  /** 亮不亮走引擎口径，这里只是把「我自己的那一套」临时借给鼠标看一眼 */
  private peekPlay(el: HTMLElement, on: boolean): void {
    const piece = el.closest<HTMLElement>('.piece');
    if (!piece) return;
    const id = Number(piece.dataset.id);
    const play = this.view.freeze?.find((p) => p.seat === this.view.mine && p.ids.includes(id));
    const next = on && play ? play.ids : [];
    const same = next.length === this.view.peek.size && next.every((i) => this.view.peek.has(i));
    if (same) return;
    this.view.peek = new Set(next);
    this.render(true);
  }

  /** 鼠标落进哪一摞的领地就把那摞摊开；不在摸签阶段就不动，别人的牌也不会乱摊 */
  private hoverStack(stackIdx: number | null): void {
    // 动画演到一半时鼠标挪一寸都不改摊开状态：那一摞正演「抽出→送回」，当场合上就成了倒带
    if (this.busy || this.view.hover === stackIdx || (stackIdx !== null && this.state.phase !== 'draft')) return;
    this.view.hover = stackIdx;
    this.render(true);
  }

  /** 摊开的那一摞里每张各是一个点击目标：点哪张，引擎就抽哪张 */
  private tapDraftPiece(id: number): void {
    const draft = this.state.draft;
    const stackIdx = draft ? draft.stacks.findIndex((s) => s.includes(id)) : -1;
    if (stackIdx < 0) return;
    // 触屏没有 hover，第一下算「点这摞」——先把它摊开，摊开之后第二下才是抽那一张。
    // 鼠标党扫过来时这摞已经摊开了，直接走第二下的逻辑，一次点完
    if (this.view.hover !== stackIdx) {
      this.view.hover = stackIdx;
      this.render(true);
      return;
    }
    const action = this.acts.find((a) => a.kind === 'draw' && a.stackIdx === stackIdx);
    // 这里不收摊开：那一摞正演「抽出→送回」，当场合上就成了「合上→再摊开」的倒带
    if (action?.kind === 'draw') this.commit({ ...action, pieceId: id });
    else toast(this.shell.toast, '现在不归你摸签', 900);
  }

  private tapPiece(id: number): void {
    const state = this.state;
    if (this.busy) return;
    if (state.phase === 'draft') {
      this.tapDraftPiece(id);
      return;
    }
    // 桌面上我自己那一套：触屏没 hover，点一下摊开亮给我看，再点一下收回
    if (!this.hasHover) {
      const mine = this.view.freeze?.find((p) => p.seat === HUMAN && p.ids.includes(id));
      if (mine) {
        this.togglePeek(mine);
        return;
      }
    }
    if (this.ask === null || state.phase === 'over') return;
    if (!pendingSeats(state).includes(HUMAN) || !state.hands[HUMAN].includes(id)) return;
    // 手牌叠着的时候先点一下把整排摊开：没摊开之前每张只露一条边，点的位置说不清是哪张
    if (!this.view.spread) {
      this.view.spread = true;
      this.render(true);
      return;
    }
    const sel = this.view.sel;
    if (sel.has(id)) sel.delete(id);
    else {
      const max = Math.max(0, ...this.acts.map((a) => ('pieceIds' in a ? a.pieceIds.length : 0)));
      if (sel.size >= max) {
        toast(this.shell.toast, `这一轮一次最多出 ${max} 张`, 1000);
        return;
      }
      sel.add(id);
    }
    this.render(true);
  }

  /** 我自己那一套扣着的牌：只有摊开这一态是给我的，别家和日志照旧看不见 */
  private togglePeek(play: { ids: number[] }): void {
    const on = this.view.peek.size === 0;
    this.view.peek = new Set(on ? play.ids : []);
    this.render(true);
  }

  private commit(action: Action): void {
    const ask = this.ask;
    this.ask = null;
    ask?.(action);
  }

  private matching(): Action | null {
    const key = keyOf([...this.view.sel]);
    if (!key) return null;
    return this.acts.find((a) => 'pieceIds' in a && keyOf(a.pieceIds) === key) ?? null;
  }

  private whyNot(sel: Set<number>): string {
    const sizes = [...new Set(this.acts.map((a) => ('pieceIds' in a ? a.pieceIds.length : 0)))].filter((n) => n > 0);
    if (!sizes.includes(sel.size)) return `要出 ${sizes.sort((a, b) => a - b).join(' 或 ')} 张`;
    return '这几张凑不成一套';
  }

  private describe(action: Action): string {
    const name = (id: number) => pieceLabel(this.state.byId.get(id)!);
    switch (action.kind) {
      case 'draw':
        return `抽第 ${action.stackIdx + 1} 摞`;
      case 'allocate':
        return {
          layered: '层层轮流分',
          'stacks-left': '整摞轮流拿 · 从左',
          'stacks-right': '整摞轮流拿 · 从右',
        }[action.way];
      case 'noop':
        return '过';
      default:
        return `${action.kind === 'lead' ? '出' : action.kind === 'follow' ? '压' : '弃'} ${action.pieceIds
          .map(name)
          .join('+')}`;
    }
  }

  // ---------- 画面 ----------

  private render(animate: boolean): void {
    const board = this.size();
    const actors = this.pending();
    this.acts = actors.includes(HUMAN) ? legalActions(this.state, HUMAN) : [];
    this.view.hint = new Set(this.acts.flatMap((a) => ('pieceIds' in a ? a.pieceIds : [])));
    this.shell.board.style.setProperty('--cw', `${pieceSize(board)}px`);
    // 名字条的宽、按钮条浮起的高度，常数都住在 board.ts；CSS 只读变量，两边不会各自漂移
    this.shell.board.style.setProperty('--label-w', `${LABEL_W}px`);
    this.shell.board.style.setProperty('--ctrl-lift', `${ctrlLift(board)}px`);
    this.pieces.place(layout(this.state, this.view, board), animate && !this.noMotion);
    // 小手只在该点得动的时候给：动画还在演、按钮还没人接的时候牌面看着能点其实点不动
    this.shell.board.classList.toggle('tappable', this.ask !== null && !this.busy);
    this.paintChips(board);
    this.paintStacks(board);
    this.paintPrompt();
    this.paintLog();
  }

  private size(): Board {
    const el = this.shell.board;
    return { w: el.clientWidth || 1, h: el.clientHeight || 1 };
  }

  private chip(seat: number): HTMLElement {
    return this.shell.chips[seat]!;
  }

  /** 此刻能动手的人。扣棋里首出之后其余几家是并列的，动画正在演时谁都不给点 */
  private pending(): number[] {
    return this.busy ? [] : pendingSeats(this.state);
  }

  private who(seat: number): string {
    return seat === HUMAN ? '你' : seatName(seat);
  }

  private paintChips(board: Board): void {
    const state = this.state;
    const actors = new Set(this.pending());
    const draft = state.draft;
    // 名字条贴在自家那摞旁边：落点和收牌摞的几何同源于 board.ts，CSS 只管长相
    for (const band of labelBands(state.players, board)) {
      const el = this.chip(band.seat);
      el.style.left = `${band.x}px`;
      el.style.top = `${band.y}px`;
    }
    for (let seat = 0; seat < state.players; seat++) {
      const chip = this.chip(seat);
      let tag = '';
      // 本墩第几手：顺时针从先出那家数过去，扣棋并发时这就是「谁在前、谁在后」
      let ord: number | null = null;
      if (draft) {
        tag = seat === draft.drawer ? '起抽' : draft.stage === 'allocate' && seat === draft.decider ? '处置人' : '';
      } else if (state.trick) {
        ord = ((seat - state.trick.leader + state.players) % state.players) + 1;
        const played =
          state.trick.plays.some((p) => p.player === seat) || state.trick.discards.some((d) => d.player === seat);
        tag = played ? '已出' : state.hands[seat]!.length === 0 ? '没牌' : seat === HUMAN ? '你出' : '在想';
      } else if (state.phase !== 'over') {
        tag = state.leader === seat ? '先出' : '';
      }
      // 「电脑」不写进条里：顶栏 meta 已经报过一次难度，而这条 pill 的宽度是几何量（LABEL_W），得省着用
      const who = seat === HUMAN ? '你' : seatName(seat);
      paintChip(chip, who, tag, state.hands[seat]!.length, state.won[seat]!, ord);
      chip.classList.toggle('now', actors.has(seat));
    }
  }

  private paintStacks(board: Board): void {
    const spots = stackSpots(board);
    this.spots = spots;
    // 「选中/抽出」这两拍点中的那张会放大到摞外，标签正好压在它下面——演到这两拍就不画标签
    const focus = this.view.pick !== null || this.view.lift !== null;
    this.shell.pileZones.forEach((el, i) => {
      const s = spots[i]!;
      el.style.transform = `translate(${s.x}px, ${s.y}px)`;
      el.style.width = `${s.w}px`;
      el.style.height = `${s.h}px`;
      el.hidden = this.state.phase !== 'draft';
      el.classList.toggle('hot', this.view.hover === i);
      el.classList.toggle('quiet', focus);
    });
  }

  private paintPrompt(): void {
    const state = this.state;
    const shell = this.shell;
    shell.ctrl.innerHTML = '';
    if (this.busy) return; // 动画正在演，这一帧不给按钮、也不盖掉动画写的提示
    // 循环没在等人点的时候，按钮点了也没人接（循环抛异常死掉就是这样）——干脆别画
    const clickable = this.ask !== null;
    const draft = state.draft;
    if (draft) {
      if (draft.stage === 'draw') {
        shell.status.textContent =
          draft.drawer === HUMAN
            ? this.hasHover
              ? '轮到你摸签：鼠标压上来那一摞就摊开，点哪张抽哪张'
              : '轮到你摸签：先点一摞把它摊开，再点你要抽的那张'
            : `${this.who(draft.drawer)} 正在摸签…`;
      } else {
        const piece = state.byId.get(draft.drawn)!;
        shell.status.innerHTML = `${this.who(draft.drawer)} 翻出 <b>${pieceLabel(piece)}</b>，${piece.point} 点从自己数到 <b>${this.who(
          draft.decider,
        )}</b>${draft.decider === HUMAN ? '：这 8 摞怎么分你定' : `：${this.who(draft.decider)} 定怎么分`}`;
        if (draft.decider === HUMAN && clickable) for (const a of this.acts) this.addBtn(this.describe(a), () => this.commit(a));
      }
      return;
    }
    if (state.phase === 'over') {
      shell.status.textContent = '这一局打完了，看结算。';
      return;
    }
    const actors = pendingSeats(state);
    if (!actors.includes(HUMAN)) {
      const who = actors.map((s) => this.who(s)).join('、');
      shell.status.textContent = state.mode === 'kou' && state.trick ? `${who} 同时暗出…` : `${who} 出牌中…`;
      return;
    }
    const others = actors.filter((s) => s !== HUMAN);
    const atOnce = state.mode === 'kou' && state.trick && others.length > 0;
    // 第一下是「把整排摊开」，不是「出这张」——鼠标和触屏都一样（抬起已删，路过不给反馈）
    const tapFirst = this.view.spread ? '' : '先点一下把手牌摊开，再点那几张｜';
    shell.status.textContent =
      tapFirst +
      (atOnce ? `你和${others.map((s) => this.who(s)).join('、')}同时暗出，谁也看不见谁｜` : '') +
      (!state.trick
        ? `轮到你先出：${state.mode === 'ming' ? '明棋出牌即亮' : '扣着出，一墩打完才翻'}`
        : state.mode === 'ming'
          ? '轮到你跟牌：张数要对上，有更大的必须出'
          : '轮到你跟牌：张数对上就必须出，出大出小随意');
    if (!clickable) return;
    const match = this.matching();
    if (match) this.addBtn(this.describe(match), () => this.commit(match), 'btn primary');
    else if (this.view.sel.size > 0) this.addBtn(this.whyNot(this.view.sel), null);
    if (this.view.sel.size > 0) {
      this.addBtn('清空', () => {
        this.view.sel.clear();
        this.render(true);
      });
    }
  }

  private addBtn(text: string, run: (() => void) | null, cls = 'btn'): void {
    const el = button(text, run ?? undefined, run ? cls : `${cls} dim`);
    if (!run) el.disabled = true;
    this.shell.ctrl.append(el);
  }

  private paintLog(): void {
    if (this.shell.drawer.hidden) return;
    this.shell.lines.textContent = (this.maskFrom < 0 ? this.state.log : this.state.log.slice(0, this.maskFrom)).join('\n');
  }

  private toggleLog(): void {
    this.shell.drawer.hidden = !this.shell.drawer.hidden;
    this.paintLog();
  }

  private toggleSound(): void {
    this.sound.toggle();
    this.paintSound();
  }

  private paintSound(): void {
    this.shell.sound.textContent = `声音 ${this.sound.enabled ? '开' : '关'}`;
    this.shell.sound.classList.toggle('mute', !this.sound.enabled);
  }

  private watchResize(): void {
    this.rober?.disconnect();
    this.rober = new ResizeObserver(() => this.render(false));
    this.rober.observe(this.shell.board);
  }

  private async nap(ms: number): Promise<void> {
    const gen = this.gen;
    await new Promise<void>((r) => setTimeout(r, this.noMotion ? Math.min(ms, 60) : ms));
    if (gen !== this.gen) throw new Aborted();
  }
}
