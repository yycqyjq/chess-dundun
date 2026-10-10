/**
 * 自动入座那三处判断：客户端该递哪把椅子（home.ts 的 autoSeat）、桌该给哪把（table.ts 的 freeSeat）、
 * 线上来的那一句 -1 怎么落（wire.ts 的形闸＋room.ts 的入座）。
 * from 一律抄源码里现成的那一段，expect 是跑出来抄回去的红字，不是凭记忆写的。
 * 7 号那把反过来判：拆的是冗余保险（房主位空着时，前面那句已经把它给出去了），单拆它绿才算合格。
 * 跑法：npm run knives -- auto-sit（要看每刀全红几句加 --verbose）
 */
export default {
  id: 'auto-sit',
  title: '自动入座：建房即房主、扫码递 -1 由桌挑、断线认回原来那把（批9 的四处判断）',
  via: 'test',
  suite: 'test:ui',
  knives: [
    {
      rel: 'src/web/home.ts',
      note: '1 没有 creating 这一说：开桌那位也递 -1，建房即房主就落不到家那把上',
      from: '  if (creating) return seats[lobby.homeSeat]?.taken ? null : lobby.homeSeat;',
      to: '  if (false) return seats[lobby.homeSeat]?.taken ? null : lobby.homeSeat;',
      expect: '开桌那位：直接坐「家」那把',
    },
    {
      rel: 'src/web/home.ts',
      note: '2 家那把被人坐过也硬挤：把人家掉线的椅子当场摘了',
      from: '  if (creating) return seats[lobby.homeSeat]?.taken ? null : lobby.homeSeat;',
      to: '  if (creating) return lobby.homeSeat;',
      expect: '家那把被人坐过（哪怕掉了线）就不硬挤',
    },
    {
      rel: 'src/web/home.ts',
      note: '3 上次那把还连着也照坐：一个标签页抢第二把椅子',
      from: '  if (mine) return mine.online ? null : saved!.seat;',
      to: '  if (mine) return saved!.seat;',
      expect: '原来那把还连着（另个标签页坐着）就谁也不抢',
    },
    {
      rel: 'src/web/home.ts',
      note: '4 断线回来不认原来那把：由桌重新发一把，人一晚上换四个位子',
      from: '  if (mine) return mine.online ? null : saved!.seat;',
      to: '  if (mine) return null;',
      expect: '认回原来那把',
    },
    {
      rel: 'src/web/home.ts',
      note: '5 扫码那位不递 -1，客户端自己点第 1 把：两台手机各挑各的必撞',
      from: '  return -1;',
      to: '  return 0;',
      expect: '递 -1，挑哪把归桌定',
    },
    {
      rel: 'src/net/wire.ts',
      note: '6 -1 又被闸挡回去：扫码进来那一路整条断在门口',
      from: '      if (!isInt(raw.seat) || raw.seat < -1 || raw.seat >= seats) return `没这个座位：这桌只 ${seats} 把椅子`;',
      to: '      if (!isInt(raw.seat) || raw.seat < 0 || raw.seat >= seats) return `没这个座位：这桌只 ${seats} 把椅子`;',
      suite: 'test:net',
      expect: 'seat 写成 -1 认得',
    },
    {
      rel: 'src/node/table.ts',
      note: '7 代持那把不单独绕开（房主位空着时前面那句已经给了它：单拆这一处本该没人看得见）',
      from: '    return this.slots.find((s) => s.seat !== host && s.seat !== home && !s.token)?.seat ?? null;',
      to: '    return this.slots.find((s) => s.seat !== home && !s.token)?.seat ?? null;',
      suite: 'test:net',
      belt: true,
    },
    {
      rel: 'src/node/table.ts',
      note: '8 房主位空着也不先给它：进来的人又落回 P2，房主位空在那儿谁都没有「开始这一局」那颗',
      from: '    if (this.slots[host] && !this.slots[host].token) return host;',
      to: '    if (false && this.slots[host] && !this.slots[host].token) return host;',
      suite: 'test:net',
      expect: '谁先进来谁当房主',
    },
    {
      rel: 'src/node/room.ts',
      note: '9 已经坐着的人也照 -1 再挑一把：一个标签页挪来挪去（只有冒烟走得到 room.ts）',
      from: '        const want: number | null = msg.seat >= 0 ? msg.seat : (seatOf.get(conn) ?? table.freeSeat());',
      to: '        const want: number | null = msg.seat >= 0 ? msg.seat : table.freeSeat();',
      via: 'smoke',
      smoke: 'dev',
      expect: '原来那把还归他',
    },
    {
      rel: 'src/node/room.ts',
      note: '10 没空椅子也往桌前递：那一句「没空椅子了」没人说，人对着转圈',
      from: '        if (want === null) {',
      to: '        if (false) {',
      via: 'smoke',
      smoke: 'dev',
      expect: '没空椅子了',
    },
  ],
};
