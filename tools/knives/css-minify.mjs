/**
 * CSS 压缩那道闸（2026-10-14 打包装出来才发现的问题）。
 *
 * 背景：这轮给 6 处 `inset` 补了四条 `top/right/bottom/left` 兜底（inset 要 Chromium 87、
 * 这份代码的 JS 下限是 85），源码侧那条断言写得再对，**兜底也进不了包**——客户端那条路的
 * CSS 压缩器是 lightningcss（Vite 8 默认；本仓库没装 esbuild），它把同一规则里的四条方向
 * **无条件折回 `inset` 简写**。实测：
 *
 *   {top:0;right:0;bottom:0;left:0}            → inset:0
 *   {top:0;right:0;bottom:0;left:0;inset:0}    → inset:0;inset:0     ← 我们原来的写法
 *   @supports not (inset:0){.e{top:0;…;left:0}}→ …{.e{inset:0}}      ← at-rule 里也折
 *   {…;--q:0;…}                                → 还是折
 *
 * 源码侧躲不开，唯一的开关就是 `vite.config.ts` 的 `cssMinify: false`。这把刀把它翻回
 * 「开着」，`src/test/style.test.ts` 那一节「CSS 压缩必须关着」当场红。
 *
 * 跑法：npm run knives -- css-minify
 */
export default {
  id: 'css-minify',
  title: 'CSS 压缩必须关着：开着的话 lightningcss 会把四条方向折回 inset，兜底进不了包（2026-10-14）',
  via: 'test',
  suite: 'test:style',
  knives: [
    {
      rel: 'vite.config.ts',
      note: 'A 把 CSS 压缩打开（lightningcss 折回 inset 简写，6 处手写兜底整条进不了包）',
      from: "build: { outDir: 'dist', target: 'es2022', cssMinify: false },",
      to: "build: { outDir: 'dist', target: 'es2022' },",
      expect: 'CSS 压缩关着',
    },
    {
      rel: 'vite.config.ts',
      note: 'B 开关留着但写成 true（看着像关着、其实是开着——同一个坑换了个样子）',
      from: "build: { outDir: 'dist', target: 'es2022', cssMinify: false },",
      to: "build: { outDir: 'dist', target: 'es2022', cssMinify: true },",
      expect: 'CSS 压缩关着',
    },
  ],
};
