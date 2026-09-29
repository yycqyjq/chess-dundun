/**
 * 批1（止血）第三把：`src/node/room.ts` 里「这条连接还没坐下」那道闸对 `act` 那条路的作用。
 * 老脚本 `run-knives.mjs` 里它是直接起一桌跑冒烟量的（test:net 走不到 room.ts 这条 switch），
 * 所以这张谱子 `via: 'smoke'`。刀口重抄过：#47 清账重开之后 room.ts 那段缩进浅了一级，老那一段在源码里已经没有了。
 * 2026-09-29 实测：拆了这道闸，dev 冒烟退出码 1、**一句 ✗ 都没打出来**——
 * `tools/online-smoke.mjs:418` 那位客户端在「等 reject」上超时，`until` 直接抛（:47），后面全跑不到。
 * 所以按 `crash: true` 记：这把证的是「拆了这闸冒烟跑不下去」，不是某句断言守着。
 * 要让它有专属红字，得先教 `online-smoke.mjs` 自己接住那次超时（A1 那条老规矩），那是改冒烟工具的另一件事。
 */
export default {
  id: 'no-seat-act',
  title: '没坐下就递出牌那一句，桌不能把它咽成沉默（只有冒烟走得到 room.ts）',
  via: 'smoke',
  smoke: 'dev',
  knives: [
    {
      rel: 'src/node/room.ts',
      note: 'A 没坐下的连接递动作，桌又咽回沉默｜这把只认退出码：冒烟在「等 reject」那句上抛',
      from: `        if (seat === undefined) {
          conn.send(NO_SEAT);
          return;
        }
        const r = table.act(seat, msg.action);`,
      to: `        if (seat === undefined) return;
        const r = table.act(seat, msg.action);`,
      crash: true,
    },
  ],
};
