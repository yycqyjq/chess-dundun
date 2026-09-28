import { readFileSync, statSync } from 'node:fs';
import { normalize, join, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

/**
 * 把 dist/ 端出来那一小段：两个宿主共用（npm run host 自己开 http，npm run dev 挂进 Vite 的中间件）。
 * 单拎出来不是为了省事，是因为「这串路径算出来该落在哪儿」这句判断原来只有房主进程里那份，
 * 而房主进程模块顶层就开服——挪到这儿，src/test/discover.test.ts 才敲得动它。
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf8',
  '.js': 'text/javascript; charset=utf8',
  '.css': 'text/css; charset=utf8',
  '.json': 'application/json; charset=utf8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf8',
  '.woff2': 'font/woff2',
};

/** 后缀认不出就给 octet-stream：宁可浏览器下载，也别拿 text/plain 把别的类型糊过去 */
export function mimeOf(file: string): string {
  return MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream';
}

/**
 * URL → dist 里那个文件；认不出（含目录穿越、不存在、是目录）就回 null。
 * 转义写歪的路径（`/%25zz`、`/%e0%a0%80`）decode 就地抛——原来这一抛正好出在 http 回调上，
 * 整个房主进程跟着没了，全桌掉线。这儿认不出这串路径就当没这个文件，回 404 了事。
 */
export function fileFor(url: string, dist: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(url.split('?')[0] ?? '');
  } catch {
    return null;
  }
  const rel = path === '/' || path === '' ? 'index.html' : path.replace(/^\/+/, '');
  const full = normalize(join(dist, rel));
  // 挡目录穿越：算出来的路径必须还在 dist 里头
  if (full !== dist && !full.startsWith(dist + sep)) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/** 一个文件端出去。读不了（刚被 build 换掉、权限不对）就 500，别让整个进程跟着抛 */
export function sendFile(res: ServerResponse, file: string): void {
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf8' });
    res.end('这个文件这会儿读不出来');
    return;
  }
  res.writeHead(200, { 'content-type': mimeOf(file), 'cache-control': 'no-store' });
  res.end(body);
}

export function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf8' });
  res.end('没这个文件');
}
