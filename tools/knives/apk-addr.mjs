/**
 * App 外壳（APK）：浏览器里地址一律同源、UDP 寻呼由本机那个 Node 宿主代跑；WebView 里两样都没有——
 * 页面 origin 是它自己（那儿没有同源的一张桌），也发不出广播，更没有一个宿主可代跑。
 * 所以「这条连接敲哪扇门」搬进 net.ts 的 tableHost()（人敲过的优先，没敲过还是同源）；
 * 「联机」那一屏在外壳里照样摆同网列表，只是寻呼那一句不递给宿主，改由原生插件自己发 UDP 广播
 * （android 侧 LanSweepPlugin ＋ src/web/nativeDiscover.ts，口令／槽位／广播地址跟电脑端共用 discover.ts）；
 * 回包也走电脑那一份口径（`parseOffer` ＋ `absorb` ＋ `listFound`）：**同一张桌会回两个包**
 * （口令往全网广播和定向广播各发一趟，两条路都到得了它），不归并的话一张桌就占两行、桌名一模一样
 * ——2026-10-10 用户实测就是这么看到的（5180 和 5200 各两行）；
 * 寻不到时底栏那颗「开一桌」换成「手填桌地址」，那一屏的版面＋尺子住 home.ts，app.ts 只管挂上、连、走。
 * 那一屏在外壳里还多一颗「扫一扫」（QrScanPlugin ＋ src/web/nativeScan.ts）：扫回来的是**原文**，
 * 规范化仍走 home.ts 同一把 `normAddr`——扫码就是手填的自动版，不是新的一条路。
 * app.ts 经 rules.json?raw 进不了 node 测试，所以那一屏的形状和 CSS 量挂在 test:style，
 * 那扇门挂在 test:link，版面＋尺子＋那颗「扫一扫」挂在 test:ui，原生插件那一头（认话、归并、摆法、兜底）挂在 test:native，
 * 扫码那一层（没本事回 null／原文原样递／相机没开成往上抛）挂在 test:scan。
 * 2026-10-10 按「外壳里也寻同网的桌」重磨过：原来那把「第一句就岔去手填地址」的刀已经不在源码里了；
 * 同一天又补了 O／P 两把，钉住「归并」和「摆法」——那正是用户看到「一张桌两行」的根子。
 * 同日再补 Q～U 五把，钉住扫码那一片：相机没开成别吞成「没扫到」（Q）、
 * 扫到的照样过尺子（R）、人取消不弹红（S）、没本事不摆那颗（T）、浏览器里别硬递（U）。
 * 2026-10-11 又补 V～Z 五把，钉住「点列表在壳里怎么进桌」和候场厅的「连不上」那一档：
 * 那一行必须是按钮（V／W）、进桌必须由壳自己开 ws（X）、底栏那颗的字不许只写在快照里（Y）、
 * 一次快照都没到手得说实话而不是只甩「正在重连」（Z）。C 那把的刀口也跟着换了新形状。
 * 跑法：npm run knives -- apk-addr（全跑就 npm run knives；看每刀全红几句加 --verbose）
 */
export default {
  id: 'apk-addr',
  title: 'APK 外壳：原生插件自己发广播寻同网的桌，寻不到才手填／扫码给地址',
  via: 'test',
  suite: 'test:style',
  knives: [
    {
      rel: 'src/web/app.ts',
      note: 'A 那一屏不认外壳了：外壳里照样建那条 WebSocket 去发 find（那一头没有本机宿主，连上去只会甩「和桌断了」盖掉「正在寻」）',
      from: '    this.listNative = inAppShell();',
      to: '    this.listNative = false;',
      expect: '外壳里不建那条 WebSocket：进屏先按外壳定下走哪条路',
    },
    {
      rel: 'src/web/app.ts',
      note: 'B 寻呼那一支不分岔：外壳里也发递给宿主的那句 find（那一头压根没有宿主接）',
      from: '    if (this.listNative) {\n      void this.findNative();\n      return;\n    }\n',
      to: '',
      expect: '寻呼分岔：外壳里走原生插件，不发递给宿主的那句 find',
    },
    {
      rel: 'src/web/app.ts',
      note: 'C 底栏那颗不换：外壳里也摆「在这台机器开一桌」（那一头没有一张桌可开）',
      from: "    if (!this.listNative) out.append(button('在这台机器开一桌', () => this.openRoom('create'), 'btn primary'));",
      to: "    out.append(button('在这台机器开一桌', () => this.openRoom('create'), 'btn primary'));",
      expect: '外壳里底栏不摆「在这台机器开一桌」（那一头开不了桌），那颗分岔挂在 !listNative 上',
    },
    {
      rel: 'src/web/app.ts',
      note: 'D 寻呼那一趟不调插件了：外壳里从此寻不到同网的桌（同网列表永远空着）',
      from: '      found = await nativeSweep(SWEEP_MS);',
      to: '      found = [];',
      expect: '原生那一趟真去调插件（nativeSweep），口令那套没抄进 app.ts',
    },
    {
      rel: 'src/web/app.ts',
      note: 'E 手填那一页自己也算一次寻呼：发不出去，等回来的是一句「没找到桌」，人不知道等的是啥',
      from: "    const { body, foot } = page(this.root, entryHead('room'));\n    fillAddr(",
      to: "    const { body, foot } = page(this.root, entryHead('room'));\n    this.findNow();\n    fillAddr(",
      expect: '手填那一屏不发寻呼那一句（那是列表页的事）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'F 那把尺子抄回 app.ts 一份：app.ts 进不了 node 测试，规范化那一串从此没闸',
      from: 'export class App {',
      to: 'function normAddrHere(raw: string): string | null {\n  return raw.trim() || null;\n}\n\nexport class App {',
      expect: '手填那一屏的版面和尺子都在 home.ts（没写回 app.ts）',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'G 外壳那一行小字还念浏览器那一份（「在这台机器开一桌」——那一头开不了桌）',
      from: "  return k === 'room' && app ? ENTRY.room.appNote : ENTRY[k].note;",
      to: '  return ENTRY[k].note;',
      expect: '联机那块在 App 里不念「在这台机器开一桌」——那颗按钮在那一头不存在',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'H 主机那一段不挑形状了：方括号里的 IPv6、带路径的那一串都当成一张桌收下来',
      from: "  if (!/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith('-') || host.endsWith('-') || host.includes('..')) return null;",
      to: '  if (host === \'\') return null;',
      expect: '读不出一张桌的那些一律回 null（含没写端口、端口出界、IPv6、带空格的）',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'I 端口不封顶：99999 也照样连（连不上还不知道是端口写飞了）',
      from: '  if (p < 1 || p > 65535) return null;',
      to: '  if (p < 1) return null;',
      expect: '读不出一张桌的那些一律回 null（含没写端口、端口出界、IPv6、带空格的）',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'J 冒号打头那条（`:5200`：只有端口没有主机）单看是多余的——上面 H 那条主机形状已经把空主机挡掉了',
      from: '  if (at <= 0) return null;',
      to: '  if (at < 0) return null;',
      expect: '',
      belt: true,
    },
    {
      rel: 'src/web/net.ts',
      suite: 'test:link',
      note: 'K 那扇门只认页面自己那台：外壳里没有同源的一张桌，填了地址也还是连设备自己',
      from: '  return tableAddr() || location.host;',
      to: '  return location.host;',
      expect: '敲过之后门跟着那串走，不再跟着页面',
    },
    {
      rel: 'src/web/net.ts',
      suite: 'test:link',
      note: 'L 拼法写死成 ws：https 那张桌（将来挂着证书端出去的）连不上，还看不出是协议的事',
      from: "  return `${pageProtocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`;",
      to: '  return `ws://${host}/ws`;',
      expect: '那条路只有两种写法：https 页面走 wss，其余走 ws，末尾都是 /ws',
    },
    {
      rel: 'src/web/net.ts',
      suite: 'test:link',
      note: 'M 抹掉地址那一句没写：填错一次就再也回不到同源那条路',
      from: '    else localStorage.removeItem(ADDR_KEY);',
      to: '    else void 0;',
      expect: '地址抹掉就退回同源（浏览器那头本来就这样）',
    },
    {
      rel: 'src/web/style.css',
      note: 'N 那一格退回弹窗里那种小输入框的高度：拇指按不准，热区比操作对象还小',
      from: '.addr {\n  appearance: none;\n  width: 100%;\n  min-height: 44px;',
      to: '.addr {\n  appearance: none;\n  width: 100%;\n  min-height: 28px;',
      expect: '桌地址那一格有拇指的高度（≥44px）',
    },
    {
      rel: 'src/web/nativeDiscover.ts',
      suite: 'test:native',
      note: 'O 回包一条条往数组里塞（回到 2026-10-10 那个样子）：同一张桌回两个包就占两行，桌名还一模一样',
      from: '  const book: RoomCache = new Map();\n  absorb(book, heard, now);\n  return listFound(book, now, NO_MINE);',
      to: '  return heard;',
      expect: '同一张桌回两个包只算一条',
    },
    {
      rel: 'src/web/nativeDiscover.ts',
      suite: 'test:native',
      note: 'P 归并完就直接把账端出去、不过 listFound：空桌也跟着列出来，次序也不再是「等开局的在前」',
      from: '  return listFound(book, now, NO_MINE);',
      to: '  return [...book.values()].map((s) => s.found);',
      expect: '一把椅子都没人坐过的桌不列',
    },
    {
      rel: 'src/web/nativeScan.ts',
      suite: 'test:scan',
      note: 'Q 相机没开成也兜成「没扫到」（把原生那句实话吞了）：人对着没反应的按钮猜，不知道是没给权限',
      // 刀口 2026-10-12 重锚：那一趟「在飞」的闸（W）把这段包进了 try/finally，缩进从 2 空格变 4 空格，
      // 原锚点（2 空格那三行）被撞飞了。改成给同一个 try 补一个 catch——要量的那件事没变。
      from: '  } finally {\n    flying = false;\n  }',
      to: '  } catch {\n    return null;\n  } finally {\n    flying = false;\n  }',
      expect: '相机没开成（抛了）就往上抛，别悄悄回 null 混成「没扫到」',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'R 扫到的那串不量了、直接拿去敲门（读不出的一张桌也往连接上递）',
      from: '              const addr = normAddr(raw);\n              note.textContent = addr ? hint : SCAN_BAD;\n              if (addr) onGo(addr);',
      to: '              note.textContent = hint;\n              onGo(raw);',
      expect: '扫到的读不出一张桌：一次也不往连接上递',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'S 人按了返回（没扫到）也当成扫了一串读不出的：他什么都没做错，不该被弹一句红字',
      from: '              // 人取消了（回 null）什么都不动：他没做错事，不该被弹一句\n              if (raw === null) return;\n',
      to: '',
      expect: '人按了返回（没扫到）：不递、也不弹红字（他没做错事）',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'T 不管有没有那本事都摆那颗「扫一扫」：浏览器里也摆一颗按了没反应的',
      from: "  if (scan) {\n    foot.append(\n      button(\n        '扫一扫',",
      to: "  if (true) {\n    foot.append(\n      button(\n        '扫一扫',",
      expect: '不给扫的本事就不摆那颗「扫一扫」（浏览器里扫不了）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'U 浏览器里也把那颗「扫一扫」递进去（那一头没有原生插件，扫不了）',
      from: '      nativeScanAvailable() ? nativeScan : undefined,',
      to: '      nativeScan,',
      expect: '「扫一扫」只在有原生插件时摆（浏览器里扫不了）',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'V 外壳里那一行也照样是真 <a>：一按就被 Capacitor 甩给系统浏览器，人根本没进到 app 里（2026-10-11 用户实测那条）',
      from: "  const row = onPick ? button('', () => onPick(f), cls) : anchor('', roomUrl(f), cls);",
      to: "  const row = anchor('', roomUrl(f), cls);",
      expect: '给了 onPick 就是 <button>，不再是一条会跑掉的 <a>',
    },
    {
      rel: 'src/web/app.ts',
      note: 'W 外壳里那一行不给回调（列表那一行还是真 <a>，一点就跑去浏览器）',
      from: '    const pick = this.listNative ? (room: FoundRoom): void => this.enterRoom(room) : undefined;',
      to: '    const pick = undefined;',
      expect: '外壳里那一行给的是回调（走 enterRoom），浏览器里还是真 <a>',
    },
    {
      rel: 'src/web/app.ts',
      note: 'X enterRoom 又变回「让浏览器自己跳」（壳里点列表又跑去系统浏览器，跟 2026-10-11 之前一个样）',
      from: "    setTableAddr(`${f.ip}:${f.port}`);\n    this.link?.close();\n    this.link = null;\n    this.openRoom('invite');",
      to: "    location.href = `http://${f.ip}:${f.port}/?join=1`;",
      expect: 'enterRoom 走的是「记下地址 ＋ 壳自己开 ws」那条（跟扫码／手填同一条）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'Y 底栏那颗「返回」的字又只写在快照里（一次快照都没到手时它就是一颗没字的按钮——2026-10-11 用户截图里那个）',
      from: "    const leave = button(\n      BACK,",
      to: "    const leave = button(\n      '',",
      expect: '底栏那颗「返回」的字搭屏时就写好了，不等快照（连不上时它改念「回去重选一张」）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'Z 一次快照都没到手也照旧只甩一句「正在重连」：那一屏就是一副空架子＋一颗没字的按钮，人只能无限等',
      from: "      const handled = text !== '' && this.room.fail();",
      to: '      const handled = false;',
      expect: '连不上那句归那一档管，不被「正在重连」盖掉；连上过一次就不再算「连不上」',
    },
    {
      rel: 'src/web/nativeScan.ts',
      suite: 'test:scan',
      note: 'W 拆掉「一趟在飞」那道闸：连点两下就起两个相机页，后到那趟拿不回 call、对应的 await 永远等下去（2026-10-12 第二轮）',
      from: "  if (flying) return null;\n  flying = true;\n  try {\n    const res = await p.scan();\n    const text = res?.text;\n    return typeof text === 'string' && text !== '' ? text : null;\n  } finally {\n    flying = false;\n  }",
      to: "  const res = await p.scan();\n  const text = res?.text;\n  return typeof text === 'string' && text !== '' ? text : null;",
      expect: '同一时刻第二趟当场回 null',
    },
  ],
};
