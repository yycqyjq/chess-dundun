import { join } from 'node:path';
import { WHOAMI } from '../src/net/discover.ts';

/**
 * 桌面外壳（Electron）里那几件要判断的事都搬在这儿：`main.ts` 引 electron，进不了 node 测试，
 * 所以「端口怎么让」「给房主进程那串参数」「窗口开哪条地址」「自检算不算过」全住在这儿，
 * 闸在 `src/test/desktop.test.ts`。
 *
 * 桌面版跟 APK 那头的分工：APK 里 WebView 起不了桌、发不出 UDP，所以只能手填桌地址（见 home.ts）；
 * 桌面这头自己就是那台开桌的机器，页面开的是 `http://127.0.0.1:端口/`——同源、寻呼都在，
 * 走的还是浏览器那一整条路，压根不需要那格输入框。
 */

/** 5200 是 `npm run host` 那一条。桌面版撞上了就让开：终端上还挂着那张桌，不该反过来把它挤掉 */
export const DEFAULT_PORT = 5200;
/** 往后让多少个：让到这儿还没有就报一句人话，别一路找到 65535 */
export const PORT_SPAN = 20;

/** 挨个试的那串端口（含首选本身） */
export function portCandidates(preferred = DEFAULT_PORT): number[] {
  return Array.from({ length: PORT_SPAN }, (_, i) => preferred + i);
}

/**
 * 桌面那张桌的存档落在系统给这个 App 的目录里（`app.getPath('userData')`），
 * 不落在仓库根那份 `table.json` 上——那是你正在打的活存档。
 * 一台机器上桌面版跟 `npm run host` 各用各的存档，抢同一份的那张会被 room.ts::claimSave 当场拒掉。
 * `--watch-parent` 那条是给 `room.ts::orphanWatch` 的：外壳挨强退／崩了，这张桌自己存档退出，
 * 不赖在端口和占位条上（2026-10-02 量到的：那时再点图标就是永远起不来，屏幕上什么都不出现）。
 */
export function hostArgs(userData: string, port: number): string[] {
  return [`--port=${port}`, `--save=${join(userData, 'table.json')}`, '--watch-parent'];
}

export function entryUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

/** 起桌那句问「这桌上有没有人」就是这条：桌面版用它判断那张桌真起来了 */
export function whoamiUrl(port: number): string {
  return `${entryUrl(port)}whoami`;
}

/**
 * 跑 TypeScript 入口要不要显式加那条 flag：Node 22.6～23.5 得加，更旧的压根不认识它
 * （不认识的 Node 见到未知 flag 直接报错退出），所以只在该给的时候给。
 */
export function stripTypeFlags(allowed: { has(name: string): boolean }): string[] {
  return allowed.has('--experimental-strip-types') ? ['--experimental-strip-types'] : [];
}

/** 那一格是 main.ts 挂载的地方：页面 200 但读不出它，说明端出来的不是这份界面 */
export const MOUNT_MARK = '<div id="app"';

/**
 * 自检算不算通：页面 200 且带着挂载那一格，`/whoami` 回的是**棋墩墩自己的答话**。
 * 认答话而不只认「读得出 JSON」：端口被别的进程占着时，那头也可能回一份 200 带 JSON 的东西
 * （另一个开发服务器、另一个用同一串口的服务）——照单收下就是把别人的页面当自己那张桌端进窗口。
 * 这两条只证明「桌起来了、界面端出去了」，不证明「界面在窗口里点得通」——那一头得有人在桌面上按。
 */
export function selftestOk(page: { status: number; body: string }, whoami: { status: number; body: string }): boolean {
  if (page.status !== 200 || !page.body.includes(MOUNT_MARK)) return false;
  if (whoami.status !== 200) return false;
  try {
    const raw: unknown = JSON.parse(whoami.body);
    return typeof raw === 'object' && raw !== null && (raw as { t?: unknown }).t === WHOAMI;
  } catch {
    return false;
  }
}
