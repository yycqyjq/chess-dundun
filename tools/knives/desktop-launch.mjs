/**
 * 桌面外壳（Electron 第一版）：这台机器自己就是那台开桌的，所以窗口开的是本机那条 http 地址，
 * 同源、同网寻呼、二维码全跟浏览器里一样；要判断的只有四件事——往哪串端口上让、
 * 给房主子进程那串参数（存档必须落在 App 自己的 userData，绝不落在仓库根那份活存档上）、
 * 窗口开哪条地址、自检算不算过。这四件住在 `desktop/launch.ts`（`main.ts` 引 electron，进不了 node 测试）。
 * 2026-10-01 每把跑过 `npm run knives -- desktop-launch --verbose`，`expect` 从实际红字逐字抄回；
 * N（2026-10-02）照同一条路子量：先把闸改成接 `error` 事件，从 `--verbose` 的红字里抄回那句。
 * 跑法：npm run knives -- desktop-launch（全跑就 npm run knives；看每刀全红几句加 --verbose）
 */
export default {
  id: 'desktop-launch',
  title: '桌面外壳起桌那四件事（端口让位／存档落点／地址拼法／自检判据）',
  via: 'test',
  suite: 'test:desktop',
  knives: [
    {
      rel: 'desktop/launch.ts',
      note: 'A 让位只让一个端口：5200 被终端那张桌坐着的时候，桌面版当场开不起来，也不往后挪',
      from: '  return Array.from({ length: PORT_SPAN }, (_, i) => preferred + i);',
      to: '  return Array.from({ length: 1 }, (_, i) => preferred + i);',
      expect: '让到 PORT_SPAN 个就收口，别一路找到 65535',
    },
    {
      rel: 'desktop/launch.ts',
      note: 'B 不递 --save：那边读回来的就是仓库根默认那一份，桌面版跟你正在打的活存档写同一本账',
      from: "  return [`--port=${port}`, `--save=${join(userData, 'table.json')}`, '--watch-parent'];",
      to: '  return [`--port=${port}`, \'--watch-parent\'];',
      expect: '省略 --save 就是落回默认那份，所以这一项必须写出来',
    },
    {
      rel: 'desktop/launch.ts',
      note: 'C 存档路径写死：换一份 userData 它不动，两个装好的包共用一份账（跟 B 是两件事，各拆一遍）',
      from: "  return [`--port=${port}`, `--save=${join(userData, 'table.json')}`, '--watch-parent'];",
      to: "  return [`--port=${port}`, `--save=${join('/var/tmp/qdd', 'table.json')}`, '--watch-parent'];",
      expect: '换一份 userData，存档跟着换：路径是从参数来的，不是写死的',
    },
    {
      rel: 'desktop/launch.ts',
      note: 'D 顺手带上 --fresh：每次打开桌面版都把上一桌掀了重摆，接不回自己那一局',
      from: "  return [`--port=${port}`, `--save=${join(userData, 'table.json')}`, '--watch-parent'];",
      to: "  return [`--port=${port}`, `--save=${join(userData, 'table.json')}`, '--watch-parent', '--fresh'];",
      expect: '不许带 --fresh：桌面重开该接回自己那一桌，不是每次掀了重摆',
    },
    {
      rel: 'desktop/launch.ts',
      note: 'E 那条 flag 永远给：更旧的 Node 见到认不出的 flag 当场报错退出，桌压根起不来',
      from: "  return allowed.has('--experimental-strip-types') ? ['--experimental-strip-types'] : [];",
      to: "  return ['--experimental-strip-types'];",
      expect: '认都不认就别给：不认识的 Node 见到未知 flag 当场报错退出，桌压根起不来',
    },
    {
      rel: 'desktop/launch.ts',
      note: 'F 那条 flag 永远不给：22.6～23.5 读不了 .ts 入口，起桌那句直接「找不到文件」',
      from: "  return allowed.has('--experimental-strip-types') ? ['--experimental-strip-types'] : [];",
      to: '  return [];',
      expect: '这台 Node 认这条就给（22.6～23.5 不显式加读不了 .ts）',
    },
    {
      rel: 'desktop/launch.ts',
      note: 'G 窗口那条地址末尾的斜杠丢了：whoami 接在尾巴上就成了 `:5200whoami`',
      from: '  return `http://127.0.0.1:${port}/`;',
      to: '  return `http://127.0.0.1:${port}`;',
      expect: '问「这桌上有没有人」是这条地址加 whoami，不多一个斜杠',
    },
    {
      rel: 'desktop/launch.ts',
      note: 'H 自检不查挂载那一格：端口被别的进程占着、端出来一页别的 HTML，也算「桌起来了」',
      from: '  if (page.status !== 200 || !page.body.includes(MOUNT_MARK)) return false;',
      to: '  if (page.status !== 200) return false;',
      expect: '页面 200 但读不出挂载那一格：端出来的不是这份界面',
    },
    {
      rel: 'desktop/launch.ts',
      note: 'I 自检退回「/whoami 读得出 JSON 就算」：别的开发服务器回一份 JSON 也照单收下（2026-10-01 收紧前就是这一版）',
      from: '    return typeof raw === \'object\' && raw !== null && (raw as { t?: unknown }).t === WHOAMI;',
      to: '    return typeof raw === \'object\' && raw !== null;',
      expect: 'whoami 200、JSON 也对，但不是棋墩墩的答话（别的开发服务器）：不许照单收下',
    },
    {
      rel: 'desktop/main.ts',
      note: 'J 收尾硬杀子进程：host.ts 那个先存档再退的 quit() 没机会跑，这一桌的牌面丢在内存里',
      from: "  child?.kill('SIGTERM');",
      to: "  child?.kill('SIGKILL');",
      expect: 'main.ts 收尾发的是 SIGTERM：那是 host.ts 里先存档再退的那条路，硬杀会丢这一桌',
    },
    {
      rel: 'desktop/main.ts',
      note: 'K 试端口拿默认绑法试：host.ts 绑的是 0.0.0.0，那个口上其实坐着人也可能被看成空的',
      from: "            srv.listen(port, '0.0.0.0');",
      to: '            srv.listen(port);',
      expect: 'main.ts 试端口照 0.0.0.0 的绑法试：host.ts 绑的就是它，拿 127.0.0.1 试会看走眼',
    },
    {
      rel: 'desktop/launch.ts',
      note: 'L 判断那一头引回 electron：这份文件从此进不了 node 测试，四件事一起变回没闸',
      from: "import { join } from 'node:path';",
      to: "import 'electron';\nimport { join } from 'node:path';",
      expect: 'launch.ts 一个字都不引 electron：引了这份文件就进不了 Node 测试，判断等于没闸',
    },
    {
      rel: 'desktop/main.ts',
      note: 'M 窗口那里自己再拼一条地址：launch.ts 那只手还在，两边一改就分家',
      from: "  const win = new BrowserWindow({ width: 1280, height: 860, title: '棋墩墩' });",
      to: "  const own = 'http://127.0.0.1:5200/';\n  void own;\n  const win = new BrowserWindow({ width: 1280, height: 860, title: '棋墩墩' });",
      expect: 'main.ts 里没有第二条拼地址的路：那条地址只有 entryUrl/whoamiUrl 两只手',
    },
    {
      rel: 'desktop/main.ts',
      note: "N 等桌开口改成接 error 事件：那只在 spawn 失败时响，桌自己退出一声不吭，界面还是干等满 15 秒",
      from: "    proc.once('exit', () => res(false));",
      to: "    proc.once('error', () => res(false));",
      expect: 'main.ts 等桌开口接的是子进程 exit：它自己走了就立刻收，别对着一台没动静的机器干等满 15 秒',
    },
    {
      rel: 'desktop/launch.ts',
      note: 'O 那串参数里没有 --watch-parent：桌不知道自己是给外壳拉起来的，父进程挨强退之后它赖在端口和占位条上，第二张桌被拒而屏幕上什么都不出现',
      from: "  return [`--port=${port}`, `--save=${join(userData, 'table.json')}`, '--watch-parent'];",
      to: "  return [`--port=${port}`, `--save=${join(userData, 'table.json')}`];",
      expect: '带上 --watch-parent：外壳挨强退／崩了，这张桌自己先存档再退，不赖在端口和占位条上',
    },
    {
      rel: 'desktop/main.ts',
      note: 'P 摘掉那条 spawn 的 error 监听：没拉起来那一种下场 `exit` 一声不响（2026-10-02 探针量过），没人接就是把主进程连那串参数一起崩掉',
      from: "    proc.once('error', (e) => {\n      console.error(`那张桌没拉起来：${e.message}`);\n      res(false);\n    });",
      to: '    // 这里本来接的是 spawn 自己没成那一种下场',
      expect: 'main.ts 也接了 spawn 那条 error：那种下场 exit 不响，没人接就是把主进程连那串参数一起崩掉',
    },
    {
      rel: 'desktop/main.ts',
      note: 'Q 摘掉那条不靠请求回应的硬闸：header 已回、body 卡在半截就是没下场，重试那一排永远排不到头，等桌开口就成了干等',
      from: '    setTimeout(() => res(false), READY_MS);',
      to: '    void READY_MS;',
      expect: '等桌开口有一条不靠请求回应的硬闸：body 卡在半截就是没下场，只靠重试那一排能一直干等',
    },
    {
      rel: 'desktop/main.ts',
      note: "R 摘掉读页面那句 aborted：body 永远不到时 `req.on('error')` 不会响（2026-10-02 探针量过），--selftest 就永不收尾",
      from: "      r.on('aborted', () => res({ status: r.statusCode ?? 0, body }));",
      to: '      // 这里本来接的是 header 已回、body 卡住那一种下场',
      expect: "读页面接了 aborted：header 已回、body 永远不到时 req 那条 error 不会响，不接这句自检就永不收尾",
    },
    {
      rel: 'src/node/host.ts',
      note: 'S 看门狗拴在开桌之前：那一挨父进程正好没了就是撞 room 还没定义，存档没落反倒抛一句',
      from: 'const { port, room } = openTable();',
      to: 'orphanWatch(argv, quit);\nconst { port, room } = openTable();',
      expect: 'host.ts 把那条看门狗拴在开桌之后：拴在前面那一挨就是撞 room 还没定义，桌没存成反倒抛一句',
    },
  ],
};
