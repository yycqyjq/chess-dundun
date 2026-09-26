import rulesText from '../../rules.json?raw';
import { parseRules, type Rules } from '../core/game.ts';
import type { RankFile } from '../core/pieces.ts';

/**
 * ?raw 拿到的是纯字符串，JSON.parse 出来是 any，所以规则表的结构在这一行收口一次。
 * 单一来源还是根目录那份 rules.json，改规则照样不用动代码。
 */
export const rules: Rules = parseRules(
  JSON.parse(rulesText) as Omit<Rules, 'ranks'> & { ranks: RankFile[] },
);
