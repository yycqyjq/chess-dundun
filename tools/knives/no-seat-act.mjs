/**
 * 批1（止血）第三把：`src/node/room.ts` 里「这条连接还没坐下」那道闸对 `act` 那条路的作用。
 * 老脚本 `run-knives.mjs` 里它是直接起一桌跑冒烟量的（test:net 走不到 room.ts 这条 switch），
 * 所以这张谱子 `via: 'smoke'`。刀口重抄过：#47 清账重开之后 room.ts 那段缩进浅了一级，老那一段在源码里已经没有了。
 * 2026-09-29 之前这把是 `crash: true`：拆了闸 dev 冒烟退出 1 却一句 ✗ 都没打出来——那位客户端在「等 reject」上超时，
 * `until` 直接抛（`tools/online-smoke.mjs:47`），后面全跑不到。现在改成让冒烟自己接住：那四处「桌得回一句」走
 * `tryUntil`（等不到回 null），闸一拆就记一条专属 ✗，于是这把有了钉得住的红字，`crash` 摘掉。
 */
export default {
  id: 'no-seat-act',
  title: '没坐下就递出牌那一句，桌不能把它咽成沉默（只有冒烟走得到 room.ts）',
  via: 'smoke',
  smoke: 'dev',
  knives: [
    {
      rel: 'src/node/room.ts',
      note: 'A 没坐下的连接递动作，桌又咽回沉默',
      from: `        if (seat === undefined) {
          conn.send(NO_SEAT);
          return;
        }
        const r = table.act(seat, msg.action);`,
      to: `        if (seat === undefined) return;
        const r = table.act(seat, msg.action);`,
      expect: '没坐下递动作：桌当场回一句「还没坐下」',
    },
  ],
};
