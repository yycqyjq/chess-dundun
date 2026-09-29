/**
 * 批3（流畅度）里挪牌那三把的刀谱，搬自会话老脚本 `run-knives-b3.mjs` 的 C／D。
 * 老脚本里 D 是两处一起改（构造时不挂＋每挪一次挂一个 once），刀架一把只拆一处，
 * 所以在这儿拆成两把分别量（2026-09-29）：第 1 把拆掉构造时那一次，第 2 把加回每挪一次挂 once。
 * 都跑 `test:ui`（`src/web/ui.test.ts` 里有用假 el 验 Pieces 的那几段）。
 * `expect` 是 2026-09-29 从 `--verbose` 的实际红字里抄的。第 2、3 把红的是**同一条断言**（收尾监听只挂一次），
 * 只有句尾那份计数分开（第 2 把一个都没挂上＝`0,0,…`，第 3 把每挪一次多挂一个＝`8,8,…`），所以 `expect` 连句尾一起抄。
 */
export default {
  id: 'piece-flip',
  title: '挪牌一次只逼一遍重排、补间收尾的监听只在构造时挂一次',
  via: 'test',
  suite: 'test:ui',
  knives: [
    {
      rel: 'src/web/pieces.ts',
      note: 'A 挪牌时每张各逼一次重排（回到夹在循环里的 read）',
      from: `      el.style.transform = at(was, was.x, was.y);
      tween.push({ el, p });`,
      to: `      el.style.transform = at(was, was.x, was.y);
      void el.offsetWidth;
      tween.push({ el, p });`,
      expect: '八颗一起挪：只逼一次重排',
    },
    {
      rel: 'src/web/pieces.ts',
      note: 'B 构造时不挂收尾监听（补间跑完那下没人摘 transition）｜和第 3 把共用那条断言，靠句尾计数分开',
      from: `      el.addEventListener('transitionend', (ev) => {
        if (ev.target === el) el.style.transition = '';
      });`,
      to: `      // 刀：构造时不挂`,
      expect: '连挪六拍，每颗牌身上还是只有一个收尾监听（不攒半路掐下一拍的） —— 0,0,0,0,0,0,0,0',
    },
    {
      rel: 'src/web/pieces.ts',
      note: 'C 收尾监听回到「每挪一次挂一个 once」（挪得快的牌上攒一堆）｜和第 2 把共用那条断言，靠句尾计数分开',
      from: `      el.style.transform = at(p, p.x, p.y);
    }
  }
}`,
      to: `      el.style.transform = at(p, p.x, p.y);
      el.addEventListener(
        'transitionend',
        () => {
          el.style.transition = '';
        },
        { once: true },
      );
    }
  }
}`,
      expect: '连挪六拍，每颗牌身上还是只有一个收尾监听（不攒半路掐下一拍的） —— 8,8,8,8,8,8,8,8',
    },
  ],
};
