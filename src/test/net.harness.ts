/**
 * 联机层测试（拆分后）：共享夹具从 net.harness.ts 来。
 * 原 net.test.ts 一拆三：桌的生命周期 / 宿主与账 / 形闸·快照·WS 服务端。
 */
import { pendingSeats, type Action, type GameState } from '../core/game.ts';
import { loadRules } from '../node/load_rules.ts';
import { Table, TAKEOVER_MS, type TableSetup } from '../node/table.ts';
import { fullWire, hydrate, type ToClient, type WirePiece, type WireState } from '../net/wire.ts';
import { type TableView } from '../web/board.ts';

let failures = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const rules = loadRules();

/** 假时钟：30 秒代打这种事，等真 30 秒就没人跑测试了 */
class Clock {
  t = 1_000;
  now = () => this.t;
  step(ms: number): void {
    this.t += ms;
  }
}

type StatePush = Extract<ToClient, { t: 'state' }> & { seat: number };

/** 桌发出去的每一份快照都收在这儿，按座位分堆 */
interface Inbox {
  all: { seat: number; msg: ToClient }[];
  count(seat: number): number;
  last(seat: number): StatePush;
}

function makeTable(setup: Partial<TableSetup> = {}, clock = new Clock()): {
  table: Table;
  inbox: Inbox;
  clock: Clock;
  logs: string[];
} {
  const all: { seat: number; msg: ToClient }[] = [];
  const logs: string[] = [];
  const full: TableSetup = { rules, players: 2, mode: 'kou', level: 'hard', seed: 7, ...setup };
  const table = new Table(
    full,
    (seat, msg) => {
      all.push({ seat, msg });
    },
    (line) => logs.push(line),
    clock.now,
  );
  const inbox: Inbox = {
    all,
    count(seat) {
      return all.filter((o) => o.seat === seat && o.msg.t === 'state').length;
    },
    last(seat) {
      for (let i = all.length - 1; i >= 0; i--) {
        const o = all[i]!;
        if (o.seat === seat && o.msg.t === 'state') return { ...o.msg, seat } as StatePush;
      }
      throw new Error(`座位 ${seat} 还没收到过快照`);
    },
  };
  return { table, inbox, clock, logs };
}

/**
 * 坐下并且按过开始的那张桌：绝大多数用例要演的是牌局，不是候场厅。
 * 候场那道闸门自己单开一组测。
 */
function openedTable(setup: Partial<TableSetup> = {}, seats = [0, 1]): {
  table: Table;
  inbox: Inbox;
  clock: Clock;
  logs: string[];
} {
  const h = makeTable(setup);
  for (const s of seats) h.table.join(s, '');
  const r = h.table.start(setup.hostSeat ?? 0);
  if (!r.ok) throw new Error(`开局没成：${r.why}`);
  return h;
}

/** 快照里按 id 找那张牌；id 不连续也不至于查错 */
function pieceOf(view: WireState, id: number): WirePiece | undefined {
  return view.pieces.find((p) => p.id === id);
}

/**
 * 全公开快照转一圈回来炸不炸：下去那份 `rules` 是**按人数落定之后**的，
 * 还原时还要再进一次 parseRules（那道门是给手写 rules.json 设的）。
 * 3 人档的「一摞 3 张」要是连着整张配置表一起下去，那一趟会拿它去查 2 人档发不发得平，当场自己拒自己。
 */
function roundTripWhy(state: GameState): string {
  try {
    const back = hydrate(fullWire(state));
    if (back.players !== state.players) return `人数转一圈变成 ${back.players}`;
    if (back.rules.draft.stackSize !== state.rules.draft.stackSize) return `一摞张数转一圈变成 ${back.rules.draft.stackSize}`;
    return '';
  } catch (e) {
    return String((e as Error).message);
  }
}

/** 把摆牌阶段一路走完：抽签 → 分牌 */
function finishDraft(table: Table): void {
  const state = table.state;
  let guard = 0;
  while (state.phase === 'draft') {
    // 上限按最挤那一档给：3 人局 10 摞＝抽 10 次＋分 10 次正好 20 步，写死 20 就等于没留一格
    if (++guard > 40) throw new Error('摆牌阶段走不完');
    const who = pendingSeats(state)[0]!;
    table.act(who, table.legalFor(who)[0]!);
  }
}

/** 此刻这一手里出的那几张牌 */
function playedIds(action: Action): number[] {
  return 'pieceIds' in action ? [...action.pieceIds] : [];
}

/** 表现层自己攒的那份 view 的空壳，和 app.ts 的 freshView 同一个模子（TableView 少一个字都会编译不过） */
function blankView(players: number, mine: number): TableView {
  return {
    mine,
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

/** 照 app.ts 里 rebuildPiles 那个口径摊收牌摞：不在手里、不在桌上的那些，按 won 的数目分给各家 */
function pilesOf(state: GameState): number[][] {
  const loose = new Set(state.pieces.map((p) => p.id));
  for (const ids of [...state.hands, ...(state.draft?.stacks ?? [])]) for (const id of ids) loose.delete(id);
  const trick = state.trick;
  for (const ids of [...(trick?.plays ?? []), ...(trick?.discards ?? [])].map((p) => p.pieceIds))
    for (const id of ids) loose.delete(id);
  const pool = [...loose].sort((a, b) => a - b);
  let at = 0;
  return state.won.map((n) => pool.slice(at, (at += n)));
}

function playToEnd(table: Table, clock: Clock): GameState {
  const state = () => table.state;
  let guard = 0;
  while (state().phase !== 'over') {
    if (++guard > 600) throw new Error('整局打不完');
    const who = pendingSeats(state()).filter((s) => !table.seatInfo()[s]!.queued);
    if (who.length === 0) {
      // 排队那位和还没醒的电脑位都归桌自己动：推一时钟，让 tick 替他们落子
      clock.step(TAKEOVER_MS + 1);
      table.tick();
      continue;
    }
    const seat = who[0]!;
    table.act(seat, table.legalFor(seat)[0]!);
  }
  return state();
}

export {
  Clock,
  blankView,
  failures,
  finishDraft,
  makeTable,
  ok,
  openedTable,
  pieceOf,
  pilesOf,
  playToEnd,
  playedIds,
  roundTripWhy,
  rules,
};
export type { Inbox, StatePush };
