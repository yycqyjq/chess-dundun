/**
 * 批11（(a) 砍掉房主位自动收回 ＋ (c) 交接要在候场厅说一句）的八把刀。
 * 前两把拆 `src/node/table.ts` 走 `test:net`，中间五把拆 `src/web/home.ts` 那句交接话走 `test:ui`，
 * 最后一把拆 `src/web/app.ts` 的调用点走 `test:style`（一张谱子混三套闸）。
 * 刀口 2026-09-29 逐个核过：现源码里各出现 1 次，且没有别的谱子碰过这几行
 * （`seat-recycle` 那本原来钉着「凭令牌坐回家那把就交回」这一支，那条规则已作废，刀口跟着删了）。
 * D／E 是 2026-09-30 检查那句交接话时补的：代持那位让座之后，位落在一把「挂着令牌但人没连着」的椅子上，
 * 那时候旧写法会念成「交给 阿明（上一把 P2 还空着）」——两处都不对，现在各有一把刀看着。
 * F／G／H 是同一轮里补的「什么时候才开口」：那条判断从 `app.ts` 搬进 `home.ts`（`hostJump`）才有闸，
 * 三把分别拆掉「头一份不念」「没换不念」和调用点递的顺序。
 * `expect` 是从 `npm run knives -- host-no-steal --verbose` 的实际红字里抄的。
 */
export default {
  id: 'host-no-steal',
  title: '房主位不抢人：现任还连着就不换、还回去只剩让座一条路、交接那句要说清位在哪把、那位连着没、什么时候才开口',
  via: 'test',
  suite: 'test:net',
  knives: [
    {
      rel: 'src/node/table.ts',
      note: 'A 坐下就抢：不看现任那把还连着不连着',
      from: `    const keeper = this.slots[host];
    if (keeper?.token && keeper.online) return null;`,
      to: ``,
      expect: '不是房主按不动开始',
    },
    {
      rel: 'src/node/table.ts',
      note: 'B 代持那位也让不成座：还回去这条路没了',
      from: `      if (host === home) return { ok: false, why: '房主不能让座，这桌得有人开局' };
      this.setup.hostSeat = home;
      handed = true;`,
      to: `      return { ok: false, why: '房主不能让座，这桌得有人开局' };`,
      expect: '代持那位让座，房主位当场还回',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'C 上一把坐着人，那句话也说成「还空着」',
      from: `  return seats[from]?.taken`,
      to: `  return false`,
      expect: '交接口念得出交给谁、上一把在谁手上',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'D 不看那把连着没，一律念成「交给某人手上」：让座之后位落在一把空椅子上，那句就教人在等一个不会回来的人',
      from: '  const now = seats[to]?.online ?',
      to: '  const now = true ?',
      expect: '位落在一把没连着的椅子上：那句得说明白「那位还没连着」',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'E 那句退回旧的「（上一把 X 还空着）」：刚让座的说成一直是空的',
      from: '，上一把 ${who(from)} 那把空出来了`;',
      to: '（上一把 ${who(from)} 还空着）`;',
      expect: '上一把那把空了就念「空出来了」，不编一个不在场的人',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'F 挡不住头一份快照：人一进来就凭空念一句「房主位刚交给……」（那之前换过谁没人在看）',
      from: '  return prev >= 0 && next !== prev;',
      to: '  return next !== prev;',
      expect: '头一份座位表不补念（上一份记的是 -1，页面刚打开）',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'G 不看换没换：座位表一秒一份，房主位好好待着也每秒把那句话重讲一遍',
      from: '  return prev >= 0 && next !== prev;',
      to: '  return prev >= 0;',
      expect: '房主位没动不念：不然挂六秒摘掉又重讲一遍',
    },
    {
      rel: 'src/web/app.ts',
      suite: 'test:style',
      note: 'H 调用点把两个数递反：F／G 那两把就全成了摆设（prev 变成这一份，永远不小于 0）',
      from: 'if (hostJump(lastHost, l.hostSeat)) {',
      to: 'if (hostJump(l.hostSeat, lastHost)) {',
      expect: '交接那句递的是「上一份→这一份」',
    },
  ],
};
