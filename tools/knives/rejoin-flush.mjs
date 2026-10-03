/**
 * 批1（止血）里客户端那两处的刀谱，搬自会话老脚本 `run-knives.mjs`（A／B 两把，刀口一字未改，2026-09-29 核对仍在源码里）。
 * 第一把拆「断线那几秒的一手照旧排队」，第二把拆「先补发再认椅子」——两把都跑 `test:link`（假钟＋假 ws 那套）。
 * `expect` 是 2026-09-29 从 `--verbose` 的实际红字里抄的：第 1 把红 4 条、第 2 把红 1 条，各钉自己那句。
 */
export default {
  id: 'rejoin-flush',
  title: '断线那几秒的一手不攒进补发队列、握手一成就先认椅子再补发',
  via: 'test',
  suite: 'test:link',
  knives: [
    {
      rel: 'src/web/net.ts',
      note: 'A 断线那几秒的一手又攒进补发队列',
      from: `    if (msg.t !== 'act') this.h.onStatus('这句没递上去：和桌断了。');`,
      to: `    this.outbox.push(text); // 刀：旧口径突变，act 也攒进队列`,
      expect: '断线时按下的那一手压根没排队，回来看不见旧牌面',
    },
    {
      rel: 'src/web/net.ts',
      note: 'B 握手一成就先补发、后认椅子（那句会被桌默默丢掉）',
      from: `      this.h.onReady();
      if (this.online) for (const text of this.outbox.splice(0)) ws.send(text);`,
      to: `      if (this.online) for (const text of this.outbox.splice(0)) ws.send(text);
      this.h.onReady();`,
      expect: '握手成功那一下先认椅子：onReady 跑的时候一条都还没发',
    },
  ],
};
