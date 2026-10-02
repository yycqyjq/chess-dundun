/**
 * 批2（椅子会过期）的刀谱，搬自会话老脚本 `run-knives-b2.mjs`（四把，刀口一字未改，2026-09-29 核对仍在源码里）。
 * 拆的都是候场期那把椅子的闲置回收：一律不动、少了 online 那道 guard、等待时长、局末重起算。全跑 `test:net`。
 * `expect` 是 2026-09-29 从 `--verbose` 的实际红字里抄的。
 * 第 2 把量出来是**绿**：`slot.online` 那道 guard 拆了没人看得见——`join` 里 `online = true` 和 `gone = 0` 是一起写的
 * （`src/node/table.ts:159-160`），在线的那位永远带着 `gone = 0` 走进这一行，`!slot.gone` 先把他挡在外面。
 * 那是**冗余保险**不是漏测，所以按 `belt` 那一档记：绿才算合格。
 */
export default {
  id: 'idle-seat-expiry',
  title: '候场那把椅子闲置够久才回收：开打前才扫、在线的不收、局末重新起算',
  via: 'test',
  suite: 'test:net',
  knives: [
    {
      rel: 'src/node/table.ts',
      note: 'A 候场期一律不动（回到旧 tick）',
      from: `    if (this.status !== 'playing') return this.sweepIdle();`,
      to: `    if (this.status !== 'playing') return;`,
      expect: '候场期掉线满两分钟：令牌、代号、连同一身的下标一起归零',
    },
    {
      rel: 'src/node/table.ts',
      note: 'B 少了 online 那道 guard（belt：join 把 online 和 gone=0 一起写，在线的那位根本走不到这一行）',
      from: `      if (!slot.token || slot.online || !slot.gone`,
      to: `      if (!slot.token || !slot.gone`,
      belt: true,
    },
    {
      rel: 'src/node/table.ts',
      note: 'C 等待时长改成 1 毫秒（人刚走椅子就没了）',
      from: `export const IDLE_MS = 120_000;`,
      to: `export const IDLE_MS = 1;`,
      expect: '桌真等的那段时长，和日志里念的「两分钟」是同一件事',
    },
    {
      rel: 'src/node/table.ts',
      note: 'D 局末不起算（那一局里掉线的人一打完就被收）',
      from: `      for (const slot of this.slots) if (slot.token && !slot.online) slot.gone = this.now();`,
      to: `      // 刀：不重起算`,
      expect: '那两分钟从局末这一刻起算，差一毫秒椅子还归他',
    },
  ],
};
