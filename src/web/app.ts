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
import { pieceLabel, type Piece } from '../core/pieces.ts';
import { nextDrawer, openMatch, recordGame, winners, type MatchBook } from '../core/match.ts';
import { mulberry32 } from '../core/rng.ts';
import { viewFor } from '../core/view.ts';
import { deckFor, hydrate, type SeatInfo, type Seats, type TableStatus, type ToClient } from '../net/wire.ts';
import { ctrlLift, handCramped, labelBands, LABEL_W, layout, pieceSize, stackSpots, type Board, type TableView } from './board.ts';
import { homePanel, initialScreen, isLoopback } from './home.ts';
import { deviceNick, forget, Link, recall, remember, shouldWake } from './net.ts';
import { MOVE_MS, Pieces } from './pieces.ts';
import { rules } from './rules.ts';
import { Sound } from './sound.ts';
import { buildShell, button, card, div, paintChip, popup, qrCanvas, rich, segment, toast, type Shell } from './ui.ts';

/** 联机那头的桌推过来的每一份快照 */
type StatePush = Extract<ToClient, { t: 'state' }>;

const LEVEL_CN: Record<Level, string> = { easy: '随手出', greedy: '挑省的', hard: '算赢面' };
/** 电脑想想再出：太即时看着不像人，太长磨叽 */
const AI_MS = 620;
/** 扣棋里一墩出完，全桌扣着停这么久再一起翻——现实里就是大家把牌摁住掀开的那一下，短到一拍就够，别让人干等 */
const FLIP_HOLD_MS = 600;
/** 翻开以后留来看清「这一墩谁最大」的那口气，比闷着那段长一点 */
const FLIP_READ_MS = 800;
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

/** 按钮条上一颗按钮这一拍该干什么；null = 这一拍没人接，画成按不动 */
type BtnRun = (() => void) | null;

/** 每次开桌摇一个新种子：固定种子会把牌序、起抽人、整桌布局一模一样的重演一遍 */
function rollSeed(): number {
  return Date.now() % 1_000_000_000;
}

/**
 * 邀请别人用的那串地址，第一个就是二维码的内容。
 * 这台设备自己够得着的 origin 最准——它不是回环就说明这条路真能走；
 * 房主在本机开页面时 origin 是 127.0.0.1，那份不能给别人扫，才退回房主进程报上来的局域网地址。
 */
function inviteUrls(lan: string[]): string[] {
  const host = location.hostname;
  const here = !isLoopback(host) && (location.protocol === 'http:' || location.protocol === 'https:') ? `${location.origin}/` : '';
  return [...new Set(here ? [here, ...lan] : lan)];
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
  /** 按钮条上那几颗：一遍遍改文字改反应，不是一颗颗拆了重搭（拆搭会把按到一半的那下丢掉） */
  private btnPool: HTMLButtonElement[] = [];
  private btnRuns: BtnRun[] = [];
  private btnAt = 0;
  /** 联机才有的这一截：连接一断，下面那些全是 null／空 */
  private link: Link | null = null;
  /** 我坐第几号位。单机把真人钉在 0 号位，联机的座位由桌说了算，画面全照这一个认「我」 */
  private me = 0;
  /** 各位子连着没、谁被代打了——名字条要画 */
  private seats: SeatInfo[] | null = null;
  /** 桌递给我这一手的合法着法，联机一律不自己算 */
  private liveActs: Action[] = [];
  /** 演到一半时来到的快照先攒在这儿，一份一份按 seq 演 */
  private queue: StatePush[] = [];
  private pull: ((m: StatePush | null) => void) | null = null;
  private seqDone = 0;
  /** welcome 到手之前，快照连自己是几号都还不知道，只能先攒着 */
  private seated = false;
  private myToken = '';
  private hostSeat = 0;
  /** 演过拍子的那一局。换一个种子就是开新局，整套画面跟着重来 */
  private openedSeed = -1;
  /** 结算卡摊着的话，close 就挂在这儿（开下一局、离桌都得收掉它） */
  private resultClose: (() => void) | null = null;
  /** 候场厅那块常驻面板；null = 没摊开。note 借给断线提示和 reject 那句话用 */
  private room: { veil: HTMLElement; note: HTMLElement; fill: (l: Seats) => void } | null = null;
  /** 这桌此刻在候场还是正在打：按钮给不给、循环起不起，全照这个认 */
  private status: TableStatus = 'waiting';
  /**
   * sitDown 占掉的那个 gen；跟当前 gen 不一样就说明那条循环已经散了。
   * 一开头必须是 null 不能是 0：全新页面 `gen` 也是 0，两个 0 撞一起会被读成「循环已经在跑」，
   * 房主第一次按开始就永远进不了牌桌。
   */
  private sitGen: number | null = null;
  private poll = 0;
  /** 断线时那句提示，连着就是空串 */
  private netNote = '';
  /** 这条连接是不是正等着桌把椅子认回来：这期间来的 reject 说的都是「座位没了」 */
  private reseat = false;

  constructor(private root: HTMLElement) {
    // 地址是别人给的那就是来入桌的，直接进候场厅；本机自己打开才先落在首页，由人自己挑玩法
    if (initialScreen(location.hostname) === 'room') this.openRoom();
    else this.showHome();
    // 手机切到别的 app 再回来：路由器早把他那条线收了，浏览器却还以为连着。
    // 与其等下一份快照等不来，不如回来这一刻就重新敲一次门
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.link) this.link.retry();
    });
    // 看门狗跟这条连接一样长：没连着就是每秒一次空转。安静多久该问一声、问而不答该不该拆线，全在 Link.beat 里
    window.setInterval(() => this.link?.beat(), 1000);
  }

  // ---------- 首页 ----------

  /**
   * 全屏首页：两个入口各占一条大热区，选完才进各自的配置。
   * 它是盖在屏幕上的一层，不是排在牌桌下面——单机打完一局退回来时身后还立着那副牌面。
   * 版面住在 home.ts（那儿进得了 node 测试），这儿只管往 root 上摘挂。
   */
  private showHome(): void {
    this.closeRoom();
    for (const el of this.root.querySelectorAll('.sheet, .home')) el.remove();
    this.root.append(
      homePanel(
        () => this.pickTable(),
        () => this.openRoom(),
      ),
    );
  }

  // ---------- 开桌 ----------

  /** 从首页那颗「自己玩」进来，身后就是首页：点空白退回那儿，不再是「不摆一桌就出不去的一张卡」 */
  private pickTable(): void {
    this.closeRoom();
    for (const el of this.root.querySelectorAll('.sheet')) el.remove();
    const chosen: Setup = { ...this.setup, seed: rollSeed() };
    popup(
      this.root,
      '摆一桌',
      (body, close, foot) => {
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
        // 主按钮进 foot：手机上这三排选项加说明早超出一屏，开桌那颗跟着滚就等于要人先滚到底再摸黑点
        foot.append(row);
      },
      false,
    );
  }

  // ---------- 候场厅 ----------

  /**
   * 常驻的候场厅：这桌的配置、每把椅子的下落、邀请二维码、房主那颗开始，全在这一块里。
   * 座位表一秒问一遍（谁进谁出都得看得见），所以架子只搭一次、来一份填一份，
   * 别整张重刷——重刷会把人正点下去的那一下吞掉。
   * 开局以后这块不消失：没坐上人的设备站在这儿当旁观席，随时挑一把椅子等下一局。
   */
  private openRoom(): void {
    if (this.room) {
      this.link?.askLobby();
      return;
    }
    const link = (this.link ??= new Link({
      onMsg: (m) => this.onPush(m),
      onStatus: (text) => this.onNet(text),
      onReady: () => this.onReady(),
    }));
    // 标题和内容归 body 滚，那几颗按钮归 foot 钉住；两列（配置／椅子）是 CSS 的事，
    // 手机上就是 cfg-col → seat-col 的自然顺序，一路单列滚到底
    const { veil, head, body, foot } = card(this.root, '正连着这桌……', 'room');
    const cfg = div('room-cfg');
    const rows = div('lobby-seats');
    const invite = div('invite');
    const note = div('note');
    const cfgCol = div('cfg-col');
    const seatCol = div('seat-col');
    cfgCol.append(cfg, note);
    seatCol.append(rows, invite);
    body.append(cfgCol, seatCol);
    const go = div('sheet-row');
    const out = div('sheet-row');
    // 底栏这几颗一秒问一回，只改字、不拆了重搭：它们现在正对着拇指，重建会吞掉按到一半的那一下
    const start = button('', () => link.send({ t: 'start' }), 'btn primary');
    const leave = button(
      '',
      () => {
        // 后面有牌桌就是「回去看一眼」，没有就是退回首页——差的正是这条连接
        const toBoard = !!this.shell;
        this.closeRoom();
        if (toBoard) return;
        this.link?.close();
        this.link = null;
        this.showHome();
      },
      'btn mini',
    );
    // 断线重连那几轮退避最磨人：这一颗不等下一轮，当场把这条线拆了重接
    const retry = button('刷新', () => link.retry(), 'btn mini');
    go.append(start);
    out.append(leave, retry);
    foot.append(go, out);
    let seatsFor = -1;
    let cfgKey = '';
    let inviteKey: string | null = null;

    const fill = (l: Seats) => {
      this.status = l.status;
      this.hostSeat = l.hostSeat;
      const waiting = l.status === 'waiting';
      const mine = recall();
      const iSeat = l.seats.find((s) => s.seat === this.me);
      const isHost = this.seated && this.me === l.hostSeat;
      const sitting = l.seats.filter((s) => s.online && !s.queued).length;
      const short = l.players - sitting;
      head.textContent = waiting ? `候场厅 · 第 ${l.gameNo} 局还没开` : `牌桌正在打 · 第 ${l.gameNo} 局`;

      // 配置：只有坐到了房主那一位、且还没开局才给改，其余人只读一行说明
      // hostSeat 也得算进键里：房主位一交接，那句「只有房主 P· 能改」就换了人，不重画会念错的
      const key = `${l.players}|${l.mode}|${l.level}|${isHost ? 1 : 0}|${waiting ? 1 : 0}|${l.hostSeat}`;
      if (key !== cfgKey) {
        cfgKey = key;
        cfg.innerHTML = '';
        const brief = `${l.players} 人 · ${l.mode === 'ming' ? '明棋' : '扣棋'} · 电脑补位用 ${LEVEL_CN[l.level]}`;
        if (!waiting) cfg.append(div('note', `这桌 ${brief}。开打了不让改，要改等下一局`));
        else if (!isHost) cfg.append(div('note', `这桌 ${brief}（只有房主 ${seatName(l.hostSeat)} 能改）`));
        else
          cfg.append(
            segment(
              '坐几个人',
              rules.playerCounts.map((n) => ({ text: `${n} 人`, value: n })),
              l.players,
              (v) => this.link?.send({ t: 'setup', players: v }),
            ),
            segment(
              '玩法',
              rules.modes.map((m) => ({ text: m === 'ming' ? '明棋 · 出牌即亮' : '扣棋 · 一墩打完才翻', value: m })),
              l.mode,
              (v) => this.link?.send({ t: 'setup', mode: v }),
            ),
            segment(
              '电脑补位',
              LEVELS.map((x) => ({ text: LEVEL_CN[x], value: x })),
              l.level,
              (v) => this.link?.send({ t: 'setup', level: v }),
            ),
          );
      }

      if (seatsFor !== l.players) {
        seatsFor = l.players;
        rows.innerHTML = '';
        for (const s of l.seats) {
          const row = div('seat-row');
          const who = div('who', seatName(s.seat));
          const tag = div('t');
          const sit = button('', undefined, 'btn');
          sit.addEventListener('click', () => this.takeSeat(s.seat));
          const quit = button('让座', () => this.standUp(), 'btn mini stand');
          // 两颗按钮捆成右侧那一格，状态那句独占第二行——不用再跟按钮抢同一条横线的宽度
          const act = div('seat-act');
          act.append(sit, quit);
          row.append(who, tag, act);
          rows.append(row);
        }
      }
      l.seats.forEach((s, seat) => {
        const row = rows.children[seat] as HTMLElement | undefined;
        if (!row) return;
        // 自己那把椅子候场时给一条退路：坐错了、或者这桌要减人，都得先让座
        row.classList.toggle('mine', waiting && this.seated && s.seat === this.me);
        // 房主位标出来：跑命令那位就认得该坐哪把，别人也知道开局那颗在谁手上
        row.querySelector('.who')!.textContent =
          seat === l.hostSeat ? `${seatName(s.seat)} · 房主位` : seatName(s.seat);
        // 一把椅子是谁坐的得看得见：同一台机器开两个标签页，只写「有人」就分不清哪把归谁
        const own = this.seated && this.me === seat;
        const back = mine?.seat === seat;
        const who = s.nick ? ` · ${s.nick}` : '';
        row.querySelector('.t')!.textContent = s.online
          ? own
            ? s.queued
              ? '你在这儿 · 这一局先由电脑打'
              : '你在这儿'
            : s.queued
              ? `有人${who} · 这一局先由电脑打`
              : `有人${who}`
          : s.taken
            ? own || back
              ? `掉线了${who}，凭令牌坐得回来`
              : `掉线了${who}`
            : s.ai
              ? '电脑补位'
              : waiting
                ? '空着'
                : '电脑位';
        const btn = row.querySelector('button')!;
        // 正坐着的那把椅子，那颗按钮永远是灰的「你坐这儿」——按不动的按钮就是噪音，直接撤掉。
        // 桌那边线掉了、这把椅子还认得你，才给一颗按得动的「坐回这位」
        const rejoin = !s.online && (own || back);
        btn.hidden = own && s.online;
        btn.textContent = rejoin
          ? '坐回这位'
          : back
            ? '回到这位'
            : s.taken
              ? '这把有主'
              : waiting
                ? seat === l.hostSeat
                  ? '坐下 · 当房主'
                  : '坐下'
                : '坐下 · 等下一局';
        btn.disabled = s.online || (s.taken && !back);
        btn.classList.toggle('primary', !btn.disabled);
      });

      const urls = inviteUrls(l.lan);
      const urlKey = urls.join(' ');
      if (urlKey !== inviteKey) {
        inviteKey = urlKey;
        invite.innerHTML = '';
        const qr = urls.length ? qrCanvas(urls[0]!) : null;
        if (qr) invite.append(qr);
        const col = div('invite-col');
        for (const u of urls) col.append(div('u', u));
        col.append(
          div(
            'note',
            !urls.length
              ? '没找到局域网地址：这台机器好像没连上路由器'
              : !qr
                ? '地址太长，画不出二维码，照着敲吧'
                : '同一张网里的设备扫这个，或照地址敲进浏览器——码画的是第一条',
          ),
        );
        invite.append(col);
      }

      note.textContent = !waiting
        ? this.seated
          ? iSeat?.queued
            ? '你来得晚了：这一局先让电脑打，下一局开局归你'
            : '你正坐在牌桌上，这一局在打；改配置得等开下一局'
          : '这一局正在打。先坐下，下一局开局就归你打。'
        : !this.seated
          ? `挑一把椅子坐下${short > 0 ? `；还差 ${short} 个位子` : ''}。房主位 ${seatName(l.hostSeat)} ${
              l.seats[l.hostSeat]?.taken ? '已经有人' : '还空着，谁先坐下谁当房主'
            }`
          : isHost
            ? `你是房主 ${seatName(this.me)}｜${short > 0 ? `${short} 个位子没人坐，开局就由电脑补` : '位子坐满了，可以开局'}`
            : `已坐下，等 ${seatName(l.hostSeat)} 开局`;

      start.hidden = !(waiting && isHost);
      start.textContent = short > 0 ? `开始这一局（${short} 个位子由电脑补）` : '开始这一局';
      // 出去的路看后面有没有牌桌：候场期这块面板底下是空的，合上它就只剩白屏，那种时候只给「回首页」
      leave.textContent = this.shell ? '看牌桌' : '回首页';
    };
    this.room = { veil, note, fill };
    link.askLobby();
    // 谁进谁出得看得见：站在这儿就一秒问一遍
    this.poll = window.setInterval(() => link.askLobby(), 1000);
  }

  /** 收掉候场厅：桌已开局那份接管画面，或者是坐着的人自己按「看牌桌」掀开又合上 */
  private closeRoom(): void {
    const room = this.room;
    if (!room) return;
    this.room = null;
    window.clearInterval(this.poll);
    this.poll = 0;
    room.veil.remove();
  }

  /** 坐下且桌已开局，才进牌桌那条循环；候场厅里坐着只是等 */
  private maybeStart(): void {
    if (!this.seated || this.status !== 'playing' || this.sitGen === this.gen) return;
    this.closeRoom();
    void this.sitDown();
  }

  /** 坐下／回到某一把椅子：令牌对得上就认回原来那位，空椅子随便坐 */
  private takeSeat(seat: number): void {
    const link = this.link;
    const room = this.room;
    if (!link || !room) return;
    const mine = recall();
    link.send({ t: 'join', seat, token: mine?.seat === seat ? mine.token : '', nick: deviceNick() });
    room.note.textContent = '正往那把椅子上坐……';
  }

  /** 让座：椅子还回候场厅，本地也跟着站起来——不然按钮还挂着「你已坐下」，人以为坐着的还是自己 */
  private standUp(): void {
    const link = this.link;
    if (!link || !this.seated) return;
    link.send({ t: 'stand' });
    this.standLocal('');
    link.askLobby();
  }

  /**
   * 本地站起来：把「你在这儿」那一套全拆掉，回到候场厅重挑椅子。
   * 递一句话就把它摆在明面上（桌不认原来那把椅子时用）；空串是自己让的座，不用解释。
   */
  private standLocal(why: string): void {
    this.gen++; // 万一那条循环还挂着，让它散
    this.seated = false;
    this.myToken = '';
    // 这一局的牌面也不再是我的了：那条循环还等着的下一份快照永远不会来，给它一个收场
    const pull = this.pull;
    this.pull = null;
    pull?.(null);
    this.queue.length = 0;
    this.liveActs = [];
    // 令牌是桌发的，桌既然不认这把椅子，这份就该跟着还回去，别留着下次再撞
    forget();
    if (!this.room) this.openRoom();
    if (!why) return;
    if (this.room) this.room.note.textContent = why;
    else if (this.shell) toast(this.shell.toast, why, 2400);
  }

  /** 每次握手成功都走这儿：还站在候场厅就重问座位表，已经坐下就凭令牌认回那把椅子 */
  private onReady(): void {
    if (!this.seated) {
      this.link?.askLobby();
      return;
    }
    // 断线这段时间别人可能已经把牌打出去好几手，补演一遍不如照最新那份摆。
    // seq 也得清零：房主要是从存档重启过，桌那份计数是从头开始的
    this.queue.length = 0;
    this.seqDone = 0;
    this.reseat = true;
    this.link?.send({ t: 'join', seat: this.me, token: this.myToken, nick: deviceNick() });
  }

  private onNet(text: string): void {
    this.netNote = text;
    if (this.shell) this.paintMeta();
    // 候场厅摊着时那块就是唯一的落脚处：那会儿连台面都还没搭，toast 没地方放
    if (text && this.room) this.room.note.textContent = text;
    if (text && this.shell) toast(this.shell.toast, text, 2000);
  }

  /** 桌说的一切话都先落这儿：入座前的快照攒着，reject 只有一句话 */
  private onPush(m: ToClient): void {
    switch (m.t) {
      case 'seats':
        this.hostSeat = m.hostSeat;
        this.room?.fill(m);
        return;
      case 'welcome': {
        this.reseat = false;
        remember(m.seat, m.token);
        this.me = m.seat;
        this.myToken = m.token;
        this.status = m.status;
        if (this.seated) return; // 重连认回原座，牌桌那边不用重开
        this.seated = true;
        // 中途落座不补演整局：最新那份快照就是现在的牌面，攒着的旧帧只留最后一份
        if (m.status === 'playing') this.queue = this.queue.slice(-1);
        this.maybeStart();
        return;
      }
      case 'state': {
        // 候场期间那份快照只是「谁进谁出」，开局这一翻把旧帧丢掉，从第一手演起。
        // 认这份快照自己的 status，别认 this.status：候场厅一秒问一遍座位表，
        // 那份 seats 会抢先把 this.status 翻成 playing，旧帧就漏在队列里演给你看
        if (m.status === 'playing' && this.queue.some((q) => q.status !== 'playing')) this.queue.length = 0;
        this.status = m.status;
        if (this.seated) this.take(m);
        else this.queue.push(m);
        this.maybeStart();
        return;
      }
      case 'reject': {
        const why = m.why;
        // 这一句是冲着椅子来的：断线那会儿位子被人坐了、或者这桌减了人。
        // 那条循环还卡在等入座后的第一份快照，等不到就会死在这儿——站起来回候场厅重挑一把
        if (this.reseat) {
          this.reseat = false;
          this.standLocal(why);
          return;
        }
        if (this.room) this.room.note.textContent = why;
        else if (this.shell) toast(this.shell.toast, why, 1600);
        // 桌不认这一手，牌面也就没变、不会再推新的快照过来：循环还卡在等下一份，把按钮重新挂上，别让人干等
        if (this.seated && this.pull) void this.waitForTurn();
        return;
      }
      case 'pong':
        return;
    }
  }

  /** 一份快照演完之前来到的下一份就攒着，别把拍子踩乱 */
  private take(m: StatePush): void {
    if (m.seq <= this.seqDone) return;
    // 卡在「等我出牌」时那条循环不会来取队列：桌只要不再动牌，画面就冻在旧那一份上，
    // 名字条里的「掉线」擦不掉，对面却已经打下去了。该解的在这儿解一把（口径见 shouldWake）。
    if (this.ask && shouldWake(m)) this.ask(null);
    const pull = this.pull;
    if (pull) {
      this.pull = null;
      pull(m);
      return;
    }
    this.queue.push(m);
  }

  /** 下一份要演的快照。null 表示这桌已经离了 */
  private nextState(): Promise<StatePush | null> {
    const hit = this.queue.shift();
    if (hit) return Promise.resolve(hit);
    return new Promise((res) => {
      this.pull = res;
    });
  }

  /** 坐下以后就是这一条路：桌推一份、这儿演一拍，本地不 apply、不算 AI、不掷骰子 */
  private async sitDown(): Promise<void> {
    const gen = ++this.gen;
    this.sitGen = gen;
    const first = await this.nextState();
    if (!first || gen !== this.gen) return;
    this.setup = { players: first.view.players, mode: first.view.mode, level: this.setup.level, seed: first.view.seed };
    this.book = openMatch(this.setup.players);
    this.seqDone = first.seq;
    this.openedSeed = -1;
    this.stage(this.setup.players, deckFor(first.view));
    try {
      for (let m: StatePush | null = first; m && gen === this.gen; m = await this.nextState()) {
        await this.applyPush(m);
      }
    } catch (e) {
      if (e instanceof Aborted || gen !== this.gen) return;
      console.error(e);
      this.shell.status.textContent = `出了点问题：${(e as Error).message}｜按右上角「${this.link ? '离桌' : '换桌'}」回首页`;
    }
  }

  /** 演一份快照：先换牌面，再照 last 演那一手，最后该我出就把按钮挂上 */
  private async applyPush(m: StatePush): Promise<void> {
    // 桌那边在候场厅改了人数/玩法，这边得跟着改：名字条、收牌摞、meta 全按 this.setup 走，
    // 慢一步就是 chips[3] 空着按一下那一下
    if (m.view.players !== this.setup.players || m.view.mode !== this.setup.mode) {
      this.setup = { ...this.setup, players: m.view.players, mode: m.view.mode };
    }
    // 跨局那本账只有桌上一本：改人数、重连、中途入座随便哪条路，这边照收到的那份画就行，
    // 自己攒一本迟早跟桌这本对不上号
    this.book = m.book;
    this.seqDone = m.seq;
    this.seats = m.seats;
    this.liveActs = m.acts;
    this.maskFrom = m.maskFrom;
    const fresh = m.view.seed !== this.openedSeed;
    const wonBefore = fresh ? [] : [...this.state.won];
    const onTable = fresh ? null : this.view.freeze;
    this.state = hydrate(m.view);
    this.pieces.paint(deckFor(m.view));
    if (fresh) this.beginGame(m);
    else if (m.last) await this.frame(m.last.seat, m.last.action, wonBefore, onTable);
    else {
      // 没有要演的手（刚入座、有人进出桌、重连）：照桌给的牌面摆出来就行，别自己猜拍子
      this.view.freeze = this.state.trick ? this.snapshot() : null;
      this.rebuildPiles();
      this.render(true);
    }
    if (this.state.phase === 'over' && (fresh || m.last)) this.showResult();
    await this.waitForTurn();
  }

  /** 联机开一局：牌面和第几局都是桌定的，这里只把表现层那一套清零。中途坐下也会走这儿，收牌摞要照牌面补回来 */
  private beginGame(m: StatePush): void {
    this.openedSeed = m.view.seed;
    this.gameNo = m.gameNo;
    this.view = this.freshView(this.setup.players);
    this.view.freeze = this.state.trick ? this.snapshot() : null;
    this.rebuildPiles();
    this.maskFrom = m.maskFrom;
    this.paintMeta();
    this.render(false);
    this.resultClose?.();
    toast(this.shell.toast, `第 ${this.gameNo} 局｜${this.who(this.state.drawer)} 起抽`, 1800);
  }

  /**
   * 收牌摞重建：桌上没记「哪几张是谁收的」，按 won 的数目把已经不在手里、不在桌上的牌摊进去就行。
   * 一墩打完那些牌全翻开了，牌面对谁都公开，摊错家也不泄底。
   */
  private rebuildPiles(): void {
    const state = this.state;
    const loose = new Set(state.pieces.map((p) => p.id));
    for (const ids of [...state.hands, ...(state.draft?.stacks ?? [])]) for (const id of ids) loose.delete(id);
    const trick = state.trick;
    for (const ids of [...(trick?.plays ?? []), ...(trick?.discards ?? [])].map((p) => p.pieceIds))
      for (const id of ids) loose.delete(id);
    const pool = [...loose].sort((a, b) => a - b);
    let at = 0;
    this.view.piles = state.won.map((n) => pool.slice(at, (at += n)));
  }

  /** 该我出：把按钮挂在这儿，点了就递出去。这期间别人的落子只攒不演，我出牌前不该先看一圈 */
  private waitForTurn(): Promise<void> {
    if (this.state.phase === 'over' || this.liveActs.length === 0 || !pendingSeats(this.state).includes(this.me)) {
      return Promise.resolve();
    }
    return new Promise<void>((res) => {
      const arm = (action: Action | null): void => {
        // null 是从「离桌」那儿来的：这一手不递了，但循环得接着走
        if (!action) {
          this.ask = null;
          res();
          return;
        }
        // 断线时按下的那一手当场作废：不排队、不补发，回来只看桌推的最新牌面。
        // 这一手没走掉，按钮就还挂着——选着的牌也还在，连回来照着新牌面再按一次就行。
        if (!this.link?.send({ t: 'act', action })) {
          toast(this.shell.toast, '这一手没递上去：和桌断了。连回来照着最新牌面再出一次。', 2400);
          this.ask = arm;
          this.render(true);
          return;
        }
        this.ask = null;
        res();
      };
      this.ask = arm;
      this.render(true);
    });
  }

  /** 结算卡：联机不拦循环，房主按了下一局自己会推来新的一帧 */
  private showResult(): void {
    const state = this.state;
    const host = this.me === this.hostSeat;
    const top = winners(state);
    const no = this.gameNo;
    const next = nextDrawer(state);
    const title =
      top.length === 1
        ? `第 ${no} 局｜${this.who(top[0]!)} 夺冠`
        : top.length > 1
          ? `第 ${no} 局｜${top.map((s) => this.who(s)).join('、')} 并列`
          : `第 ${no} 局｜谁都没收到牌`;
    this.sound.cue('win');
    this.resultClose?.();
    popup(
      this.root,
      title,
      (body, close, foot) => {
        this.resultClose = () => {
          this.resultClose = null;
          close();
        };
        this.rankRows(body, next);
        const note = div('note');
        note.textContent = host
          ? `你是房主 ${seatName(this.me)}，下一局在候场厅里由你按开始。`
          : `等 ${this.who(this.hostSeat)} 开下一局；想挑椅子、看谁坐哪儿，去候场厅。`;
        body.append(note);
        const row = div('sheet-row');
        if (host)
          row.append(
            button('开始下一局', () => {
              this.resultClose = null;
              close();
              this.link?.send({ t: 'start' });
            }, 'btn primary'),
          );
        row.append(
          button(
            '候场厅',
            () => {
              this.resultClose = null;
              close();
              this.openRoom();
            },
            'btn mini',
          ),
          button('复制战报', () => void this.copyReport(body, title), 'btn mini'),
        );
        // 这一样是被名次撑长的一屏：开始下一局那颗不能跟着滚走
        foot.append(row);
        this.bookRows(body);
      },
      true,
    );
  }

  /** 离桌：连接断掉，椅子还留给这个令牌，从首页那颗「同一张网」回来凭它还坐这一位 */
  private leaveTable(): void {
    this.resultClose?.();
    this.gen++; // 占着的那条循环散伙，sitGen 一老，候场厅里再坐下才起得来
    this.link?.close();
    this.link = null;
    this.seated = false;
    this.queue.length = 0;
    this.seats = null;
    this.liveActs = [];
    this.netNote = '';
    this.showHome();
  }

  private async match(setup: Setup): Promise<void> {
    const gen = ++this.gen;
    this.setup = setup;
    // 单机把真人钉回 0 号位：刚从联机那桌下来时，这个字段记的还是桌给的那一位
    this.me = 0;
    this.rng = mulberry32(setup.seed ^ 0x9e3779b9);
    this.book = openMatch(setup.players);
    this.gameNo = 0;
    this.drawer = -1;
    this.state = createGame({ rules, players: setup.players, mode: setup.mode, seed: setup.seed });
    this.stage(setup.players, this.state.pieces);
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
      this.shell.status.textContent = `出了点问题：${(e as Error).message}｜种子 ${this.state.seed}｜按右上角「换桌」回首页`;
    } finally {
      // 收杆回到首页，别把玩家丢在一幅打完的牌面上；崩了就留着牌面，好截图看
      if (gen === this.gen && !crashed) this.showHome();
    }
  }

  /** 搭台面：一次搭好壳子、牌摞和事件。单机用整副牌，联机先按快照里的牌面（没公开的还没字） */
  private stage(players: number, deck: Piece[]): void {
    this.shell = buildShell(
      this.root,
      players,
      Math.max(...rules.playerCounts),
      () => this.resign(),
      () => this.toggleLog(),
      () => this.toggleSound(),
    );
    this.shell.setup.textContent = this.link ? '离桌' : '换桌';
    this.paintSound();
    this.pieces = new Pieces(this.shell.board, deck);
    // 按钮池里那几颗挂在旧壳子上，壳子换了它们就是孤儿——重搭一次台面就整个忘掉
    this.btnPool = [];
    this.btnRuns = [];
    this.btnAt = 0;
    this.wire();
  }

  /** 表现层自己攒的那一沓：收牌摞、选中态、动画进行到第几拍 */
  private freshView(players: number): TableView {
    return {
      mine: this.me,
      piles: Array.from({ length: players }, () => [] as number[]),
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
  }

  private paintMeta(): void {
    const mode = this.setup.mode === 'ming' ? '明棋' : '扣棋';
    this.shell.meta.textContent = this.link
      ? `联机 · ${mode} · ${this.setup.players} 人 · 第 ${this.gameNo} 局 · 我是 ${seatName(this.me)} · 种子 ${this.state.seed}${
          this.netNote ? ` · ${this.netNote}` : ''
        }`
      : `${mode} · ${this.setup.players} 人 · 电脑${LEVEL_CN[this.setup.level]} · 第 ${this.gameNo} 局 · 种子 ${this.state.seed}`;
  }

  /** 结算卡里那几行名次，单机联机共用；drawer 是下一局起抽的那位 */
  private rankRows(body: HTMLElement, drawer: number): void {
    const rank = [...this.state.won.keys()].sort((a, b) => this.state.won[b]! - this.state.won[a]!);
    for (const seat of rank) {
      const row = div('rank-row');
      row.append(
        div('who', this.who(seat)),
        div('n', `${this.state.won[seat]} 枚`),
        div('t', seat === drawer ? '下一局起抽' : ''),
      );
      body.append(row);
    }
  }

  private bookRows(body: HTMLElement): void {
    const total = div('note');
    total.textContent = `累计 ${this.book.games} 局：${this.book.titles
      .map((t, seat) => `${this.who(seat)} 冠 ${t}`)
      .join('　')}｜并列 ${this.book.ties} 局`;
    body.append(total);
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
    this.view = this.freshView(this.setup.players);
    this.maskFrom = -1;
    this.paintMeta();
    this.render(false);
    toast(this.shell.toast, `第 ${this.gameNo} 局｜${this.who(this.state.drawer)} 起抽`, 1800);
  }

  private async playOne(): Promise<'done' | 'abort'> {
    for (;;) {
      const seats = pendingSeats(this.state);
      if (seats.length === 0) return 'done';
      // 扣棋里几家是并列的：先把真人要的那手收走，他才不会看见别人已经出了什么
      if (seats.includes(this.me)) {
        const action = await new Promise<Action | null>((res) => {
          this.ask = res;
          this.render(true); // 先挂上 ask 再画：按钮只在「点了真有人接」时出现
        });
        if (action === null) return 'abort';
        await this.act(this.me, action);
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

  /** 单机这一手：自己落子再演拍子。联机那份快照已经落好了，直接走 frame */
  private async act(seat: number, action: Action): Promise<void> {
    const wonBefore = [...this.state.won];
    const onTable = this.view.freeze;
    const logBefore = this.state.log.length;
    apply(this.state, seat, action);
    this.mask(logBefore);
    await this.frame(seat, action, wonBefore, onTable);
  }

  /** 一手的拍子：状态得是落好这一手以后的，两边共用这一套动画 */
  private async frame(seat: number, action: Action, wonBefore: number[], onTable: OnTable[] | null): Promise<void> {
    this.busy = true;
    try {
      this.view.sel.clear();
      this.view.spread = false;
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
    // 扣棋：全员出完闷一小拍，再一起翻开
    if (this.state.mode === 'kou') {
      await this.nap(FLIP_HOLD_MS);
      this.view.holdDown = new Set();
      this.render(true);
    }
    // 刚翻开，留一眼看清这一墩谁最大
    await this.nap(this.state.mode === 'kou' ? FLIP_READ_MS : 560);
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
        (body, close, foot) => {
          this.rankRows(body, this.drawer);
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
          // 名次那几行加长、战报还能摊开，这一屏随时被撑得一屏装不下：那三颗钉在卡底
          foot.append(row);
          this.bookRows(body);
        },
        true,
      );
    });
  }

  /** 结算那份复盘原文：座位名跟屏上口径一致（日志里写的 P1/P2，这儿标出哪一位是你） */
  private reportText(title: string): string {
    const state = this.state;
    const head = `棋墩墩 · ${state.mode === 'ming' ? '明棋' : '扣棋'} · ${state.players} 人（我是 ${seatName(this.me)}）· 种子 ${state.seed}`;
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

  /** 右上角那张：单机联机都退回首页。正在等的两件事都得散伙——一是人要点牌，二是循环在等下一份快照 */
  private resign(): void {
    const online = this.link !== null;
    const go = () => {
      this.gen++;
      const ask = this.ask;
      this.ask = null;
      ask?.(null);
      const pull = this.pull;
      this.pull = null;
      pull?.(null);
      if (online) this.leaveTable();
      else this.showHome();
    };
    if (this.state.phase === 'over') {
      go();
      return;
    }
    popup(this.root, online ? '离桌' : '换桌', (body, close) => {
      const p = div('note');
      p.textContent = online
        ? '这一局还没打完，离桌就不记账了。椅子给你留着，从首页再点「同一张网」还坐这一位。'
        : '这一局还没打完，换桌就不记账了。';
      const row = div('sheet-row');
      row.append(
        button(online ? '确认离桌' : '确认换桌', () => {
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
      const mine = this.view.freeze?.find((p) => p.seat === this.me && p.ids.includes(id));
      if (mine) {
        this.togglePeek(mine);
        return;
      }
    }
    if (this.ask === null || state.phase === 'over') return;
    if (!pendingSeats(state).includes(this.me) || !state.hands[this.me].includes(id)) return;
    // 挤成一条边了才先点一下把整排摊开；宽桌面上扇形本来就张得开，点哪张就是哪张
    if (!this.view.spread && handCramped(state.hands[this.me]!.length, this.size())) {
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
    // 联机不自己算合法着法：桌递什么按钮就画什么，本地这份 state 里别人的牌是空的，算也算不准
    this.acts = actors.includes(this.me) ? (this.link ? this.liveActs : legalActions(this.state, this.me)) : [];
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
    this.paintPrompt(board);
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
    return seat === this.me ? '你' : seatName(seat);
  }

  private paintChips(board: Board): void {
    const state = this.state;
    const actors = new Set(this.pending());
    const draft = state.draft;
    // 名字条贴在自家那摞旁边：落点和收牌摞的几何同源于 board.ts，CSS 只管长相。
    // 传 this.me 是因为这四块地盘跟着看桌的人转——联机坐 P2 时不转就得挂到对面那角去
    for (const band of labelBands(state.players, board, this.me)) {
      const el = this.chip(band.seat);
      // 168 是留给收牌摞让位的最坏宽度，字通常不到一半：钉哪一头决定它贴不贴角。
      // 右半场那几条要还是从框的左边长，就正好飘在桌心一侧，读起来像别人家的（截图里就是这么乱）
      el.style.left = band.edge === 'left' ? `${band.x}px` : '';
      el.style.right = band.edge === 'right' ? `${board.w - band.x - band.w}px` : '';
      el.style.top = `${band.y}px`;
    }
    for (let seat = 0; seat < this.shell.chips.length; seat++) {
      const chip = this.chip(seat);
      // 壳子里的条比这桌的人多出来的那几条：不亮，也别占着位子
      chip.hidden = seat >= state.players;
      if (chip.hidden) continue;
      const parts = this.shell.chipEls[seat]!;
      let tag = '';
      // 本墩第几手：顺时针从先出那家数过去，扣棋并发时这就是「谁在前、谁在后」
      let ord: number | null = null;
      if (draft) {
        tag = seat === draft.drawer ? '起抽' : draft.stage === 'allocate' && seat === draft.decider ? '处置人' : '';
      } else if (state.trick) {
        ord = ((seat - state.trick.leader + state.players) % state.players) + 1;
        const played =
          state.trick.plays.some((p) => p.player === seat) || state.trick.discards.some((d) => d.player === seat);
        tag = played ? '已出' : state.hands[seat]!.length === 0 ? '没牌' : seat === this.me ? '你出' : '在想';
      } else if (state.phase !== 'over') {
        tag = state.leader === seat ? '先出' : '';
      }
      // 联机：谁不在这儿，比「在想什么」要紧得多，直接顶掉那一格；条子暗下去一眼扫得出来
      if (this.seats) {
        const s = this.seats[seat];
        if (s?.ai) tag = '代打';
        else if (s && !s.online && s.taken) tag = '掉线';
        chip.classList.toggle('gone', !!s && !s.online);
      }
      // 「电脑」不写进条里：顶栏 meta 已经报过一次难度，而这条 pill 的宽度是几何量（LABEL_W），得省着用
      const who = seat === this.me ? '你' : seatName(seat);
      paintChip(chip, parts, who, tag, state.hands[seat]!.length, state.won[seat]!, ord);
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

  private paintPrompt(board: Board): void {
    // 按钮不是一颗颗拆了重搭：这一拍用掉几颗，剩下的藏起来（搭法见 takeBtn）
    this.btnAt = 0;
    if (this.busy) {
      this.endBtns();
      return; // 动画正在演，这一帧不给按钮、也不盖掉动画写的提示
    }
    try {
      this.promptInto(board);
    } finally {
      this.endBtns();
    }
  }

  private promptInto(board: Board): void {
    const state = this.state;
    const shell = this.shell;
    // 循环没在等人点的时候，按钮点了也没人接（循环抛异常死掉就是这样）——干脆别画
    const clickable = this.ask !== null;
    const draft = state.draft;
    if (draft) {
      if (draft.stage === 'draw') {
        shell.status.textContent =
          draft.drawer === this.me
            ? this.hasHover
              ? '轮到你摸签：鼠标压上来那一摞就摊开，点哪张抽哪张'
              : '轮到你摸签：先点一摞把它摊开，再点你要抽的那张'
            : `${this.who(draft.drawer)} 正在摸签…`;
      } else {
        const piece = state.byId.get(draft.drawn)!;
        rich(shell.status, [
          `${this.who(draft.drawer)} 翻出 `,
          { b: pieceLabel(piece) },
          `，${piece.point} 点从自己数到 `,
          { b: this.who(draft.decider) },
          draft.decider === this.me ? '：这 8 摞怎么分你定' : `：${this.who(draft.decider)} 定怎么分`,
        ]);
        if (draft.decider === this.me && clickable) for (const a of this.acts) this.takeBtn(this.describe(a), () => this.commit(a));
      }
      return;
    }
    if (state.phase === 'over') {
      shell.status.textContent = '这一局打完了，看结算。';
      return;
    }
    const actors = pendingSeats(state);
    if (!actors.includes(this.me)) {
      const who = actors.map((s) => this.who(s)).join('、');
      shell.status.textContent = state.mode === 'kou' && state.trick ? `${who} 同时暗出…` : `${who} 出牌中…`;
      return;
    }
    const others = actors.filter((s) => s !== this.me);
    const atOnce = state.mode === 'kou' && state.trick && others.length > 0;
    // 扇形本来就摊得开（宽桌面）就直接点那张，这句只在挤成一条边时才提示；第一下是「摊开」不是「出这张」
    const tapFirst = this.view.spread || !handCramped(state.hands[this.me]!.length, board) ? '' : '先点一下把手牌摊开，再点那几张｜';
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
    if (match) this.takeBtn(this.describe(match), () => this.commit(match), 'btn primary');
    else if (this.view.sel.size > 0) this.takeBtn(this.whyNot(this.view.sel), null);
    if (this.view.sel.size > 0) {
      this.takeBtn('清空', () => {
        this.view.sel.clear();
        this.render(true);
      });
    }
  }

  /**
   * 按钮条上的第 n 颗：有就改文字改反应，没有才新搭一颗。
   * 每拍拆了重搭的话，按到一半的那一下会被拆掉，手慢一点就白点一次。
   */
  private takeBtn(text: string, run: (() => void) | null, cls = 'btn'): void {
    const i = this.btnAt++;
    let el = this.btnPool[i];
    if (!el) {
      el = button('', undefined, cls);
      // 认座位下标不认闭包：一颗按钮只挂一个监听器，按下去现查这一拍它该干什么
      el.addEventListener('click', () => {
        const act = this.btnRuns[i];
        if (act) act();
      });
      this.shell.ctrl.append(el);
      this.btnPool[i] = el;
    }
    el.textContent = text;
    el.className = run ? cls : `${cls} dim`;
    el.disabled = !run;
    el.hidden = false;
    this.btnRuns[i] = run;
  }

  /** 这一拍没点到的那颗：藏起来，别留在条上还按得动 */
  private endBtns(): void {
    for (let i = this.btnAt; i < this.btnPool.length; i++) {
      const el = this.btnPool[i]!;
      if (!el.hidden) el.hidden = true;
      this.btnRuns[i] = null;
    }
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
