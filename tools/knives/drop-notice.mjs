/**
 * 掉线轻提醒的刀谱（2026-10-11）。用户看着真机截图点名的两件事：
 * ① 「P2 掉线」那两个字缩在座位行里，**都看不到**——桌面正上方得有一条轻提醒；
 * ② 掉线之后电脑什么时候接手，屏上得有个**倒计时**（人斗地主里就有）。
 *
 * 这一条拆成三截：服务端把「还剩多久接手」当锚点发下来（takeoverIn）、
 * 客户端每秒拿锚点减本地过了多久（倒计时才走得动）、那句话本体住在 home.ts。
 * 三截各挂各的套件：文案归 test:ui、锚点归 test:net、接线与样式归 test:style。
 * 判红照老规矩：退出码非 0 **且**命中 expect 那句文案。
 *
 * 跑法：npm run knives -- drop-notice（看每刀全红几句加 --verbose）
 */
export default {
  id: 'drop-notice',
  title: '掉线轻提醒：桌面正上方那条，带「几秒后电脑代打」的倒计时',
  via: 'test',
  suite: 'test:ui',
  knives: [
    {
      rel: 'src/web/home.ts',
      note: 'A 一位都没掉线也露脸（回一句字，那条轻提醒就永远挂在桌上了）',
      from: "  if (list.length === 0) return '';",
      to: "  if (list.length === 0) return '掉线了';",
      expect: '一位都没掉线：那条轻提醒不露脸（回空串）',
    },
    {
      rel: 'src/web/home.ts',
      note: 'B 倒计时不取最近的那位（一桌掉两位时念的是头一位的数，人看着就以为还早）',
      from: '    const ms = Math.min(...pending.map((s) => s.leftMs));',
      to: '    const ms = pending[0]!.leftMs;',
      expect: '同时掉两位：名字连起来念，倒计时取最近的那位',
    },
    {
      rel: 'src/web/home.ts',
      note: 'C 已经被电脑接手了还在念倒计时（那句「已由电脑代打」永远说不出口）',
      from: '  return `${warnNames(list)} 掉线太久，已由电脑代打`;',
      to: '  return `${warnNames(list)} 掉线了 · 马上由电脑代打`;',
      expect: '已经被电脑接手：换一句，不再有倒计时',
    },
    {
      rel: 'src/node/table.ts',
      note: 'D 锚点恒给满三十秒（客户端照着它往下数，那个数就是个冻住的假数）',
      from: '          ? Math.max(0, TAKEOVER_MS - (t - s.gone))',
      to: '          ? TAKEOVER_MS',
      suite: 'test:net',
      expect: '过了十秒：锚点跟着少十秒（客户端从它往下数）',
    },
    {
      rel: 'src/node/table.ts',
      note: 'E 候场期也给代打倒计时（那一档压根不开，拿「几秒后代打」去吓人就是撒谎）',
      from: "        this.status === 'playing' && s.human && !s.online && !s.ai",
      to: '        s.human && !s.online && !s.ai',
      suite: 'test:net',
      expect: '候场期掉线：不给代打倒计时（那一档压根不开）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'F 倒计时不跟本地时间走（光把桌给的锚点摆上去，屏上那个数一动不动）',
      from: '      .map((s) => ({ name: seatName(s.seat), leftMs: Math.max(0, s.takeoverIn - left), ai: s.ai }));',
      to: '      .map((s) => ({ name: seatName(s.seat), leftMs: s.takeoverIn, ai: s.ai }));',
      suite: 'test:style',
      expect: '倒计时跟着本地时间往下走（拿桌给的锚点减本地过了多久）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'G 每秒不推那一格（那句话只在快照来的时候重画，倒计时一秒都不动）',
      from: `      this.link?.beat();
      this.paintNotice();`,
      to: '      this.link?.beat();',
      suite: 'test:style',
      expect: '每秒推一次（1 秒那条 ticker 里也调 paintNotice）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'H 候场那一档也数掉线三十秒（那把椅子归另一条路：闲置两分钟还回桌上）',
      from: "    if (!this.seats || this.status !== 'playing') return '';",
      to: "    if (!this.seats) return '';",
      suite: 'test:style',
      expect: '只有打牌这一档才给倒计时（候场期那条椅子归另一条路）',
    },
    {
      rel: 'src/web/ui.ts',
      note: 'I 那条轻提醒不挂在桌面上（挂到 root 上就跟牌桌各画各的，桌面正上方那一带空着）',
      from: '  board.append(ctrl, notice);',
      to: '  board.append(ctrl);\n  root.append(notice);',
      suite: 'test:style',
      expect: '外壳里真有那么一条，钉在桌面上（board.append(ctrl, notice)）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'J 座位表到手时不重画那条轻提醒（谁掉线了那条压根不露脸）',
      from: `    this.seatFlash(wasSeats);
    this.paintNotice();`,
      to: '    this.seatFlash(wasSeats);',
      suite: 'test:style',
      expect: '那份座位表到手时接上了：翻篇飘一句、那条轻提醒跟着重画',
    },
    {
      rel: 'src/web/style.css',
      note: 'K 那条轻提醒平时也吃点击（它是提醒，不是挡在桌上的东西）',
      from: `  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  opacity: 0;
  pointer-events: none;`,
      to: `  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  opacity: 0;
  pointer-events: auto;`,
      suite: 'test:style',
      expect: '不露脸时也不吃点击（pointer-events: none）',
    },
    {
      rel: 'src/web/style.css',
      note: 'L 那句「该露才露」的样子没了（.notice.show 被改名，露脸那一下没规则接着）',
      from: '.notice.show {',
      to: '.notice.on {',
      suite: 'test:style',
      expect: '它在 CSS 里有个「平时不露脸、该露才露」的样子（.notice / .notice.show）',
    },
  ],
};
