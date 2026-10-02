/**
 * App 外壳（APK 第一版）：浏览器里地址一律同源、UDP 寻呼发得出去；WebView 里两样都没有——
 * 页面 origin 是它自己（那儿没有同源的一张桌），也发不出广播。
 * 所以「这条连接敲哪扇门」搬进 net.ts 的 tableHost()（人敲过的优先，没敲过还是同源），
 * 「联机」那一屏在 Shell 里岔去手填地址那一页（版面＋尺子住 home.ts，app.ts 只管挂上、连、走）。
 * app.ts 经 rules.json?raw 进不了 node 测试，所以那一屏的形状和 CSS 量挂在 test:style，
 * 那扇门挂在 test:link，版面＋尺子挂在 test:ui。
 * 2026-10-01 每把跑过 `npm run knives -- apk-addr --verbose`，`expect` 从实际红字逐字抄回。
 * 跑法：npm run knives -- apk-addr（全跑就 npm run knives；看每刀全红几句加 --verbose）
 */
export default {
  id: 'apk-addr',
  title: 'APK 外壳里同网寻呼换成手填桌地址（第一版安卓包）',
  via: 'test',
  suite: 'test:style',
  knives: [
    {
      rel: 'src/web/app.ts',
      note: 'A 联机那一屏第一句不分岔：外壳里照着浏览器那条路发 UDP 寻呼，那边没有本机宿主代跑',
      from: '    if (inAppShell()) {\n      this.showAddr();\n      return;\n    }',
      to: '',
      expect: '联机那一屏第一句就分岔：外壳里走手填地址，浏览器里照旧走同网列表',
    },
    {
      rel: 'src/web/app.ts',
      note: 'B 那一页自己也算一次寻呼：发不出去，等回来的是一句「没找到桌」，人不知道等的是啥',
      from: "    const { body, foot } = page(this.root, entryHead('room'));\n    fillAddr(",
      to: "    const { body, foot } = page(this.root, entryHead('room'));\n    this.findNow();\n    fillAddr(",
      expect: '外壳那一屏不发寻呼那一句（没有本机宿主代跑）',
    },
    {
      rel: 'src/web/app.ts',
      note: 'C 那把尺子抄回 app.ts 一份：app.ts 进不了 node 测试，规范化那一串从此没闸',
      from: 'export class App {',
      to: 'function normAddrHere(raw: string): string | null {\n  return raw.trim() || null;\n}\n\nexport class App {',
      expect: '那一屏的版面和尺子都在 home.ts（没写回 app.ts）',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'D 外壳那一行小字还念浏览器那一份（「在这台机器开一桌」——那颗按钮在那一头不存在）',
      from: "  return k === 'room' && app ? ENTRY.room.appNote : ENTRY[k].note;",
      to: '  return ENTRY[k].note;',
      expect: '联机那块在 App 里不念「在这台机器开一桌」——那颗按钮在那一头不存在',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'E 主机那一段不挑形状了：方括号里的 IPv6、带路径的那一串都当成一张桌收下来',
      from: "  if (!/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith('-') || host.endsWith('-') || host.includes('..')) return null;",
      to: '  if (host === \'\') return null;',
      expect: '读不出一张桌的那些一律回 null（含没写端口、端口出界、IPv6、带空格的）',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'F 端口不封顶：99999 也照样连（连不上还不知道是端口写飞了）',
      from: '  if (p < 1 || p > 65535) return null;',
      to: '  if (p < 1) return null;',
      expect: '读不出一张桌的那些一律回 null（含没写端口、端口出界、IPv6、带空格的）',
    },
    {
      rel: 'src/web/home.ts',
      suite: 'test:ui',
      note: 'G 冒号打头那条（`:5200`：只有端口没有主机）单看是多余的——上面 E 那条主机形状已经把空主机挡掉了',
      from: '  if (at <= 0) return null;',
      to: '  if (at < 0) return null;',
      expect: '',
      belt: true,
    },
    {
      rel: 'src/web/net.ts',
      suite: 'test:link',
      note: 'H 那扇门只认页面自己那台：外壳里没有同源的一张桌，填了地址也还是连设备自己',
      from: '  return tableAddr() || location.host;',
      to: '  return location.host;',
      expect: '敲过之后门跟着那串走，不再跟着页面',
    },
    {
      rel: 'src/web/net.ts',
      suite: 'test:link',
      note: 'I 拼法写死成 ws：https 那张桌（将来挂着证书端出去的）连不上，还看不出是协议的事',
      from: "  return `${pageProtocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`;",
      to: '  return `ws://${host}/ws`;',
      expect: '那条路只有两种写法：https 页面走 wss，其余走 ws，末尾都是 /ws',
    },
    {
      rel: 'src/web/net.ts',
      suite: 'test:link',
      note: 'J 抹掉地址那一句没写：填错一次就再也回不到同源那条路',
      from: '    else localStorage.removeItem(ADDR_KEY);',
      to: '    else void 0;',
      expect: '地址抹掉就退回同源（浏览器那头本来就这样）',
    },
    {
      rel: 'src/web/style.css',
      note: 'K 那一格退回弹窗里那种小输入框的高度：拇指按不准，热区比操作对象还小',
      from: '.addr {\n  appearance: none;\n  width: 100%;\n  min-height: 44px;',
      to: '.addr {\n  appearance: none;\n  width: 100%;\n  min-height: 28px;',
      expect: '桌地址那一格有拇指的高度（≥44px）',
    },
  ],
};
