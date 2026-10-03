/**
 * 候场厅一行座位的文本状态机（home.ts 的 seatRowText）：谁／状态／按钮三处字。
 * 这段原住在 app.ts 的 fill() 里，app.ts 经 `rules.json?raw` 进不了 node 测试，
 * 抽进 home.ts 之后由 ui.test.ts 直测。这两把刀各拆一处关键分支，看那套直测会不会红。
 * from 一律抄源码里现成的那一段，expect 是跑出来抄回去的红字，不是凭记忆写的。
 * 跑法：node tools/knives.mjs --only=home-seatrow（要看每刀全红几句加 --verbose）
 */
export default {
  id: 'home-seatrow',
  title: '候场厅一行座位：谁／状态／按钮三处字的分支（home.ts 的 seatRowText）',
  via: 'test',
  suite: 'test:ui',
  knives: [
    {
      rel: 'src/web/home.ts',
      note: '1 mine 条件翻转：自己那把认不出来，念成别人坐的「有人」',
      from: '  const own = ctx.seated && ctx.me === seat;',
      to: '  const own = ctx.seated && ctx.me !== seat;',
      expect: '自己正坐着那把念「你在这儿」',
    },
    {
      rel: 'src/web/home.ts',
      note: '2 房主位判定拆掉：那把不再缀「房主位」，跑命令那位认不出该坐哪',
      from: '    who: seat === ctx.hostSeat ? `${seatName(seat)} · 房主位` : seatName(seat),',
      to: '    who: seatName(seat),',
      expect: '房主位那把缀一句',
    },
  ],
};
