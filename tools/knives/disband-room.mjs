/**
 * 批10 散桌在 `src/node/room.ts` 那四步：这四步都只发生在「宿主」这一层，`test:net` 直接拿着一个 Table
 * 对象跑，碰不到硬盘也碰不到连接，所以这张谱子 `via: 'smoke'`（跑 dev 冒烟，量的那份存档是副本根上的
 * `table.json`，永远不是他自己仓库里那一份）。桌里那三道闸（只有房主／只有没开打／只有他一个活人）和
 * 归零那五样在 `disband-table.mjs`，两边不重叠。
 *
 * 冒烟那一段是 2026-09-29 才补的：补之前 `case 'disband'` 整段没有任何闸——拆掉 `discard()`、把「先解绑
 * 再关」的顺序倒了、或者整个不关线，全架一句红都没有，那三处当时属于「搬不进来」那一类。现在冒烟里
 * 散之前先排一次合批落盘（`setup` 递一个本来就是这个值的难度：桌什么都不改，room 照排那 300 毫秒），
 * 于是 `discard()` 里掐延时那半句也第一次量得到（E）。
 *
 * B／C／E 三把红在同一句上（「散完硬盘上那份存档真没了」），这是同一条闸的三种拆法：B 是压根没抹，
 * C 是抹了又被 onClose 那一下写回来，E 是抹了又被排队的合批写回来。看红字分不出是谁，看每一把各自的
 * `note` 分得出——每把只拆自己那一处，红的都只有这一条。
 */
export default {
  id: 'disband-room',
  title: '散桌那四步宿主动作：该答的答、该抹的抹、该解绑的先解绑、该关的关',
  via: 'smoke',
  smoke: 'dev',
  knives: [
    {
      rel: 'src/node/room.ts',
      note: 'A 没坐下的连接递散桌：那道闸不再回人话，这一句被咽成沉默',
      from: `        if (seat === undefined) {
          conn.send(NO_SEAT);
          return;
        }
        const r = table.disband(seat);`,
      to: `        if (seat === undefined) return;
        const r = table.disband(seat);`,
      expect: '还没坐下就按散桌：回一句人话，不是默默散成一张空桌',
    },
    {
      rel: 'src/node/room.ts',
      note: 'B 散桌只散内存、硬盘上那份存档留着——重启就接得回一桌「已经散了」的账',
      from: `        discard();
`,
      to: ``,
      expect: '散完硬盘上那份存档真没了（排队的合批也没把它写回来）',
    },
    {
      rel: 'src/node/room.ts',
      note: 'C 关线之前没解绑：onClose 替那位再走一遍 leave ＋落盘，把刚抹掉的空桌又写回硬盘',
      from: `        seatOf.delete(conn);
        if (connOf.get(seat) === conn) connOf.delete(seat);
        conn.close('这桌散了');`,
      to: `        conn.close('这桌散了');`,
      expect: '散完硬盘上那份存档真没了（排队的合批也没把它写回来）',
    },
    {
      rel: 'src/node/room.ts',
      note: 'D 散完不关线：那条连接还挂在已经没主的椅子上，客户端以为桌还在',
      from: `        conn.close('这桌散了');`,
      to: `        // 刀：这一句不关线`,
      expect: '只剩一个活人的房主散得动：散完这条线是桌主动关的',
    },
    {
      rel: 'src/node/room.ts',
      note: 'E 抹归抹，可排队那一下合批没掐：半秒后它把刚抹掉的空桌又写回硬盘',
      from: `      clearTimeout(due);
      due = null;
    }
    rmSync(savePath, { force: true });`,
      to: `      due = null;
    }
    rmSync(savePath, { force: true });`,
      expect: '散完硬盘上那份存档真没了（排队的合批也没把它写回来）',
    },
  ],
};
