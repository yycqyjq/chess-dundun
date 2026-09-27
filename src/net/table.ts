import { choose, type Level } from '../ai/agent.ts';
import {
  apply,
  createGame,
  legalActions,
  pendingSeats,
  seatName,
  type Action,
  type GameState,
  type Rules,
} from '../core/game.ts';
import { nextDrawer, openMatch, recordGame, type MatchBook } from '../core/match.ts';
import { mulberry32 } from '../core/rng.ts';
import { viewFor } from '../core/view.ts';
import {
  fullWire,
  hydrate,
  snapshotFor,
  type LastMove,
  type Lobby,
  type SeatInfo,
  type ToClient,
  type WireState,
} from './wire.ts';

/** 掉线多久转代打。想牌的人不催，催的是回不来的那位 */
export const TAKEOVER_MS = 30_000;

export interface TableSetup {
  rules: Rules;
  players: number;
  mode: 'ming' | 'kou';
  /** 代打用哪档电脑 */
  level: Level;
  seed: number;
  /** 开下一局由这一位按，默认房主自己坐 P1 */
  hostSeat?: number;
}

interface Slot {
  seat: number;
  name: string;
  /** 空串 = 还没人坐过这张椅子 */
  token: string;
  online: boolean;
  /** 掉线时刻，在线就是 0 */
  gone: number;
  ai: boolean;
}

export type Deliver = (seat: number, msg: ToClient) => void;
export type LogLine = (line: string) => void;
export type Clock = () => number;

/**
 * 一张桌：权威状态只在这儿，客户端只递得上动作。
 * 发东西、看时间都从外面注进来，测试就能拿假钟假连接跑整局。
 */
export class Table {
  state: GameState;
  book: MatchBook;
  gameNo = 1;
  private slots: Slot[];
  private seq = 0;
  /** 暗棋这一墩没翻开之前，日志只发到这儿为止——和网页的 maskFrom 同一口径 */
  private maskFrom = -1;
  /** 刚落下的那一手，随下一份快照发出去就清空：客户端照它演一拍 */
  private last: LastMove | null = null;
  private rng: () => number;
  private readonly setup: TableSetup;
  private readonly send: Deliver;
  private readonly log: LogLine;
  private readonly now: Clock;

  constructor(setup: TableSetup, send: Deliver, log: LogLine = () => {}, now: Clock = () => Date.now()) {
    this.setup = setup;
    this.send = send;
    this.log = log;
    this.now = now;
    this.state = createGame({ ...setup, seed: setup.seed });
    this.book = openMatch(setup.players);
    this.rng = mulberry32(setup.seed ^ 0x5eed);
    this.slots = Array.from({ length: setup.players }, (_unused, seat) => ({
      seat,
      name: seatName(seat),
      token: '',
      online: false,
      // 没坐人的空椅子也从这一刻开始计时，等满 30 秒一样交给电脑，不然大伙儿干等一个不来的人
      gone: this.now(),
      ai: false,
    }));
  }

  /**
   * 入座：带令牌的认回原来那把椅子，空椅子随便坐。
   * 坐定就锁桌——中途不加人、不换座，只有掉线重连。
   */
  join(seat: number, token: string): { ok: boolean; why?: string; msg?: ToClient } {
    const slot = this.slots[seat];
    if (!slot) return { ok: false, why: `没第 ${seat + 1} 号位，这桌只 ${this.setup.players} 个人` };
    if (slot.token && slot.token !== token) return { ok: false, why: '这把椅子坐了人' };
    const fresh = !slot.token;
    if (fresh) slot.token = `s${seat}-${this.rng().toString(36).slice(2, 10)}`;
    slot.online = true;
    slot.gone = 0;
    slot.ai = false;
    const msg: ToClient = { t: 'welcome', seat, token: slot.token, host: seatName(seat) };
    this.push();
    this.log(`${slot.name} ${fresh ? '坐下' : '回到'}了自己的位子`);
    return { ok: true, msg };
  }

  /** 连接断了。椅子还留着，令牌还有效，回来还是这个位 */
  leave(seat: number): void {
    const slot = this.slots[seat];
    if (!slot || !slot.online) return;
    slot.online = false;
    slot.gone = this.now();
    this.push();
  }

  /** 客户端递来的动作。合法就落，非法一个字都不动状态 */
  act(seat: number, action: Action): { ok: boolean; why?: string } {
    const slot = this.slots[seat];
    if (!slot) return { ok: false, why: '没这个座位' };
    if (!pendingSeats(this.state).includes(seat)) return { ok: false, why: '这会儿不该你出' };
    if (!this.legalFor(seat).some((a) => sameAction(a, action))) return { ok: false, why: '这手不合法' };
    // 触屏摸签是「点那摞→点开那张」，客户端会带上 pieceId；引擎照它取牌，那就得先验它真在那摞里
    if (
      action.kind === 'draw' &&
      action.pieceId !== undefined &&
      !this.state.draft?.stacks[action.stackIdx]?.includes(action.pieceId)
    )
      return { ok: false, why: '那张不在这一摞里' };
    this.step(seat, action);
    return { ok: true };
  }

  /** 打完这局、开下一局。只有房主那位座位能按，别的座位按了不认 */
  nextGame(bySeat: number): { ok: boolean; why?: string } {
    if (bySeat !== (this.setup.hostSeat ?? 0)) return { ok: false, why: '只有房主能开下一局' };
    if (this.state.phase !== 'over') return { ok: false, why: '这局还没打完' };
    recordGame(this.book, this.state);
    const drawer = nextDrawer(this.state);
    this.gameNo++;
    this.state = createGame({ ...this.setup, seed: (this.rng() * 0x100000000) | 0, drawer });
    this.maskFrom = -1;
    // 没连上的那位重新计时：上一局判了代打，这一局照样先等 30 秒
    for (const slot of this.slots) if (!slot.online) slot.gone = this.now();
    this.push();
    return { ok: true };
  }

  /** 一秒一次的表：掉线够久的座位交给电脑打 */
  tick(): void {
    const t = this.now();
    let changed = false;
    for (const slot of this.slots) {
      if (slot.online || slot.ai) continue;
      if (t - slot.gone >= TAKEOVER_MS) {
        slot.ai = true;
        changed = true;
        this.log(`${slot.name} 掉线太久，这一局先由电脑替他打`);
      }
    }
    if (changed) this.push();
    for (const seat of pendingSeats(this.state)) {
      // 只有已经判了代打的座位才由桌出手；在线但在想牌的人，桌一律不催
      if (this.slots[seat]?.ai) this.auto(seat);
    }
  }

  /** 入座之前客户端能看见的那点事，一张牌面都不给 */
  lobby(): Lobby {
    return {
      players: this.setup.players,
      hostSeat: this.setup.hostSeat ?? 0,
      gameNo: this.gameNo,
      mode: this.state.mode,
      level: this.setup.level,
      seats: this.seatInfo(),
    };
  }

  /** 这一位现在能使的动作，客户端拿来画按钮 */
  legalFor(seat: number): Action[] {
    return legalActions(this.state, seat);
  }

  /** 落一手并广播。日志的截断口径在这儿跟 app.ts 对齐 */
  private step(seat: number, action: Action): void {
    const logBefore = this.state.log.length;
    const trickWasNull = this.state.trick === null;
    apply(this.state, seat, action);
    if (this.state.mode === 'kou') {
      if (trickWasNull && this.state.trick) this.maskFrom = logBefore;
      else if (!this.state.trick) this.maskFrom = -1;
    }
    this.last = { seat, action };
    this.push();
  }

  /** 电脑替掉线的座位出一手：出牌用三档里的 hard 那套算法，摸签收拍只会随机和默认 */
  private auto(seat: number): void {
    const acts = this.legalFor(seat);
    if (acts.length === 0) return;
    let action: Action | null = null;
    if (this.state.phase === 'draft') {
      const draws = acts.filter((a) => a.kind === 'draw');
      if (draws.length) action = draws[Math.floor(this.rng() * draws.length)]!;
      else
        action =
          acts.find((a) => a.kind === 'allocate' && a.way === 'layered') ??
          acts.find((a) => a.kind === 'allocate') ??
          null;
    } else if (this.state.phase !== 'over') {
      action = choose(viewFor(this.state, seat), acts, this.setup.level, this.rng);
    }
    if (action) this.step(seat, action);
  }

  /** 给每个连着的座位发一份只属于它的快照 */
  private push(): void {
    this.seq++;
    const last = this.last;
    this.last = null; // 刚那一手只跟着这一份快照演，别家下一份拿到的是 null
    for (const slot of this.slots) {
      if (!slot.online) continue;
      this.send(slot.seat, {
        t: 'state',
        seq: this.seq,
        gameNo: this.gameNo,
        view: snapshotFor(this.state, slot.seat, this.maskFrom < 0 ? this.state.log.length : this.maskFrom),
        acts: this.legalFor(slot.seat),
        seats: this.seatInfo(),
        maskFrom: this.maskFrom,
        last,
      });
    }
  }

  seatInfo(): SeatInfo[] {
    return this.slots.map((s) => ({
      seat: s.seat,
      name: s.name,
      online: s.online,
      taken: !!s.token,
      ai: s.ai,
    }));
  }

  /** 存档：连牌桌一起存，重启能接着打。牌面全公开，这份只许躺在房主的硬盘上 */
  save(): string {
    return JSON.stringify({
      setup: this.setup,
      gameNo: this.gameNo,
      book: this.book,
      slots: this.slots,
      maskFrom: this.maskFrom,
      wire: fullWire(this.state),
    });
  }

  static load(json: string, send: Deliver, log?: LogLine, now?: Clock): Table {
    const raw = JSON.parse(json) as {
      setup: TableSetup;
      gameNo: number;
      book: MatchBook;
      slots: Slot[];
      maskFrom: number;
      wire: WireState;
    };
    const table = new Table(raw.setup, send, log, now);
    table.state = recreate(raw.wire);
    table.book = raw.book;
    table.gameNo = raw.gameNo;
    table.maskFrom = raw.maskFrom;
    // 重启那一刻谁都没连着；令牌照用，各人回来还坐自己那把椅子，掉线计时从重启这会儿重新算
    table.slots = raw.slots.map((s) => ({ ...s, online: false, gone: table.now(), ai: false }));
    return table;
  }
}

function sameAction(a: Action, b: Action): boolean {
  return actionKey(a) === actionKey(b);
}

/**
 * 一手的身份：抽签认到摞、分牌认到方式、出牌认到是哪几张。
 * 只比 kind 太松——`stackIdx: 99` 也会被判成「和合法的那手一样」。
 */
function actionKey(x: Action): string {
  switch (x.kind) {
    case 'draw':
      return `draw:${x.stackIdx}`;
    case 'allocate':
      return `allocate:${x.way}`;
    case 'noop':
      return 'noop';
    default:
      // 同一套牌换个先后不算两手，比之前把张数排一下
      return `${x.kind}:${[...x.pieceIds].sort((m, n) => m - n).join(',')}`;
  }
}

/** 存档里那份全公开快照还原回 GameState；rng 用桌自己那一把，状态里不留函数 */
function recreate(wire: WireState): GameState {
  return hydrate(wire);
}
