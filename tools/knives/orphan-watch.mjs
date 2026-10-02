/**
 * 桌面外壳挨强退／崩了之后那张桌的去处（2026-10-02 真复现的）：`kill -9` 掉外壳，macOS 把子进程交回 launchd（ppid 变 1），
 * 桌照旧活着、端口和存档旁边那条占位条照旧攥着——于是再点图标永远起不来，新那张被 `claimSave` 拒掉，
 * 而那句理由打在终端上，从访达点开的人根本没有终端，屏幕上什么都不出现。
 * 判断收在 `src/node/room.ts::orphanWatch` 这一颗纯函数里（`ppid` 和「多久问一次」都能注入），
 * `host.ts` 只剩一句 `orphanWatch(argv, quit)`：走的就是 Ctrl-C 那条「先存档、摘占位条、再退」。
 * 这条只在外壳显式带 `--watch-parent` 时装——`npm run host` 那条路的爹是终端，挂在终端里的人合上 shell 不算收桌。
 * A 钉「谁都装」；B 钉「认反了」；C 钉「问得太慢」；D 钉「认出来了却不收桌」；E 钉「比的是换没换，反着比」。
 * 跑法：npm run knives -- orphan-watch（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'orphan-watch',
  title: '外壳没了这张桌自己收：那条看门狗只在外壳要求时才装',
  via: 'test',
  suite: 'test:net',
  knives: [
    {
      rel: 'src/node/room.ts',
      note: 'A 摘掉那道 flag 闸：谁都装——npm run host 挂在终端里，人合上 shell（父进程没了）桌就被误收',
      from: "  if (!hasFlag(argv, 'watch-parent')) return;",
      to: "  if (argv.length < 0) return;",
      expect: '不带 --watch-parent 就一个字都不装：npm run host 那条路的爹是终端，掀不得',
    },
    {
      rel: 'src/node/room.ts',
      note: 'B 认反了：带 --watch-parent 的不装、没带才装，桌面那头正好拿不到这条狗',
      from: "  if (!hasFlag(argv, 'watch-parent')) return;",
      to: "  if (hasFlag(argv, 'watch-parent')) return;",
      expect: '装上就一秒问一次：外壳强退之后这张桌别再多赖一分钟',
    },
    {
      rel: 'src/node/room.ts',
      note: 'C 改成一分钟问一次：桌在端口和占位条上多赖一分钟，这一分钟里用户重试两次全是「起不来」',
      from: '  arm(1000, () => {',
      to: '  arm(60_000, () => {',
      expect: '装上就一秒问一次：外壳强退之后这张桌别再多赖一分钟',
    },
    {
      rel: 'src/node/room.ts',
      note: 'D 认出了父没了、那一句却不去执行：桌照旧赖在端口和占位条上，等于这条狗拴了个空圈',
      from: '    if (ppid() !== born) onGone();',
      to: '    if (ppid() !== born) void born;',
      expect: '爹换人了（外壳挨 SIGKILL，macOS 把桌交回 launchd）：走 onGone，也就是 host.ts 那句先存档再退的 quit()',
    },
    {
      rel: 'src/node/room.ts',
      note: 'E 比反了：认的是「还是不是原来那位」，写成「等于原来那位才走」就成了爹在的时候收、爹没了不动',
      from: '    if (ppid() !== born) onGone();',
      to: '    if (ppid() === born) onGone();',
      expect: '爹还是原来那一位：不走（打到一半的桌不能被一句误判收掉）',
    },
  ],
};
