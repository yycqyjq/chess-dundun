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
  type TableStatus,
  type ToClient,
  type WireState,
} from './wire.ts';

/** 掉线多久转代打。想牌的人不催，催的是回不来的那位 */
export const TAKEOVER_MS = 30_000;

/** 候场期一把空椅子等人等多久就归零还桌。两分钟够去倒杯水，再长就是那台设备不回来了 */
export const IDLE_MS = 120_000;

/** 设备代号留多长：够认人、又不至于把座位行挤换行 */
export const NICK_MAX = 12;

export interface TableSetup {
  rules: Rules;
  players: number;
  mode: 'ming' | 'kou';
  /** 代打用哪档电脑 */
  level: Level;
  seed: number;
  /** 开下一局由这一位按，默认房主自己坐 P1 */
  hostSeat?: number;
  /** 这桌「家」房主位：那把椅子的主人一回来，开局那颗就交回他。缺省跟 hostSeat */
  homeSeat?: number;
}

interface Slot {
  seat: number;
  name: string;
  /** 空串 = 还没人坐过这张椅子 */
  token: string;
  /** 坐上来那台设备自报的短代号，空串 = 没报过（老客户端、或者桌自己补的电脑位） */
  nick: string;
  online: boolean;
  /** 掉线时刻，在线就是 0 */
  gone: number;
  ai: boolean;
  /** 这一局归真人：开局那一刻定。掉线被代打时它仍是真人位，人回来下一手就交还 */
  human: boolean;
  /** 人坐着但这一局不由他打——开局以后才进来的人，下一局开局才接手 */
  queued: boolean;
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
  /** 候场厅里等着开局；房主按下开始才翻成 playing，一局打完自己回到 waiting */
  status: TableStatus = 'waiting';
  private slots: Slot[];
  private seq = 0;
  /** 暗棋这一墩没翻开之前，日志只发到这儿为止——和网页的 maskFrom 同一口径 */
  private maskFrom = -1;
  /** 刚落下的那一手，随下一份快照发出去就清空：客户端照它演一拍 */
  private last: LastMove | null = null;
  private rng: () => number;
  /** 候场厅里房主能改，所以不是 readonly */
  private setup: TableSetup;
  private readonly send: Deliver;
  private readonly log: LogLine;
  private readonly now: Clock;

  constructor(setup: TableSetup, send: Deliver, log: LogLine = () => {}, now: Clock = () => Date.now()) {
    this.setup = { ...setup, homeSeat: setup.homeSeat ?? setup.hostSeat ?? 0 };
    this.send = send;
    this.log = log;
    this.now = now;
    this.state = createGame({ ...setup, seed: setup.seed });
    this.book = openMatch(setup.players);
    this.rng = mulberry32(setup.seed ^ 0x5eed);
    this.slots = this.freshSlots(setup.players);
  }

  /** 一把新椅子：没坐过人，也不归任何人打。候场期谁都不计时，所以 gone 留 0 */
  private freshSlots(players: number): Slot[] {
    return Array.from({ length: players }, (_unused, seat) => ({
      seat,
      name: seatName(seat),
      token: '',
      nick: '',
      online: false,
      gone: 0,
      ai: false,
      human: false,
      queued: false,
    }));
  }

  /**
   * 入座：带令牌的认回原来那把椅子，空椅子随便坐。
   * 开局以后才进来的人不抢这一局的牌——椅子给他留着，下一局开局才归他打。
   * `from` 是这条连接原来那把：换椅子得是换，不是多占一把。
   */
  join(
    seat: number,
    token: string,
    nick?: string,
    from?: number,
  ): { ok: boolean; why?: string; msg?: ToClient } {
    const slot = this.slots[seat];
    if (!slot) return { ok: false, why: `没第 ${seat + 1} 号位，这桌只 ${this.setup.players} 个人` };
    if (slot.token && slot.token !== token) return { ok: false, why: '这把椅子坐了人' };
    // 目标这把坐得下了才动原来那把：坐不下去就别把人原有的椅子一起赔进去
    if (from !== undefined && from !== seat) this.vacate(from);
    const fresh = !slot.token;
    if (fresh) slot.token = `s${seat}-${this.rng().toString(36).slice(2, 10)}`;
    // 代号只认递上来的那句：留空就别把人家原来那个抹掉
    const said = (nick ?? '').trim().slice(0, NICK_MAX);
    if (said) slot.nick = said;
    slot.online = true;
    slot.gone = 0;
    // 这一局开局时定下的真人位，人回来就交还；开打后才进来的人只能等下一局
    // 候场期还没有「这一局」，谁都不算排队也不算电脑位——那份牌权要等房主按下开始才定
    slot.queued = this.status === 'playing' && !slot.human;
    slot.ai = this.status === 'playing' && slot.queued;
    const moved = this.settleHost(seat);
    const msg: ToClient = {
      t: 'welcome',
      seat,
      token: slot.token,
      status: this.status,
    };
    this.push();
    this.log(
      `${slot.name} ${fresh ? '坐下' : '回到'}了自己的位子${slot.queued ? '（这一局先由电脑打，下一局归他）' : ''}`,
    );
    if (moved === 'back') this.log(`${slot.name} 回来了，房主位交回 ${seatName(this.setup.hostSeat ?? 0)}`);
    else if (moved === 'take') this.log(`${slot.name} 接过了房主位：改配置和按开始都在他手上`);
    return { ok: true, msg };
  }

  /**
   * 房主位跟着活人走，但「家」钉在一把椅子上：
   * 家房主位上坐着活人，开局那颗就归他——原房主凭令牌回来这一刻自动收回。
   * 那把椅子空着、或者主人没连着，才交给刚坐下的活人代持；现任还连着就不抢。
   * 只有真人递得上 join，电脑补的位永远走不到这儿，所以房主位落不到 AI 头上。
   * 开打中一律不动：那一局正打着，房主位得钉在他那把椅子上。
   */
  private settleHost(seat: number): 'take' | 'back' | null {
    if (this.status !== 'waiting') return null;
    const home = this.setup.homeSeat ?? 0;
    const host = this.setup.hostSeat ?? 0;
    const owner = this.slots[home];
    if (home !== host && owner?.token && owner.online) {
      this.setup.hostSeat = home;
      return 'back';
    }
    if (host === seat) return null;
    const keeper = this.slots[host];
    if (keeper?.token && keeper.online) return null;
    this.setup.hostSeat = seat;
    return 'take';
  }

  /**
   * 换椅子时把原来那把还回去：一个标签页连着坐四把，屏幕上就四行挂同一个代号。
   * 候场期那把彻底空出来（谁都能挑）；开打中只算掉线，令牌还留着，他坐得回去。
   */
  vacate(seat: number): void {
    const slot = this.slots[seat];
    if (!slot || !slot.token) return;
    if (this.status === 'playing') this.leave(seat);
    else {
      Object.assign(slot, this.freshSlots(seat + 1)[seat]!);
      this.push();
    }
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
    if (this.status === 'waiting') return { ok: false, why: '这桌还在候场，等房主按开始' };
    if (slot.queued) return { ok: false, why: '你来得晚了，这一局先由电脑打，下一局归你' };
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

  /**
   * 房主在候场厅按下的那颗开始。头一局和下一局走这一扇门：
   * 打完了就先记账再重洗一副，还没开过局就把已经洗好的这份摊开。
   * 按下这一刻定下「这一局谁归真人打」——有令牌的空椅子留给主人（他一连上就接手），
   * 一把椅子都没人坐过的，直接由电脑补位，别再让全桌干等一个不来的人。
   */
  start(bySeat: number): { ok: boolean; why?: string } {
    if (bySeat !== (this.setup.hostSeat ?? 0)) return { ok: false, why: '只有房主能开局' };
    if (this.status === 'playing') return { ok: false, why: '这一局正在打' };
    if (this.state.phase === 'over') this.newGame();
    this.status = 'playing';
    let bots = 0;
    for (const slot of this.slots) {
      slot.human = !!slot.token;
      slot.queued = false;
      slot.ai = !slot.online;
      slot.gone = slot.online ? 0 : this.now();
      if (slot.ai) bots++;
    }
    this.log(
      `${seatName(bySeat)} 按了开始，第 ${this.gameNo} 局开打${bots ? `（${bots} 个位子由电脑补）` : ''}`,
    );
    this.push();
    return { ok: true };
  }

  /** 候场厅里改这桌的配置。只有房主、只有还没开局——开打了要改就等下一局 */
  changeSetup(
    bySeat: number,
    patch: { players?: number; mode?: 'ming' | 'kou'; level?: Level },
  ): { ok: boolean; why?: string } {
    if (bySeat !== (this.setup.hostSeat ?? 0)) return { ok: false, why: '只有房主能改这桌的配置' };
    if (this.status === 'playing') return { ok: false, why: '这一局已经开打了，要改先去候场厅' };
    const players = patch.players ?? this.setup.players;
    if (!this.setup.rules.playerCounts.includes(players))
      return { ok: false, why: `这桌只能 ${this.setup.rules.playerCounts.join(' 或 ')} 人` };
    const mode = patch.mode ?? this.setup.mode;
    const level = patch.level ?? this.setup.level;
    const same = players === this.setup.players && mode === this.setup.mode && level === this.setup.level;
    if (same) return { ok: true };
    if (players < this.setup.players) {
      // 椅子不能凭空消失：坐在新人数之外那位得先让座，不然他的令牌和连接就悬在半空
      const over = this.slots.slice(players).filter((s) => s.token);
      if (over.length) return { ok: false, why: `${over.map((s) => s.name).join('、')} 还坐着，先让他让座再减人` };
    }
    const prev = this.setup;
    this.setup = { ...prev, players, mode, level };
    const reshuffled = players !== prev.players || mode !== prev.mode;
    const sameSeats = players === prev.players;
    this.log(`配置换成了 ${players} 人 ${mode === 'kou' ? '扣棋' : '明棋'}，等房主开局`);
    if (reshuffled) {
      // 换牌面前先把打完那一局结了：牌面一换就再没人记得它打过。
      // 只改代打档位走不到这儿，那一局的账照旧留给 start 去结（结两回就多算一局）
      const drawer = this.settleOver();
      // 局号得跟着账走：刚结清一局、座位还是那几把，那这副新牌就是「下一局」，别还印着老局号
      if (sameSeats) this.gameNo += drawer === null ? 0 : 1;
      this.state = createGame({
        ...this.setup,
        seed: (this.rng() * 0x100000000) | 0,
        // 起抽人只在座位还是那几把时才接得上：换了人数，上一局的赢家指的已经不是那把椅子
        drawer: sameSeats ? (drawer ?? undefined) : undefined,
      });
      this.maskFrom = -1;
      this.last = null;
    }
    if (!sameSeats) {
      // 人数一变，跨局那本账就得重开；坐过的椅子原样往前挪，谁都不用重新坐一遍
      const old = this.slots;
      this.slots = this.freshSlots(players).map((slot, i) => {
        const was = old[i];
        // 掉线计时也得跟着椅子挪：只搬 online 不搬 gone，那把「人走了、凭令牌还得回来」的椅子
        // 就再没人收（sweepIdle 见 gone 为 0 直接跳过），这桌少一把能坐的椅子
        return was
          ? { ...slot, name: was.name, token: was.token, nick: was.nick, online: was.online, gone: was.gone }
          : slot;
      });
      this.book = openMatch(players);
      this.gameNo = 1;
      // 减人之后房主位可能落在已经不存在的椅子上：连「家」带现任一起收回第一把，谁坐下谁接手
      if ((this.setup.hostSeat ?? 0) >= players) this.setup.hostSeat = 0;
      if ((this.setup.homeSeat ?? 0) >= players) this.setup.homeSeat = 0;
    }
    this.push();
    return { ok: true };
  }

  /**
   * 让座：把自己那把椅子还回候场厅，令牌也一并抹掉——不改到一半人数卡在那儿。
   * 只有候场期让得成，开打了想走人走牌桌右上角的「离桌」。
   */
  stand(bySeat: number): { ok: boolean; why?: string } {
    const slot = this.slots[bySeat];
    if (!slot || !slot.token) return { ok: false, why: '你没坐在这桌的椅子上' };
    if (bySeat === (this.setup.hostSeat ?? 0)) return { ok: false, why: '房主不能让座，这桌得有人开局' };
    if (this.status === 'playing') return { ok: false, why: '这一局正在打，先去牌桌按离桌' };
    Object.assign(slot, this.freshSlots(bySeat + 1)[bySeat]!);
    this.log(`${slot.name} 让了座`);
    this.push();
    return { ok: true };
  }

  /**
   * 打完那一局的收尾：记账 + 定下下一局谁起抽（回 null 表示这会儿没有要结的账）。
   * 只有这一处会记那一局的账，所以谁准备把 `phase==='over'` 那份牌面换掉，谁就得先走这道门——
   * 原来只有 `start()` 走，于是「打完 → 在候场厅改了玩法 → 按开始」中间那一局就从总账里凭空没了。
   */
  private settleOver(): number | null {
    if (this.state.phase !== 'over') return null;
    recordGame(this.book, this.state);
    return nextDrawer(this.state);
  }

  /** 记这一局的账、摊开下一副。起抽人照上一局的赢家往下传 */
  private newGame(): void {
    const drawer = this.settleOver();
    this.gameNo++;
    this.state = createGame({ ...this.setup, seed: (this.rng() * 0x100000000) | 0, drawer: drawer ?? undefined });
    this.maskFrom = -1;
  }

  /** 一秒一次的表。回 true 表示这一秒真改了点什么，宿主就该落一次盘 */
  tick(): boolean {
    if (this.status !== 'playing') return this.sweepIdle();
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
      if (!this.slots[seat]?.ai) continue;
      const before = this.state.log.length;
      this.auto(seat);
      // 代打真落了一手（哪怕顺带把这一局打完、退回候场）：这一秒就不算白走
      if (this.state.log.length > before) changed = true;
    }
    return changed;
  }

  /**
   * 候场期那把「掉线了，凭令牌坐得回来」的椅子不能永远挂着：
   * 换过 Wi-Fi、清了缓存、或者那台设备压根不再回来，屏幕上就少一把能坐的椅子，
   * 房主那颗开始也就永远点不出来。满 IDLE_MS 就整把洗回没人坐过的样子。
   * 开打中一律不收——那一局还等着他回来接着打。
   */
  private sweepIdle(): boolean {
    const t = this.now();
    let swept = 0;
    for (const slot of this.slots) {
      if (!slot.token || slot.online || !slot.gone || t - slot.gone < IDLE_MS) continue;
      this.log(`${slot.name} 两分钟没回来，那把椅子已经还给这桌——要坐重新挑一把就行`);
      Object.assign(slot, this.freshSlots(slot.seat + 1)[slot.seat]!);
      swept++;
    }
    if (!swept) return false;
    this.restHost();
    this.push();
    return true;
  }

  /** 收掉的正好是房主位那把时：交给还坐在这桌的活人；一个活人都不剩就留在原地当「空房主位」 */
  private restHost(): void {
    const keeper = this.slots[this.setup.hostSeat ?? 0];
    if (keeper?.token && keeper.online) return;
    const next = this.slots.find((s) => s.token && s.online);
    if (!next) return;
    const moved = this.settleHost(next.seat);
    if (moved === 'back') this.log(`${next.name} 那把空回来了，房主位交回 ${seatName(this.setup.hostSeat ?? 0)}`);
    else if (moved === 'take') this.log(`${next.name} 接过了房主位：改配置和按开始都在他手上`);
  }

  /** 入座之前客户端能看见的那点事，一张牌面都不给 */
  lobby(): Lobby {
    return {
      players: this.setup.players,
      hostSeat: this.setup.hostSeat ?? 0,
      gameNo: this.gameNo,
      mode: this.setup.mode,
      level: this.setup.level,
      seats: this.seatInfo(),
      status: this.status,
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
    // 打完自动退回候场厅：下一局开不开、什么时候开，都归房主按
    if (this.state.phase === 'over') {
      this.status = 'waiting';
      // 那一局里掉线的人，椅子从局末这一刻再起算两分钟，别一按完最后一张就被收走
      for (const slot of this.slots) if (slot.token && !slot.online) slot.gone = this.now();
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
        status: this.status,
        view: snapshotFor(this.state, slot.seat, this.maskFrom < 0 ? this.state.log.length : this.maskFrom),
        // 候场期一张牌都没出、排队那位这一局也不由他打：这两种人一律递空着法，别给他们「该我动了」的错觉
        acts: this.status === 'playing' && !slot.queued ? this.legalFor(slot.seat) : [],
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
      human: s.human,
      queued: s.queued,
      nick: s.nick,
    }));
  }

  /** 存档：连牌桌一起存，重启能接着打。牌面全公开，这份只许躺在房主的硬盘上 */
  save(): string {
    return JSON.stringify({
      setup: this.setup,
      gameNo: this.gameNo,
      status: this.status,
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
      status?: TableStatus;
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
    // 候场期打到的那一半也得接得回来；旧存档没这个字段就照「还没开局」算
    table.status = raw.status ?? 'waiting';
    // 候场期那半张桌没有「这一局」要接：旧令牌留着只会把椅子占成「这把有主」，
    // 谁坐下都进不来、房主那颗开始也永远点不出来——所以椅子一律洗空。
    table.slots =
      table.status === 'waiting'
        ? table.freshSlots(raw.setup.players)
        : // 开打中的那局得接得上：令牌照用，各人回来还坐自己那把椅子，掉线计时从重启这会儿重新算
          raw.slots.map((s) => ({ ...s, online: false, gone: table.now(), ai: false }));
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
