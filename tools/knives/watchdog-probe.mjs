/**
 * 批3.5（看门狗：桌上安静六秒先问一声再拆线）的刀谱，搬自会话老脚本 `run-knives-b4.mjs`（A／B／C，刀口一字未改，2026-09-29 核对仍在源码里）。
 * 三把都跑 `test:link`（`src/web/net.test.ts` 的假钟那套）。
 * 第 1、3 把拆的是同一段的两半（`if (!this.probeAt)` 那块），第 2 把拆的是「听见动静就记时间」那句。
 * `expect` 是 2026-09-29 从 `--verbose` 的实际红字里抄的：第 2、3 把都会红到「长考一分钟」那条，
 * 靠句尾的计数分开（第 2 把是「开了 1 条、问了 1 声」，第 1 把是「问了 0 声」），所以第 2 把把句尾一起抄进 `expect`。
 */
export default {
  id: 'watchdog-probe',
  title: '桌上安静六秒先探一句活，等够回音的期限才拆线；听见动静就记时间',
  via: 'test',
  suite: 'test:link',
  knives: [
    {
      rel: 'src/web/net.ts',
      note: 'A 安静六秒直接拆线（回到旧脾气：对面每想六秒牌就重连一次）',
      from: `    if (!this.probeAt) {
      this.probeAt = now;
      this.send({ t: 'ping', at: now });
      return;
    }`,
      to: `    if (!this.probeAt) {
      this.probeAt = now;
      this.retry();
      return;
    }`,
      expect: '安静满六秒：先递一句 ping 问一声，而不是拆线',
    },
    {
      rel: 'src/web/net.ts',
      note: 'B 听见桌说话却不记时间（pong 白回，长考照样被拆线）',
      from: `      this.seen = this.now(); // 听见动静就算活着，看不懂的下一句再判`,
      to: `      // 刀：听见也不记`,
      expect: '长考一分钟：一路只问不拆，还是原来那条连接 —— 开了 1 条、问了 1 声',
    },
    {
      rel: 'src/web/net.ts',
      note: 'C 探活那句永远不等回音（真哑了的线再也抓不出来）',
      from: `    if (!this.probeAt) {
      this.probeAt = now;`,
      to: `    if (!this.probeAt) {`,
      expect: '问一声还不答：拆掉这条重连',
    },
  ],
};
