/**
 * neg-chess2 那批（批「座位回收」）的三把刀，搬自会话老脚本 `run-knives-neg2.mjs`（刀1／2／3）＋`knife-b.cjs`。
 * 三把都拆 `src/node/table.ts`，都跑 `test:net`。刀口 2026-09-29 逐个核过：现源码里各出现 1 次，且没有别的谱子碰过这几行。
 * `expect` 是 2026-09-29 从 `--verbose` 的实际红字里抄的（红 1／1／6 条，各钉自己那句；最后一把那 6 条是级联，钉头一条）。
 * 原来还有一把 B「settleHost 去掉『凭令牌回来就交回』这一支」——那条规则 2026-09-29 批11 已经作废
 * （房主位不再自动收回，见 `host-no-steal.mjs`），刀口跟着删；钉新口径的那几把记在 host-no-steal 那本。
 */
export default {
  id: 'seat-recycle',
  title: '坐下走开收椅子：空代号不抹掉旧的、房主位开打中不乱跑、候场期换人才整把洗掉',
  via: 'test',
  suite: 'test:net',
  knives: [
    {
      rel: 'src/node/table.ts',
      note: 'A 空代号也照写（抹掉原来那个）',
      from: `    if (said) slot.nick = said;`,
      to: `    slot.nick = said;`,
      expect: '没带代号的那一句不抹掉原来的',
    },
    {
      rel: 'src/node/table.ts',
      note: 'C 开打中也让房主位乱跑',
      from: `    if (this.status !== 'waiting') return null;`,
      to: `    if (false) return null;`,
      expect: '房主位没被抢：那位还坐在这桌',
    },
    {
      rel: 'src/node/table.ts',
      note: 'D vacate 不分候场还是开打，一律只算掉线（旧椅子还挂在人名下）',
      from: `    if (this.status === 'playing') this.leave(seat);
    else {
      this.resetSlot(slot);
      this.push();
    }`,
      to: `    this.leave(seat);`,
      expect: '换到第 2 把，第 1 把就彻底空了',
    },
  ],
};
