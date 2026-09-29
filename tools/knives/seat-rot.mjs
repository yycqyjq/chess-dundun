/**
 * 座位跟着看桌的人转（批3.7 #41，捞回自 b6 A/B/C）：摞、出牌区、名字条一律按「相对我」摆。
 * 三把都见红，但红的是**同一族断言**（`layout.test.ts` 那句「每条名字条和自家那摞同侧」）——
 * 拆的是同一道旋转闸的三处，共用那句，别当成三条专属断言。第 3 把的刀口是**重抄**的：
 * b6 原本钉的 `const band = (rel, x, y) => ({ seat: (rel + mine) % players, ... })` 后来跟着 `edge` 一起改了形，
 * 转座那半件事现在写在 `seat:` 这一行。
 */
export default {
  id: 'seat-rot',
  title: '座位跟着看桌的人转：整套旋转、收牌摞跟转、名字条跟转（批3.7 #41，捞回自 b6 A/B/C，三把共用那句红字）',
  via: 'test',
  suite: 'test:layout',
  knives: [
    {
      rel: 'src/web/board.ts',
      note: 'A 整套旋转拆掉（摞、出牌区按绝对座位摆）｜和第 2、3 把共用那句（同一道闸拆三处）',
      from: '  const rel = (seat: number) => (seat - view.mine + state.players) % state.players;',
      to: '  const rel = (seat: number) => seat;',
      expect: '手机竖屏 390×844｜4 人 我坐 P3 每条名字条和自家那摞同侧',
    },
    {
      rel: 'src/web/board.ts',
      note: 'B 只转收牌摞、不转出牌区（我那一墩还在对面那头）｜和第 1、3 把共用那句',
      from: '    const g = pileGeom(rel(seat), state.players, board, cw);',
      to: '    const g = pileGeom(seat, state.players, board, cw);',
      expect: '手机竖屏 390×844｜4 人 我坐 P3 每条名字条和自家那摞同侧',
    },
    {
      rel: 'src/web/board.ts',
      note: 'C 名字条不跟着转（「你 16 张」挂到对面那角）｜刀口重抄自 `edge` 改版后的 labelBands｜和第 1、2 把共用那句',
      from: '    seat: (rel + mine) % players,',
      to: '    seat: rel,',
      expect: '手机竖屏 390×844｜4 人 我坐 P3 每条名字条和自家那摞同侧',
    },
  ],
};
