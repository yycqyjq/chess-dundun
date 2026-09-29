/**
 * neg-chess2 那批剩下两把，都在 `src/node/room.ts` 的「连接↔椅子」绑定上：
 * 拆完 `test:net` 全绿（那儿测的是桌本身，不走 room.ts 这条 switch），只有真起一桌的冒烟看得见——
 * 2026-09-29 量过的老账写的是「net 全绿、只有冒烟红」，所以这张谱子 `via: 'smoke'`、跑 dev。
 * 刀口 2026-09-29 按现源码重抄过：老脚本那两处都对不上了——
 * `prev.close` 那句在 #47 之后浅了一级（现在 8 空格、且带着 `'这把椅子换了人'` 那句原话），
 * `table.join` 的首参也从 `msg.seat` 改成了批9 那个 `want`（扫码进来递 `seat:-1` 由桌挑空椅）。
 * 第 1 把在老脚本里被 `if (k.run !== 'net') continue` 跳过，当时是靠外面的 shell 起一桌量的。
 * `expect` 是 2026-09-29 从 `--verbose` 的实际红字里抄的：两把都先打出自家那句 ✗，**之后**才在下游那句「等 seats / 等 welcome」上抛，
 * 所以它们不算 `crash`（有专属红字可钉），和 `no-seat-act` 那种一句 ✗ 都没打出来的不一样。
 */
export default {
  id: 'rejoin-same-conn',
  title: '同一条连接重新入座不算换人：别把自己踢下线，也别让桌认不出原来那把是谁的',
  via: 'smoke',
  smoke: 'dev',
  knives: [
    {
      rel: 'src/node/room.ts',
      note: 'A 同一条连接重新入座也把自己踢下线',
      from: `        if (prev && prev !== conn) prev.close('这把椅子换了人');`,
      to: `        if (prev) prev.close('这把椅子换了人');`,
      expect: '同一条连接重新入座，不该把自己踢下线',
    },
    {
      rel: 'src/node/room.ts',
      note: 'B 宿主换椅子时不告诉桌原来那把是谁的（桌自己没错，错在没人递 from）',
      from: `        const r = table.join(want, msg.token, msg.nick, from);`,
      to: `        const r = table.join(want, msg.token, msg.nick);`,
      expect: '换椅子：旧那把当场空了，新那把带着代号',
    },
  ],
};
