/**
 * 一份存档只许一张桌写（2026-09-30：npm run dev 和 npm run host 默认都落在仓库那份 table.json 上，
 * 两张桌同时开就是后起的那张悄悄把前一张的账盖了——一边打到第 8 局，另一边重启接回自己那半本，椅子令牌局号全对不上）。
 * 判断收在 lockVerdict 那一颗纯函数里（free／mine／taken），落盘的动作收在 claimSave，
 * 起桌前占住、收桌最后摘，两个宿主（room.ts 一处）都念同一句人话。
 * 条上必须写「占的是哪一份存档」——这一格是冒烟量出来的：整份项目拷进临时目录再开桌，
 * 拷走的条上写着一个还活着的进程号（那台 5199 的 dev），不写路径就把自家副本拒在门外。
 * A 钉「起桌前根本没占」；B 钉「只看 pid 不看端口」；C 钉「死人的留条也算闸」；
 * D 钉「读不懂的留条反过来把人锁在门外」；E 钉「收桌时把别人的闸拆了」；
 * F 钉那句人话不含证据（撞上哪份存档、谁占着、往哪儿改）；G 钉「进程号问出来的活着」那把真尺子；
 * H 钉「不比对路径」＝回到冒烟撞上那一晚的行为；I 钉「条上那一格写死」，占的是哪份存档根本没记下来；
 * J 钉「比的是那串字而不是那个文件」（2026-10-02 桌面版量到的软链那一档）；K 钉「存档还没落盘就不认父目录的实底」；
 * L 钉「抢位那一步不原子」（2026-10-02 加）：退回「读→判→写」三步，同起的两张桌双双读到空条双双放行，后写的条盖前一张，两张桌同写一份 table.json。
 * 跑法：npm run knives -- save-lock（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'save-lock',
  title: '存档前的占位条：两张桌不许写同一份账',
  via: 'test',
  suite: 'test:net',
  knives: [
    {
      rel: 'src/node/room.ts',
      note: 'A 起桌根本不占：restore 一读就是几十毫秒，那中间另一张桌也在写同一份就晚了',
      from: '  const releaseSave = claimSave(savePath, port);',
      to: '  const releaseSave = (): void => {};',
      expect: '起桌第一件事就是占住这份存档',
    },
    {
      rel: 'src/node/room.ts',
      note: 'B 只认 pid 不认端口：同一趟里改端口重起、或者一台机器两张桌，全被当成「就是我自己」',
      from: "  if (held.pid === mine.pid && held.port === mine.port) return 'mine';",
      to: '  if (held.pid === mine.pid) return \'mine\';',
      expect: '只对上 pid、端口不一样照样拒',
    },
    {
      rel: 'src/node/room.ts',
      note: 'C 只要条上写着东西就当有人占着：前人挨 SIGKILL 走的留条变成死闸，这份存档从此谁也开不了桌',
      from: "  return alive(held.pid) ? 'taken' : 'free';",
      to: "  return 'taken';",
      expect: '写那条的进程已经没了：让开（前人挨 SIGKILL 走的留条不算闸）',
    },
    {
      rel: 'src/node/room.ts',
      note: 'D 读不懂的留条当「有人占着」：半截字节（硬盘写满那一下）就把门锁死，宁可让桌开起来也不该这样',
      from: '  } catch {\n    held = null;\n  }',
      to: '  } catch {\n    held = { pid: 1, port: 1, save: canonicalSave(save) };\n  }',
      expect: '整条读不出 JSON 的也让开',
    },
    {
      rel: 'src/node/room.ts',
      note: 'E 收桌无条件摘条：这张桌被别人接管过之后，前一个人的收桌把现在这位的闸拆了，等于没闸',
      from: "      if (readFileSync(file, 'utf8') === body) rmSync(file, { force: true });",
      to: '      rmSync(file, { force: true });',
      expect: '别人的那条不许摘：接管过这张桌的人的闸，拆了等于没闸',
    },
    {
      rel: 'src/node/room.ts',
      note: 'F 那句只说「被占了」：不念是哪份存档、谁占着、往哪儿改，人对着两句终端不知道关哪一张',
      from: '    throw new Error(`这份存档（${save}）已经被 ${held!.port} 端口上那张桌占着（进程 ${held!.pid}）：先关掉那张，或者给这一张另加 --save=另一份文件`);',
      to: "    throw new Error('这份存档正被另一张桌写着');",
      expect: '那句念得出撞上的是哪份存档、谁占着、往哪儿改',
    },
    {
      rel: 'src/node/room.ts',
      note: 'G 问进程号那把尺子坏了（一律算活着）：注入 alive 的那几条量不到这一档，只有真问一遍才知道漏',
      from: '  try {\n    process.kill(pid, 0);\n    return true;\n  } catch (e) {\n    return (e as NodeJS.ErrnoException).code === \'EPERM\';\n  }',
      to: '  return true;',
      expect: '不注入 alive 也认得死人：那条留条拦不住新桌（真进程号问出来的）',
    },
    {
      rel: 'src/node/room.ts',
      note: 'H 不比对路径（就是冒烟撞上那一晚的行为）：项目整份拷进临时目录开一桌，被自家副本里那条还活着的留条拒了',
      from: "  if (!held || held.save !== mine.save) return 'free';",
      to: "  if (!held) return 'free';",
      expect: '那条写的根本不是这一份存档',
    },
    {
      rel: 'src/node/room.ts',
      note: 'I 条上那一格写死成一个文件名：占的到底是哪份存档再也没记下来，比对路径的那两档全悬空',
      from: '  const mine: SaveLock = { pid: process.pid, port, save: canonicalSave(save) };',
      to: "  const mine: SaveLock = { pid: process.pid, port, save: 'table.json' };",
      expect: '头一张桌占住了',
    },
    {
      rel: 'src/node/room.ts',
      note: 'J 那格只摊平不认软链：同一个存档写成两条串就被看成两份，两张桌各写各的、账互相盖（macOS 的 /tmp、/var 本来就是软链）',
      from: '  const mine: SaveLock = { pid: process.pid, port, save: canonicalSave(save) };',
      to: '  const mine: SaveLock = { pid: process.pid, port, save: resolve(save) };',
      expect: '同一份存档换条软链写法照样撞：两张桌不许写同一本账，哪怕路径串得不一样',
    },
    {
      rel: 'src/node/room.ts',
      note: 'K 存档还没落盘就不认父目录的实底：新桌那一下两条路径谁也没认到底，软链那头照样溜过去',
      from: '      return join(real(dirname(abs)), basename(abs));',
      to: '      return abs;',
      expect: '存档还没落盘（新桌第一局）：认父目录的实底，再把文件名接回去',
    },
    {
      rel: 'src/node/room.ts',
      note: 'L 抢位那一步不原子（退回「读→判→写」三步）：同起的两张桌双双读到没人占、双双放行，后写的条盖掉前一张，两张桌同写一份 table.json',
      from: "    writeFileSync(file, body, { flag: 'wx' });",
      to: '    writeFileSync(file, body);',
      expect: '另一张活桌抢同一份存档：当场拒，不悄悄把人家的账盖了',
    },
  ],
};
