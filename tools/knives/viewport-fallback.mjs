/**
 * dvh 兜底的刀谱（2026-10-14 用户：「再检查一遍，看看还有什么兼容上的问题」）。
 *
 * 病根：`dvh` 要 Chromium 108 起，而**认不得这个单位的内核会把整条声明丢掉**。
 * 全份 CSS 里最要命的是 `#app { height: 100dvh }`——一丢就没高度，牌桌当场塌成 0。
 * 实测（把 `dvh` 换成非法单位，等价于「不支持」，其余一个字不动）：
 *   认 dvh：`#app` 844px、`.board` 762.3px、`.drawer` 388.2px
 *   不认：  `#app`  81.7px、`.board`   0px、`.drawer`  59.5px   ← 整局没法玩
 *
 * 而 JS 那一侧的语法下限只到 **Chrome 85**（`dist` 里真有 `??=` 与 `||=`，那是 es2022 目标
 * 保留下来的）——比 dvh 的 108 低一大截，所以**确实存在「JS 跑得动、牌桌却塌了」的窗口**
 * （Chromium 85～107 的 WebView：2020～2022 年那批机器上没跟着系统更新过的）。
 * 修法是标准写法：先一行 `vh`，再一行 `dvh`——认 dvh 的用后者，不认的用前者。
 *
 * 两把刀拆两种写法（测试那条是**通用检查**：逐行扫 `dvh`，看上一行是不是同属性的 `vh`）：
 *   A 光秃秃的 `height: 100dvh`（`#app` 那处，塌桌的就是它）；
 *   B `min(42dvh, 330px)`（宽屏浮层那处，写法不一样，别只钉光秃秃那种）。
 */
export default {
  id: 'viewport-fallback',
  title: '每条 dvh 都带同属性的 vh 兜底（2026-10-14 查兼容）',
  suite: 'test:style',
  knives: [
    {
      rel: 'src/web/style.css',
      note: 'A 摘掉 #app 的 vh 兜底：不认 dvh 的内核上 #app 没高度，牌桌塌成 0 高（实测 762.3→0）',
      from: '  height: 100vh;\n  height: 100dvh;\n',
      to: '  height: 100dvh;\n',
      expect: '每条 dvh 都有同属性的 vh 兜底',
    },
    {
      rel: 'src/web/style.css',
      note: 'B 摘掉 min() 那一处的 vh 兜底：宽屏浮层那档写法跟别处不一样，别只钉光秃秃那种',
      from: '    height: min(42vh, 330px);\n    height: min(42dvh, 330px);\n',
      to: '    height: min(42dvh, 330px);\n',
      expect: '每条 dvh 都有同属性的 vh 兜底',
    },
  ],
};
