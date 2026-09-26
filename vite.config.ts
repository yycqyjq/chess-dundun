import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径：之后 Capacitor（安卓）和 Tauri/Electron（Win/Mac）都是把 dist 塞进壳里，绝对路径会白屏
  base: './',
  build: { outDir: 'dist', target: 'es2022' },
  // 5173 被本机另一个项目（pocket-kit）占着，这里钉死一个不撞车的端口
  server: { host: true, port: 5199, strictPort: true },
});
