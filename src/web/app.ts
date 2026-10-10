import { LEVELS, type Level } from '../ai/agent.ts';
import {
  createGame,
  legalActions,
  pendingSeats,
  seatName,
  type Action,
  type GameState,
} from '../core/game.ts';
import { pieceLabel, type Piece } from '../core/pieces.ts';
import { nextDrawer, openMatch, winners, type MatchBook } from '../core/match.ts';
import { mulberry32 } from '../core/rng.ts';
import { aliveSeats, deckFor, hydrate, type SeatInfo, type Seats, type TableStatus, type ToClient } from '../net/wire.ts';
import { LIST_REFRESH_MS, peerNote, type FoundRoom } from '../net/discover.ts';
import { ABOUT_RULES, aboutMeta } from './aboutText.ts';
import { ctrlLift, draftShape, handCramped, labelBands, LABEL_W, layout, maxStacks, pieceSize, stackSpots, type Board, type TableView } from './board.ts';
import { recallSolo, rememberSolo } from './net.ts';
import { appVersion, autoSeat, BACK, entryHead, fillAddr, homePanel, hostHanded, hostJump, inAppShell, initialScreen, inviteUrls, lobbyGuide, peerEmpty, roomRow, seatOption, seatRowText } from './home.ts';
import { aiActionFor, bookLine, closedTable, newGameState, reportText, settleMatch, stepAndMask, type OnTable } from './local.ts';
import { deviceNick, forget, Link, recall, remember, setTableAddr, shouldWake, tableAddr } from './net.ts';
import { MOVE_MS, Pieces } from './pieces.ts';
import { rules } from './rules.ts';
import { Sound } from './sound.ts';
import {
  buildShell,
  button,
  div,
  page,
  paintChip,
  popup,
  qrCanvas,
  rich,
  segment,
  toast,
  type Shell,
} from './ui.ts';

/** 联机那头的桌推过来的每一份快照 */
type StatePush = Extract<ToClient, { t: 'state' }>;

const LEVEL_CN: Record<Level, string> = { easy: '入门', greedy: '常手', hard: '老手' };
/** 电脑想想再出：太即时看着不像人，太长磨叽 */
const AI_MS = 620;
/** 扣棋里一墩出完，全桌扣着停这么久再一起翻——现实里就是大家把牌摁住掀开的那一下，短到一拍就够，别让人干等 */
const FLIP_HOLD_MS = 600;
/** 翻开以后留来看清「这一墩谁最大」的那口气，比闷着那段长一点 */
const FLIP_READ_MS = 800;
/**
 * 收牌前那一拍：翻开的牌先在桌面上翻回背面、落定，再整墩收进牌摞（用户点名：收要「扣着收」）。
 * 省掉这一拍直接收，翻转就和挪位挤在同一拍里——牌在往摞里飞的半路变脸，看得清它落在哪一家。
 * 250ms 是 CSS 那条翻面的时长（`.turn` 的 transition），留点余量给它跑完。
 */
const FLIP_COVER_MS = 320;
/**
 * 摸签八拍的节奏表，数值只管这一处，要调节奏改这里就行（顺序见 drawShow 的注释）。
 * spread/tuck 是整列补间的落位时间；lift/cover 那张牌在原地放大、缩回，补间一样长。
 */
const BEAT = {
  /** 摊开：那一摞四张彻底铺开，互不遮挡，每张都能单独点 */
  spread: 700,
  /** 选中：点中这张描一道金、原地大一圈，其余那些摞降透明 */
  pick: 260,
  /** 抽出：这张在自己那一格里放大到 1.3 倍并翻面 */
  lift: MOVE_MS,
  /** 亮牌：就在摞上给你看清点数 */
  show: 900,
  /** 数点：一家一下 */
  countStep: 360,
  /** 定人：亮出「这一排摞怎么分归谁定」 */
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
 * 列表页那句「正在寻」。进这一屏就摆上，寻到之前一直摆着——寻呼是一个广播往返，
 * 空着屏让人猜「是不是没有」比多写这七个字糟得多（2026-10-09 用户：「刚开始还以为没有，像有 bug」）。
 */
const SEARCHING = '正在这块网上寻一圈……';

export class App {
  private shell!: Shell;
  private pieces!: Pieces;
  private state!: GameState;
  private view!: TableView;
  private book!: MatchBook;
  private setup: Setup = { players: 2, mode: 'kou', level: 'easy', seed: 0 };
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
  /** 桌面在视口里的位置，只随尺寸变化重算（见 measureBoard）：pointermove 里现量 DOM 会把「改 transform → 强制重排」串成每帧一次 */
  private boardRect = { left: 0, top: 0 };
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
  /** 单机结算卡那两颗（再来一局／收杆）要回的 Promise；从结算卡上「换桌」走时得给它一个收场，别让 match 那条循环永远吊着 */
  private againRes: ((v: boolean) => void) | null = null;
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
  private room: {
    veil: HTMLElement;
    note: HTMLElement;
    fill: (l: Seats) => void;
  } | null = null;
  /**
   * 同网桌列表那一层；null = 没站着。同网别的桌只有这一处看得见——候场厅里不摆第二份：
   * 人已经在这张桌上了，桌上还挂一条「去别的桌」是拿别人的桌晃自己。
   * timer 是那一轮一轮自己问出去的 find——这一层不在的时候必须停掉，别隔着两层朝这块网打包。
   */
  private list: { veil: HTMLElement; rows: HTMLElement; note: HTMLElement } | null = null;
  private findTimer = 0;
  /** 寻呼还没发出去（那一刻线还没连上）时挂起的那一趟：握手一成由 onReady 补发 */
  private awaitFind = false;
  /** 这一屏拿到过一份清单了没：拿到之后就不在每轮寻呼时摆「正在寻」，省得那行字每五秒闪一下 */
  private listed = false;
  /**
   * 这一趟进候场厅是谁开的口：'create'＝在这台机器开一桌（该自动落到房主位），
   * 'invite'＝拿着地址或扫码进来（递 -1 由桌挑一把空椅：房主位空着时桌给的就是它，有人拿着才往后挑）。
   * 第一份座位表到手就用掉、跟着清空——替人挑椅子这件事只发生一次。
   */
  private autoSit: 'create' | 'invite' | null = null;
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
    if (initialScreen(location.search) === 'room') this.openRoom('invite');
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
   * 全屏首页：四个入口各占一条大热区（两个玩法 + 关于 + 设置），选完才进各自那一屏。
   * 它是盖在屏幕上的一层，不是排在牌桌下面——单机打完一局退回来时身后还立着那副牌面。
   * 版面住在 home.ts（那儿进得了 node 测试），这儿只管往 root 上摘挂。
   */
  private showHome(): void {
    this.closeRoom();
    this.stopList();
    for (const el of this.root.querySelectorAll('.sheet, .home')) el.remove();
    this.root.append(
      homePanel(
        () => this.pickTable(),
        () => this.showList(),
        // 外壳里那块上第二行字不一样：那一头寻不了同网的桌、也没法在自己这台开一桌
        inAppShell(),
        () => this.showAbout(),
        () => this.showSettings(),
      ),
    );
  }

  /**
   * 关于 · 玩法与版本：规则速览（文案住在 aboutText.ts，跟引擎现状同源）＋版本许可。
   * 声音开关挪去设置那一屏（2026-10-09）：关于只讲「这是什么、哪一版」，可调的都归设置。
   * 首页那一块开的是整屏页——跟「一屏一层」同一条链路，出口照旧念「返回」回首页。
   */
  private showAbout(): void {
    for (const el of this.root.querySelectorAll('.sheet')) el.remove();
    const { body, foot } = page(this.root, '关于 · 棋墩墩', 'about');
    for (const sec of ABOUT_RULES) {
      body.append(div('about-h', sec.h));
      for (const line of sec.p) body.append(div('note', line));
    }
    body.append(div('about-h', '版本'), div('note', aboutMeta(appVersion())));
    const out = div('sheet-row');
    out.append(button(BACK, () => this.showHome(), 'btn mini'));
    foot.append(out);
  }

  /**
   * 设置：目前只有声音开关，但它是「这桌上有哪些可调」那一类东西的家——以后加字号、
   * 加提示强度都往这儿添，别再往关于那一页塞（关于讲的是「是什么」，设置讲的是「怎么调」）。
   * 跟关于同一份链路：整屏页、出口念「返回」回首页。
   */
  private showSettings(): void {
    for (const el of this.root.querySelectorAll('.sheet')) el.remove();
    const { body, foot } = page(this.root, entryHead('settings'), 'about');
    body.append(
      div('about-h', '声音'),
      segment(
        '声音',
        [
          { text: '开', value: true },
          { text: '关', value: false },
        ],
        this.sound.enabled,
        // Sound 只有一颗 toggle：翻到目标态才按，已经是目标态就不动（也别让它白响一声）
        (on) => {
          if (on !== this.sound.enabled) this.sound.toggle();
        },
      ),
    );
    const out = div('sheet-row');
    out.append(button(BACK, () => this.showHome(), 'btn mini'));
    foot.append(out);
  }

  // ---------- 同网桌列表 ----------

  /**
   * 点首页那块「本地联机」落在这一屏：同网有没有桌在等人一眼看得见，不用先在自己这台开一张。
   * 浏览器发不了 UDP，寻一圈仍由本机那个宿主代跑（一句 find 递出去）；
   * 它那儿有 SWEEP_MIN_MS 那道闸，所以这一屏五秒一轮不会把这块网刷爆。
   * 底栏那两颗归 foot 钉住：手机上列表长过一屏，「开一桌」跟着滚就等于要人先滚到底再摸黑点。
   * App 外壳里这一屏换成手填桌地址（showAddr）：那一头既没有本机宿主可让它的 UDP，也没有一张桌可开。
   */
  private showList(): void {
    if (inAppShell()) {
      this.showAddr();
      return;
    }
    this.closeRoom();
    if (this.list) {
      this.findNow();
      return;
    }
    for (const el of this.root.querySelectorAll('.sheet')) el.remove();
    this.link ??= new Link({
      onMsg: (m) => this.onPush(m),
      onStatus: (text) => this.onNet(text),
      onReady: () => this.onReady(),
    });
    // 标题就是首页那块的名字：同一件事在两处换了写法，人就该怀疑这是两个地方
    const { veil, body, foot } = page(this.root, entryHead('room'));
    const rows = div('peer-list');
    const note = div('note', SEARCHING);
    body.append(rows, note);
    this.list = { veil, rows, note };
    this.listed = false;
    const out = div('sheet-row');
    out.append(
      button('在这台机器开一桌', () => this.openRoom('create'), 'btn primary'),
      button(
        BACK,
        () => {
          this.stopList();
          this.link?.close();
          this.link = null;
          this.showHome();
        },
        'btn mini',
      ),
    );
    foot.append(out);
    this.findNow();
    this.findTimer = window.setInterval(() => this.findNow(), LIST_REFRESH_MS);
  }

  /**
   * 寻一轮。发不出去（那一刻线还没连上）就把这一趟挂起来，等握手一成由 onReady 补发。
   * 原来这儿是「发不出去就写一句『这条线还没连上』」，可第一轮**几乎总是**赶在握手之前：
   * 人一进这一屏先看见一句吓人的断线提示，紧接着那句又被 onNet 擦成空白，
   * 下一轮要等 LIST_REFRESH_MS 五秒才来，头六秒屏上什么都没有（2026-10-09 用户：「像有 bug」）。
   */
  private findNow(): void {
    if (!this.list) return;
    // 已经有清单了就不摆「正在寻」：每五秒把结果换成它再换回来，是拿那行字在那儿闪
    if (!this.listed) this.list.note.textContent = SEARCHING;
    const link = this.link;
    if (!link?.online) {
      this.awaitFind = true;
      return;
    }
    this.awaitFind = false;
    link.send({ t: 'find' });
  }

  /** 这一页收掉：那一轮一轮的 find 得跟着停，人都不在这儿了还朝这块网打包没道理 */
  private stopList(): void {
    if (!this.list) return;
    window.clearInterval(this.findTimer);
    this.findTimer = 0;
    this.list.veil.remove();
    this.list = null;
  }

  /**
   * App 外壳里那一屏「本地联机」：版面归 home.ts 的 fillAddr（判断在那儿才有闸），这儿只管挂上、连、走。
   * 连之前先把上一张桌那条线拆了：地址换了就是另一张桌，旧线留着只会让人对着「正在重连」等一张已经不在了的桌。
   * 进来落 'invite' 那一档（照扫码那条路走：递 -1 让桌挑一把空椅）——外壳里开不了桌，房主永远是另一台机器。
   */
  private showAddr(): void {
    this.closeRoom();
    this.stopList();
    for (const el of this.root.querySelectorAll('.sheet')) el.remove();
    const { body, foot } = page(this.root, entryHead('room'));
    fillAddr(
      body,
      foot,
      tableAddr(),
      (addr) => {
        setTableAddr(addr);
        this.link?.close();
        this.link = null;
        this.openRoom('invite');
      },
      () => this.showHome(),
    );
  }

  /** 寻回来的桌：整行是热区，点哪儿都进桌。列表页整块重画（这一层一秒不刷）；一条都没有就摆空状态那一格 */
  private paintList(list: FoundRoom[], why: string): void {
    const page = this.list;
    if (!page) return;
    this.listed = true; // 有结果了：后面每一轮寻呼就不再摆「正在寻」，只等结果回来换字
    page.rows.innerHTML = '';
    if (list.length) {
      for (const f of list) page.rows.append(roomRow(f));
      page.note.textContent = peerNote(list, why);
    } else {
      // 空的时候那句说明不飘在页脚了——它本来就是空状态的第二行字，跟着那一格摆（口径还是 peerNote 现给，不另养一份）
      page.rows.append(peerEmpty(peerNote([], why)));
      page.note.textContent = '';
    }
  }

  // ---------- 开桌 ----------

  /**
   * 首页那块「单机模式」点进来的一屏：三排选项，开桌那颗钉在底栏。
   * 身后就是首页，那颗「返回」摘掉这一页就回去——不是一张「不摆一桌就出不去」的卡。
   * 这一屏不摆种子：种子是打出来的那局的事，开桌前它只是一个谁都摇得出的随机数，
   * 真要看它、报它，状态栏那一行、战报抬头、报错那句里都带着。
   */
  private pickTable(): void {
    this.closeRoom();
    for (const el of this.root.querySelectorAll('.sheet')) el.remove();
    // 上局的三个格子从本地存档里来（qdd.solo），没存过就用引擎默认；seed 每次现摇
    const last = recallSolo();
    const chosen: Setup = {
      players: last?.players ?? this.setup.players,
      mode: last?.mode ?? this.setup.mode,
      level: last?.level ?? this.setup.level,
      seed: rollSeed(),
    };
    const { veil, body, foot } = page(this.root, entryHead('solo'));
    // 上局配置只做「预填」：底下那三排就是上局摆的那三格，进来一眼看见、想改就点。
    // 说一句让人知道它是从哪儿来的——一句小字，不占一颗按钮
    if (last) body.append(div('note', '已按上局配置填好'));
    body.append(
      segment(
        '坐几个人',
        rules.playerCounts.map((n) => ({ text: seatOption(rules, n), value: n })),
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
        LEVELS.map((l) => ({ text: `${l === 'easy' ? '默认 · ' : ''}${LEVEL_CN[l]}`, value: l })),
        chosen.level,
        (v) => (chosen.level = v),
      ),
    );
    const go = div('sheet-row');
    const launch = (): void => {
      veil.remove();
      this.setup = chosen;
      // 开桌即写：下一次进这张卡，三排格子就是这一把的
      rememberSolo({ players: chosen.players, mode: chosen.mode, level: chosen.level });
      void this.match(chosen);
    };
    // 只有一颗「开桌」：不给「按上局配置开局」那种一键绕过这张卡的重按钮——
    // 人还没看清上局摆的是什么就进去了，按钮本身也压过底下那三排真正的选择
    //（2026-10-09 用户点名：按钮太重、别直接开局；上局配置预填就够）。
    go.append(
      button('开桌', launch, 'btn primary'),
      button(BACK, () => this.showHome(), 'btn mini'),
    );
    // 主按钮进 foot：这一屏三排选项早超出一屏，开桌那颗跟着滚就等于要人先滚到底再摸黑点
    foot.append(go);
  }

  // ---------- 候场厅 ----------

  /**
   * 常驻的候场厅：这桌的配置、每把椅子的下落、邀请二维码、房主那颗开始，全在这一块里。
   * 座位表一秒问一遍（谁进谁出都得看得见），所以架子只搭一次、来一份填一份，
   * 别整张重刷——重刷会把人正点下去的那一下吞掉。
   * 开局以后这块不消失：没坐上人的设备站在这儿当旁观席，随时挑一把椅子等下一局。
   * `auto` 说清这一趟是谁开的口，第一份座位表到手就照它替人挑一把椅子（口径见 home.ts 的 autoSeat）；
   * 让座以后再回这儿传 null——人刚自己站起来，别立刻把他塞回一把椅子。
   */
  private openRoom(auto: 'create' | 'invite' | null = null): void {
    this.autoSit = auto;
    this.stopList();
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
    const { veil, head, body, foot } = page(this.root, '正连着这桌……', 'room');
    // 「现在该干什么」置顶：这一屏每块都有自己的道理，没人替人说这句——按六种处境各给一句（home.ts 的 lobbyGuide）
    const guide = div('guide');
    const cfg = div('room-cfg');
    const rows = div('lobby-seats');
    const note = div('note');
    const cfgCol = div('cfg-col');
    const seatCol = div('seat-col');
    // 房主位换了人才亮一句，几秒后自己收掉：常驻一行「开局那颗在谁手上」是噪音，那本来就写在椅子行里
    const handed = div('note');
    handed.hidden = true;
    // 主 CTA 跟着决策区走（不在底栏跟轻操作挤一排）：候场厅这一屏，开局是唯一的大动作
    const cta = div('room-cta');
    cfgCol.append(cfg, note, cta);
    seatCol.append(rows, handed);
    body.append(guide, cfgCol, seatCol);
    const out = div('sheet-row');
    // 底栏这几颗一秒问一回，只改字、不拆了重搭：它们现在正对着拇指，重建会吞掉按到一半的那一下
    const start = button(
      '',
      () => {
        // 按下就本地置灰：座位表要等下一份快照（≤1s）才回来，这中间连点会重复递 start
        start.disabled = true;
        link.send({ t: 'start' });
      },
      'btn primary',
    );
    const leave = button(
      '',
      () => {
        // 这一颗只做一件事：离开这一桌，回到「本地联机」那一屏。椅子留给令牌，回来凭它还坐这一位。
        // 它不再兼任「看牌桌」——那一屏整屏盖着牌桌，掀开看见的其实是首页，那颗按钮撒了谎。
        // 只剩自己一个活人时先问一句再散桌（口径见 exitTable）；站着看桌的人不该有这一问
        this.exitTable(this.seated && alive <= 1);
      },
      'btn mini',
    );
    // 断线重连那几轮退避最磨人：这一颗不等下一轮，当场把这条线拆了重接
    const retry = button('刷新', () => link.retry(), 'btn mini');
    // 邀请折叠条：手机上二维码不该沉在座位行下面，也不该默认占一整屏——点开才见（拉人是开局前的次级动作）。
    // details/summary 语义化：键盘 Tab/Enter 天然可达，开合同步 aria-expanded 给读屏
    const inviteWrap = document.createElement('details');
    inviteWrap.className = 'invite-details';
    const inviteSum = document.createElement('summary');
    inviteSum.textContent = '邀请朋友 ▾';
    inviteSum.setAttribute('aria-expanded', 'false');
    inviteSum.addEventListener('toggle', () => inviteSum.setAttribute('aria-expanded', String(inviteWrap.open)));
    const invite = div('invite');
    inviteWrap.append(inviteSum, invite);
    // 清账重开：这本账活在桌那边，重启也接得回来，页面上没有第二个入口——候场厅补一颗，
    // 现在殿后于「邀请朋友／刷新／离开」之后：它是「把打过的都扔了」，不该长得像主按钮
    const clear = button(
      '清账重开…',
      () =>
        popup(
          this.root,
          '清账重开',
          (body, close) => {
            const p = div('note');
            p.textContent =
              `这桌已经打到第 ${gameNo} 局。清完账：局号回 1、跨局那本归零、牌面重摊，` +
              '椅子一把不动，谁都还得再按一次开始。';
            const row = div('sheet-row');
            row.append(
              button('确认清账', () => {
                close();
                link.send({ t: 'reset' });
              }),
              button('接着留着', () => close()),
            );
            body.append(p, row);
          },
          // 这是要把打过的都扔了：点空白处就关掉，误触一下代价太大
          true,
        ),
      'btn mini',
    );
    seatCol.append(inviteWrap);
    out.append(leave, retry, clear);
    foot.append(out);
    let seatsFor = -1;
    let cfgKey = '';
    let inviteKey: string | null = null;
    // 那句「已经打到第几局」得照最新的账念，所以确认框里念的是最后一次快照里的那个号
    let gameNo = 1;
    // 这桌此刻几个活人连着（一秒一份座位表带着走）：退出那颗要不要先问一句，就看这个数
    let alive = 0;
    // 上一份座位表里房主位在哪把：-1 是第一份；该不该开口由 hostJump 判（那条判断住在 home.ts，才有闸）
    let lastHost = -1;
    let handDue = 0;

    const fill = (l: Seats) => {
      this.status = l.status;
      this.hostSeat = l.hostSeat;
      const waiting = l.status === 'waiting';
      const mine = recall();
      const iSeat = l.seats.find((s) => s.seat === this.me);
      const isHost = this.seated && this.me === l.hostSeat;
      const sitting = l.seats.filter((s) => s.online && !s.queued).length;
      const short = l.players - sitting;
      // 桌名摆在标题里：同网列表里点错一条、进了别人的桌，一眼看得出来（那是 2026-10-09 用户踩的那条路）
      const called = l.name ? ` · ${l.name}` : '';
      head.textContent = waiting ? `候场厅${called} · 第 ${l.gameNo} 局还没开` : `牌桌正在打${called} · 第 ${l.gameNo} 局`;
      gameNo = l.gameNo;
      alive = aliveSeats(l.seats);

      // 房主位一跳就得说一声：这一层不演牌桌日志，不说就只有「房主位」那三个字在行之间跳
      if (hostJump(lastHost, l.hostSeat)) {
        handed.textContent = hostHanded(lastHost, l.hostSeat, l.seats);
        handed.hidden = false;
        window.clearTimeout(handDue);
        handDue = window.setTimeout(() => (handed.hidden = true), 6000);
      }
      lastHost = l.hostSeat;

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
        // 一行三处字（谁／状态／按钮）整段状态机住在 home.ts，这儿只把结果写进 DOM
        const txt = seatRowText(s, {
          waiting,
          seated: this.seated,
          me: this.me,
          hostSeat: l.hostSeat,
          savedSeat: mine?.seat ?? null,
        });
        row.querySelector('.who')!.textContent = txt.who;
        row.querySelector('.t')!.textContent = txt.tag;
        const btn = row.querySelector('button')!;
        btn.hidden = txt.hidden;
        btn.textContent = txt.btn;
        btn.disabled = txt.disabled;
        btn.classList.toggle('primary', txt.primary);
      });

      const urls = inviteUrls(l.lan, location);
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

      // 「现在该干什么」：六种处境一句，状态机住 home.ts（纯函数有闸）；note 只管坐下那一下的反馈
      guide.textContent = lobbyGuide({
        waiting,
        seated: this.seated,
        isHost,
        queued: iSeat?.queued ?? false,
        short,
        hostSeatName: seatName(l.hostSeat),
        hostTaken: l.seats[l.hostSeat]?.taken ?? false,
      });

      // 开始这一局贴在决策区正下（cfgCol 之内）：只剩房主候场时可见，开打中那格换成局况不显示死按钮
      const showCta = waiting && isHost;
      if (showCta) {
        cta.replaceChildren(start);
        start.hidden = false;
      } else {
        cta.replaceChildren();
        start.hidden = true;
      }
      start.disabled = false; // 座位表一回来就解掉按下那一下的置灰（置灰只为挡住 ≤1s 里那几下连点）
      // 第 1 局还没开，这本账本来就是空的：这时候给一颗「清账重开」只是多一颗按了没用的
      clear.hidden = !(waiting && isHost && l.gameNo > 1);
      start.textContent = short > 0 ? `开始这一局（${short} 个位子由电脑补）` : '开始这一局';
      // 每一屏那颗出口都念同一份「返回」（口径见 home.ts 的 BACK）：候场厅这一颗回的是本地联机那一屏
      leave.textContent = BACK;

      // 进门这一趟替人挑一把椅子，只在头一份座位表上发生一次（口径见 home.ts 的 autoSeat）。
      // 已经坐着就不再挑：断线重连那条路自己会凭令牌认回原来那把，插进来只会把人挪错位子
      if (this.autoSit) {
        const creating = this.autoSit === 'create';
        this.autoSit = null;
        if (!this.seated) {
          const seat = autoSeat(l, recall(), creating);
          if (seat !== null) this.takeSeat(seat);
        }
      }
    };
    this.room = { veil, note, fill };
    link.askLobby();
    // 谁进谁出得看得见：站在这儿就一秒问一遍
    this.poll = window.setInterval(() => link.askLobby(), 1000);
  }

  /** 收掉候场厅那一屏：桌已开局那份接管画面，或者是人按了「返回」换到本地联机那一屏 */
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
    this.breakTableLoop(); // 万一那条循环还挂着，让它散（连还吊着的 pull/ask 一起收场）
    this.seated = false;
    this.myToken = '';
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
      // 站在列表页上：那一轮寻呼多半赶在握手之前，连上了当场补发，别让人对着空白干等五秒
      if (this.list && this.awaitFind) this.findNow();
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
    // 「刚连回来」＝这一句是空的、而上一句不是：得给个正面反馈，别只报断不报回
    const back = !text && this.netNote !== '';
    this.netNote = text;
    if (this.shell) this.paintMeta();
    // 候场厅摊着时那块就是唯一的落脚处：那会儿连台面都还没搭，toast 没地方放。
    // 连回来（text 空）也要擦：不擦那句「和桌断了」会赖在那儿，人以为还断着
    if (this.room && (text || back)) this.room.note.textContent = text;
    // 站在列表页上同理：断线那句得写在列表底下，不然人只看见一屏不动的桌。
    // 连回来（text 空）时**不写空串**——这一屏的 note 是「正在寻」，擦成空白正是那句提示消失的原因；
    // 改成当场再寻一轮，让那行字自己回来。
    if (this.list) {
      if (text) this.list.note.textContent = text;
      else if (back) this.findNow();
    }
    if (text && this.shell) toast(this.shell.toast, text, 2000);
    else if (back && this.shell) toast(this.shell.toast, '连上了', 1200);
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
      case 'rooms':
        // 答话只落在列表页那一层：候场厅里不摆同网桌，人已经在这张桌上，就别再拿别人的桌晃他
        this.paintList(m.rooms, m.why);
        return;
      case 'reject': {
        const why = m.why;
        // 这一句是冲着椅子来的：断线那会儿位子被人坐了、或者这桌减了人。
        // 那条循环还卡在等入座后的第一份快照，等不到就会死在这儿——站起来回候场厅重挑一把
        if (this.reseat) {
          this.reseat = false;
          this.standLocal(why);
          return;
        }
        if (this.room) {
          this.room.note.textContent = why;
        } else if (this.list) {
          // 站在列表页上寻的那一句被拒（对着老宿主按的）：话写在清单底下，别让它咽进沉默
          this.list.note.textContent = why;
        } else if (this.shell) toast(this.shell.toast, why, 1600);
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

  /**
   * 把牌桌那条循环请下场：gen 一老，它下一次回头就该散；还吊着的 pull/ask 也得给个收场，
   * 不然下一局推来的快照会命中 parked 的 pull、把牌面画到别处去（回候场厅那颗就栽在这儿）。
   * 回候场厅、离桌、换桌、让座——四处散的是同一件事，口径收在这一处。
   */
  private breakTableLoop(): void {
    this.gen++;
    const pull = this.pull;
    this.pull = null;
    pull?.(null);
    const ask = this.ask;
    this.ask = null;
    ask?.(null);
    const again = this.againRes;
    this.againRes = null;
    again?.(false);
    this.queue.length = 0;
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

  /** 结算卡标题：夺冠／并列／无人收牌三分支，单机联机念的是同一份 */
  private resultTitle(no: number): string {
    const top = winners(this.state);
    if (top.length === 1) return `第 ${no} 局｜${this.who(top[0]!)} 夺冠`;
    if (top.length > 1) return `第 ${no} 局｜${top.map((s) => this.who(s)).join('、')} 并列`;
    return `第 ${no} 局｜谁都没收到牌`;
  }

  /**
   * 结算卡的公共骨架：标题、名次、跨局总账、复制战报一条路，单机联机两张卡只差
   * 中间那句话和那排按钮。原来两处各写一遍，文案改一处漏一处就是这个口子。
   * 复制战报统一钉在按钮排末尾（单机那份原来没带 mini，跟着联机那份收口）。
   */
  private resultCard(
    title: string,
    drawer: number,
    note: string,
    paint: (row: HTMLElement, close: () => void) => void,
    onOpen?: (close: () => void) => void,
  ): void {
    popup(
      this.root,
      title,
      (body, close, foot) => {
        onOpen?.(close);
        this.rankRows(body, drawer);
        const line = div('note');
        line.textContent = note;
        body.append(line);
        const row = div('sheet-row');
        paint(row, close);
        row.append(button('复制战报', () => void this.copyReport(body, title), 'btn mini'));
        // 这一样是被名次撑长的一屏：主按钮那排不能跟着滚走
        foot.append(row);
        this.bookRows(body);
      },
      true,
    );
  }

  /** 结算卡：联机不拦循环，房主按了下一局自己会推来新的一帧 */
  private showResult(): void {
    const host = this.me === this.hostSeat;
    const next = nextDrawer(this.state);
    this.sound.cue('win');
    this.resultClose?.();
    this.resultCard(
      this.resultTitle(this.gameNo),
      next,
      host
        ? `你是房主 ${seatName(this.me)}，下一局在候场厅里由你按开始。`
        : `等 ${this.who(this.hostSeat)} 开下一局；想挑椅子、看谁坐哪儿，去候场厅。`,
      (row, close) => {
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
              // 牌桌那条循环得先散伙：不散的话新一局推来的快照会命中还吊着的 pull、画到候场厅底下，人就卡在候场厅进不去
              this.breakTableLoop();
              this.openRoom();
            },
            'btn mini',
          ),
        );
      },
      (close) => {
        this.resultClose = () => {
          this.resultClose = null;
          close();
        };
      },
    );
  }

  /**
   * 离桌：连接断掉，椅子还留给这个令牌，回来凭它还坐这一位。
   * 落点默认首页（牌桌右上角那张「离桌」走这条，那句提示就是这么念的）；
   * 候场厅那颗「返回」要直接落在同网桌列表——按这颗的人要的正是「换张桌看看」，别再让他绕一次首页。
   */
  private leaveTable(toList = false): void {
    this.resultClose?.();
    this.breakTableLoop(); // 占着的那条循环散伙，sitGen 一老，候场厅里再坐下才起得来
    this.link?.close();
    this.link = null;
    this.seated = false;
    this.seats = null;
    this.liveActs = [];
    this.netNote = '';
    if (toList) this.showList();
    else this.showHome();
  }

  /**
   * 候场厅那颗「返回」。桌上还有别的活人连着就悄悄退（椅子留给令牌，回来还坐这一位）；
   * 只剩自己一个时才先问一句——这一退就把这桌散了：椅子连令牌一起收，存档也抹掉，重启宿主接不回来。
   * 「只剩自己一个」由座位表数出来（`aliveSeats`，同一句判断在桌那头还有一道），页面上这句只是给人看的。
   * 问一句用的还是那张弹窗卡：整屏页只给「一直待在那一层」的界面，一次性的是非题不在这儿。
   */
  private exitTable(alone: boolean): void {
    if (!alone) return this.leaveTable(true);
    popup(
      this.root,
      '返回会散掉这桌',
      (body, close) => {
        const p = div('note');
        p.textContent =
          '这桌只剩你一个活人。退出去这桌就散了：椅子、令牌、局号和跨局那本账全清空，存档也抹掉——重启这台机器上的桌也接不回来。';
        const row = div('sheet-row');
        row.append(
          button('确认散桌', () => {
            close();
            // 先把这一句递出去再拆线：同一只 socket 上帧是排队走的，桌那头先收到 disband、再收到关闭
            this.link?.send({ t: 'disband' });
            this.leaveTable(true);
          }),
          button('再坐会儿', () => close()),
        );
        body.append(p, row);
      },
      // 这是要把整桌收掉：点空白处就关掉，误触一下代价太大
      true,
    );
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
      // 收杆落回开桌卡（D3-b）：上局配置就在眼前，一拍再来一局；崩了就留着牌面，好截图看
      if (gen === this.gen && !crashed) this.pickTable();
    }
  }

  /** 搭台面：一次搭好壳子、牌摞和事件。单机用整副牌，联机先按快照里的牌面（没公开的还没字） */
  private stage(players: number, deck: Piece[]): void {
    this.shell = buildShell(
      this.root,
      players,
      Math.max(...rules.playerCounts),
      maxStacks(rules),
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
    // 系列战绩平时只在结算卡上露脸，打完一局就看不到了——顶栏也念一份，跟结算卡、复盘原文同一句。
    // 一局都没打完（games 0）时整条藏掉：宁可少一行，也不念一句「累计 0 局」
    this.shell.stand.hidden = this.book.games === 0;
    this.shell.stand.textContent = this.book.games === 0 ? '' : bookLine(this.book, (s) => this.who(s));
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
    // 跟顶栏那行、复盘原文同一份（bookLine）——三处各抄一遍，改个口径就会漂成三种说法
    total.textContent = bookLine(this.book, (s) => this.who(s));
    body.append(total);
  }

  private newGame(): void {
    this.state = newGameState(rules, this.setup, this.gameNo, this.drawer);
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
      await this.act(seat, aiActionFor(this.state, seat, this.setup.level, this.rng));
    }
  }

  // ---------- 一步棋 ----------

  /** 单机这一手：自己落子再演拍子。联机那份快照已经落好了，直接走 frame */
  private async act(seat: number, action: Action): Promise<void> {
    const wonBefore = [...this.state.won];
    const onTable = this.view.freeze;
    const logBefore = this.state.log.length;
    this.maskFrom = stepAndMask(this.state, seat, action, logBefore, this.maskFrom);
    await this.frame(seat, action, wonBefore, onTable);
  }

  /** 一手的拍子：状态得是落好这一手以后的，两边共用这一套动画 */
  private async frame(seat: number, action: Action, wonBefore: number[], onTable: OnTable[] | null): Promise<void> {
    this.busy = true;
    try {
      this.view.sel.clear();
      this.view.spread = false;
      // 一墩打完引擎就把 trick 清了，最后这一手得自己补进桌面快照，不然它飞不进牌摞
      const table = this.state.trick ? this.snapshot() : closedTable(this.state, seat, action, onTable, wonBefore);
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
      ...trick.plays.map((p) => ({ seat: p.seat, ids: [...p.pieceIds], pledge: false, best: p === champ })),
      ...trick.discards.map((d) => ({ seat: d.seat, ids: [...d.pieceIds], pledge: true, best: false })),
    ];
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
    // 收牌扣着收：先在桌面上翻回背面、落定这一拍，再整墩收进牌摞。
    // 明棋不翻——那边出牌即亮，收进摞本来就该亮着，没有「扣」这一回事
    if (this.state.mode === 'kou') {
      this.view.holdDown = new Set(ids);
      this.render(true);
      await this.nap(FLIP_COVER_MS);
    }
    if (winner >= 0) {
      this.sound.cue('collect');
      this.view.piles[winner]!.push(...ids);
    }
    this.view.freeze = null;
    this.view.holdDown = new Set();
    this.view.peek = new Set();
    this.view.justWon = new Set(ids);
    this.render(true);
    await this.nap(MOVE_MS + 320);
    this.view.justWon = new Set();
    this.render(false);
  }

  private async askAgain(): Promise<boolean> {
    this.drawer = settleMatch(this.book, this.state);
    const top = winners(this.state);
    this.sound.cue('win');
    return new Promise((res) => {
      // 把 resolve 存进实例：结算卡开着时从右上角「换桌」走，showAbout 只摘 DOM、碰不到这两颗按钮，
      // 不留这一手那条 match 循环就永远停在 await this.askAgain()（breakTableLoop 会替它收场）
      const done = (v: boolean): void => {
        this.againRes = null;
        res(v);
      };
      this.againRes = done;
      this.resultCard(
        this.resultTitle(this.gameNo),
        this.drawer,
        top.length === 1
          ? `下一局由 ${this.who(this.drawer)} 起抽`
          : `这局并列，下一局仍由 ${this.who(this.drawer)} 起抽`,
        (row, close) => {
          row.append(
            button('再来一局', () => {
              close();
              done(true);
            }, 'btn primary'),
            button('收杆', () => {
              close();
              done(false);
            }),
          );
        },
      );
    });
  }

  /** 剪贴板不给用（非 https、或者浏览器直接拒）就把原文摊在卡里，选中照样能抄 */
  private async copyReport(host: HTMLElement, title: string): Promise<void> {
    const text = reportText(this.state, this.book, this.me, title);
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

  /**
   * 右上角那张：单机联机都退回首页。正在等的两件事都得散伙——一是人要点牌，二是循环在等下一份快照。
   * 这一颗**故意**不念「返回」：三处「返回」散的是「换一层看」，这颗散的是「这一局我不打了」，
   * 两件事共用一个词，人就分不清哪一颗会把这一局丢掉（「三处出口」那条断言也正是把它挡在 3 处之外）。
   */
  private resign(): void {
    const online = this.link !== null;
    const go = () => {
      this.breakTableLoop();
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
        ? '这一局还没打完，离桌就不记账了。椅子给你留着，从首页再点「本地联机」还坐这一位。'
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
    this.shell.board.addEventListener('click', (ev) => this.tapFrom(ev.target));
    // 键盘那条路：牌是能聚焦的（tabindex 在 pieces.ts），Enter／空格走与鼠标同一段「点牌」逻辑。
    // 焦点不在牌上就不接——按钮条那几颗就在桌面里，它们有自己的原生 Enter 语义
    this.shell.board.addEventListener('keydown', (ev) => {
      if (ev.repeat) return;
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const piece = ev.target instanceof Element ? ev.target.closest<HTMLElement>('.piece') : null;
      if (!piece) return;
      ev.preventDefault();
      this.tapFrom(ev.target);
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

  /** 点牌／键盘按牌共用的那一段：点空白处＝收回，点到牌就走 tapPiece */
  private tapFrom(target: EventTarget | null): void {
    // 真手势里把 AudioContext 建起来：等动画帧里第一声才建，多半已经被自动播放策略按住、白哑一场
    this.sound.warmup();
    const piece = target instanceof Element ? target.closest<HTMLElement>('.piece') : null;
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
  }

  private hoverAt(ev: PointerEvent): void {
    if (this.state.phase !== 'draft') return;
    // 用缓存的 boardRect，不现量 DOM：现量会把「上一步改 transform → 这一步读布局」串成每帧一次强制重排
    const x = ev.clientX - this.boardRect.left;
    const y = ev.clientY - this.boardRect.top;
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
          layered: '一人一层拿牌',
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
    // 一张牌多大是从「摆摞那一排放得下几张」反推的，所以这个形得跟着这一档的落定规则走（3 人局 10 摞 × 3 张）
    return { w: el.clientWidth || 1, h: el.clientHeight || 1, ...draftShape(this.state) };
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
          state.trick.plays.some((p) => p.seat === seat) || state.trick.discards.some((d) => d.seat === seat);
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
      // 壳子里搭的是最坏那一排（10 块）：这一档只有 8 摞时多出来的三块别拿 undefined 的领地往桌面上摆
      if (i >= spots.length) {
        el.hidden = true;
        return;
      }
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
          draft.decider === this.me ? `：这 ${draft.stacks.length} 摞怎么分你定` : `：${this.who(draft.decider)} 定怎么分`,
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

  /** 桌面在视口里的位置：只随尺寸变化重算（ResizeObserver）。pointermove 里现量 DOM 会把「改 transform → 强制重排」串成每帧一次 */
  private measureBoard(): void {
    const r = this.shell.board.getBoundingClientRect();
    this.boardRect = { left: r.left, top: r.top };
  }

  private watchResize(): void {
    this.rober?.disconnect();
    this.measureBoard();
    this.rober = new ResizeObserver(() => {
      this.measureBoard();
      this.render(false);
    });
    this.rober.observe(this.shell.board);
  }

  private async nap(ms: number): Promise<void> {
    const gen = this.gen;
    await new Promise<void>((r) => setTimeout(r, this.noMotion ? Math.min(ms, 60) : ms));
    if (gen !== this.gen) throw new Aborted();
  }
}
