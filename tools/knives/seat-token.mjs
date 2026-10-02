/**
 * 椅子那把令牌的来路（2026-10-02 探针撞的，`/tmp/qdd-probe/token-guess.ts`）：
 * `seed` 随每一份快照发给桌上的人，而旧写法把令牌从桌那把 `mulberry32(setup.seed ^ 0x5eed)` 上取——
 * 外人照同一条流往外推，每一把椅子的令牌都算得出来，拿它 `join` 就坐上别人的位子，
 * 那句「这把椅子坐了人」等于没有（修前：受害者令牌＝外人算出来的那句，`join.ok` 为真；修后：算不出、坐不上）。
 * 令牌现在走 `node:crypto` 的 `randomBytes`，跟牌局公平性那把流分家：同一张牌面要能发给全桌复算，一把椅子的钥匙不能。
 * A 钉「回到那条流上」（旧写法原样）；B 钉「换一条也还是 seed 的函数」——两条钉的是同一句关系，不是某个拼法。
 * 跑法：npm run knives -- seat-token（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'seat-token',
  title: '椅子令牌不许是牌局那条种子的函数：算得出令牌就等于能冒充别人',
  via: 'test',
  suite: 'test:net',
  knives: [
    {
      rel: 'src/node/table.ts',
      note: 'A 令牌回到那把种子流上取：同种子的两张桌发出同一把钥匙，外人拿到一条快照就能把每把椅子的令牌推出来',
      from: "    if (fresh) slot.token = `s${seat}-${randomBytes(8).toString('hex')}`;",
      to: '    if (fresh) slot.token = `s${seat}-${this.rng().toString(36).slice(2, 10)}`;',
      expect: '同样种子、同样参数的两张桌，第一把椅子的令牌不许一样：一样就等于它是 seed 的函数，而 seed 发给全桌',
    },
    {
      rel: 'src/node/table.ts',
      note: 'B 换一条来路却仍然是 seed 的函数（拿 seed 跟座位号异或）：换个拼法不等于换个随机源',
      from: "    if (fresh) slot.token = `s${seat}-${randomBytes(8).toString('hex')}`;",
      to: '    if (fresh) slot.token = `s${seat}-${(this.setup.seed ^ seat).toString(36)}`;',
      expect: '同样种子、同样参数的两张桌，第一把椅子的令牌不许一样：一样就等于它是 seed 的函数，而 seed 发给全桌',
    },
  ],
};
