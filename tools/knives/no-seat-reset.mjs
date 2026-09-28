/**
 * 清账重开那处有一把刀必须在冒烟里量：`src/node/room.ts` 里「这条连接还没坐下」那道闸，
 * `test:net` 压根碰不到（那儿测的是形闸和桌本身），只有真起一桌、递一句没座位的 `{t:'reset'}` 才走进去。
 * 所以这张刀谱的 `via` 是 smoke：拆一处源码，量的是一套真起起来的桌（dev 冒烟），不是某个 .test.ts。
 */
export default {
  id: 'no-seat-reset',
  title: '清账递进桌之前先查有没有坐下（只有冒烟走得到 room.ts 那道闸）',
  via: 'smoke',
  smoke: 'dev',
  knives: [
    {
      rel: 'src/node/room.ts',
      note: '没坐下也递给桌（座位号 undefined 一路送进 resetBook）',
      from: `        if (seat === undefined) {
          conn.send(NO_SEAT);
          return;
        }
        const r = table.resetBook(seat);`,
      to: '        const r = table.resetBook(seat ?? 1);',
      expect: '还没坐下就按清账',
    },
  ],
};
