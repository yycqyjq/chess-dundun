import './style.css';
import { App } from './app.ts';

const root = document.getElementById('app');
if (root) {
  const app = new App(root);
  // 只挂开发版：调试时能直接看引擎状态，构建产物里这一行会被 vite 去掉
  if (import.meta.env.DEV) (window as unknown as { game: App }).game = app;
}
