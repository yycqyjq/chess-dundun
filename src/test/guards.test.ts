#!/usr/bin/env node
/**
 * 桌层动作闸的定向钉子（2026-10-13 第三轮补）：这两条分支此前只有随机整局路过、无断言盯着——
 * 引擎 `legalActions` 空手只给 noop（game.ts），桌层 `act` 头一句「没这个座位」（table.ts）。
 * 随机种子碰不到的分支，回归就只能靠运气红；这儿直接构造局面钉死。
 * noop 在真局里几乎摸不着（每人手里总有牌；只有虚着规则开起来才轮得到），所以拿夹具手工摆：
 * 复用 makeTable 起真桌，开局后把 leader 的手清空、trick 拆掉，走的是和生产同一条 act 通路。
 */
import { pendingSeats } from '../core/game.ts';
import { makeTable } from './net.harness.ts';

let failures = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failures++;
  // 失败第一件事是知道挂在哪：栈帧 0 是 ok 自己，帧 1 才是调用处 —— 取「文件名：行：列」缀在名字后
  const at = new Error().stack?.split('\n')[2]?.trim().split(/[\\/]/).pop() ?? '';
  // 定位缀在整行末尾：名字和 detail 的前缀保持原样，别把按名字找钉子的刀谱匹配弄瞎
  console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}${at ? `（${at}）` : ''}`);
}

// ── 桌层 act 的头一道闸：没这个座位 ──
{
  const { table } = makeTable();
  table.join(0, '');
  table.join(1, '');
  table.start(0);
  // 挑几格摆成「轮到 0 号、0 号空手、1 号还有牌」之前，先把状态快照下来
  // （byId／revealed 是 Map／Set，JSON.stringify 会把它们拍成 {}、rng 那个函数更是直接丢——
  //   光比 JSON 串等于没看住这两本账，所以把 size 一并纳进来）
  const snap = (): string => {
    const s = table.state;
    return JSON.stringify([s.phase, s.leader, s.drawer, s.hands, s.won, s.draft, s.trick, s.opening, s.log.length, s.byId.size, s.revealed.size]);
  };
  const before = snap();
  // 闸要是被拆了，这一手会一路走到 `slot.queued` 上抛（slot 是 undefined）——包一层接住，
  // 让「抛了」也落成一条专属 ✗，而不是把整套带走（那样刀架那边就钉不住这句了，见 README 那条「别急着记 crash」）
  let r: { ok: boolean; why?: string };
  try {
    r = table.act(9, { kind: 'noop' });
  } catch (e) {
    r = { ok: true, why: `没接住（闸被拆了）：${(e as Error).message}` };
  }
  ok('桌层 act 头一道闸：不存在的座位递什么都不认（不抛、不动状态）', r.ok === false && r.why === '没这个座位', JSON.stringify(r));
  // 被闸挡下的这一手连 step 都没走到：桌的状态一个字没动（快照是 step 里推的，这儿自然也不推）
  ok('不认的这一手不落账：桌的状态一个字没动（含 byId／revealed 那两本账）', snap() === before, '状态被改动了');
}

// ── 引擎空手分支：legalActions 只给 noop，apply 把 leader 让给下一个还有牌的人 ──
{
  const { table } = makeTable();
  table.join(0, '');
  table.join(1, '');
  table.start(0);
  const state = table.state;
  // 先照桌的次序把摸签走完（0 号的 draw 被「不该你出」挡着，1 号独自摸完两人份），进了出牌阶段
  for (let guard = 0; guard < 50 && state.phase === 'draft'; guard++) {
    const seat = pendingSeats(state)[0];
    if (seat === undefined) break;
    const acts = table.legalFor(seat);
    if (acts.length === 0 || acts[0]!.kind !== 'draw') break;
    table.act(seat, acts[0]!);
    if (table.legalFor(seat)[0]?.kind === 'allocate') table.act(seat, table.legalFor(seat)[0]!);
  }
  // 摆成「轮到 0 号、0 号空手、1 号还有牌」：拆 trick、清 0 号的手
  state.trick = null;
  state.hands[0] = [];
  state.leader = 0;
  const legal = table.legalFor(0);
  ok('空手那一方的合法着法只有虚着一手', legal.length === 1 && legal[0]!.kind === 'noop', JSON.stringify(legal));
  const r = table.act(0, { kind: 'noop' });
  ok('虚着落账：leader 让给下一个还有牌的人', r.ok && state.leader === 1, `r=${JSON.stringify(r)} leader=${state.leader}`);
  ok('虚着不动任何人的手牌', state.hands[0].length === 0 && state.hands[1].length > 0, JSON.stringify(state.hands.map((h) => h.length)));
}

console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 项失败\n`);
if (failures) process.exitCode = 1;
