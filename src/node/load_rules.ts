import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRules, type Rules } from '../core/game.ts';
import type { RankFile } from '../core/pieces.ts';

/**
 * 只有命令行和测试用这条路径：从硬盘读 rules.json。
 * 浏览器那边直接 import rules.json 再喂 parseRules，别把 fs 拖进 core。
 */
export function loadRules(path = fileURLToPath(new URL('../../rules.json', import.meta.url))): Rules {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Omit<Rules, 'ranks'> & { ranks: RankFile[] };
  return parseRules(raw);
}
