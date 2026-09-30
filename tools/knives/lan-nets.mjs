/**
 * 「这块网卡该不该报出去」那一档的刀谱（2026-09-30：覆盖对账查出 `room.ts::lanNets` 一份测试都没引用过）。
 *
 * 这四条筛选（回环／自编／v6／VPN 那串名字）加打分排序原先只长在真硬件上：筛错了的样子跟
 * 「这块网不让设备互访」一模一样，看不出区别——2026-09-29 那次空清单就是这么绕了一圈的。
 * 现在 `nics` 能递一张假的进来，13 条断言全在 `test:discover` 里跑，这 11 把刀也就钉得住动作本身。
 *
 * 四处说明（2026-09-30 逐把实测，红字条数抄自 `npm run knives -- lan-nets --verbose`）：
 * ① 11 把里 8 把只红一句；B 多点亮「空着不递就是问本机」——这台机器真连着网，v6 一不筛，默认那一路跟着漏，两条红都是 B 自己造成的。
 * ② G（去掉并列时按名字）红三条（并列最前／依次靠后／两位序号），钉的是「二维码就该画那张」那句；
 *    I（打分全给 9）红两条，钉的是「认不出的名字排到最后」那句。这两句别随手换成上面那三条，否则就是蒙到隔壁刀的红。
 * ③ F 与 G 看着像，其实各管一头：F 管「wlan 拿不拿最高分」，G 管「并列之后按什么排」。
 * ④ 「空着不递就是问本机」那一路（默认参数 `= networkInterfaces()`）不吃假表，真正钉住它的是冒烟那句
 *    `座位表还带着局域网地址`（tools/online-smoke.mjs：认 `lobby.lan` 非空、端口对得上、短到画得出二维码），不在刀架这一档。
 */
export default {
  id: 'lan-nets',
  title: '报哪几块网卡：回环／自编／v6／VPN 那四类都不许上二维码，剩下的按「最像连路由器那张」排',
  via: 'test',
  suite: 'test:discover',
  knives: [
    {
      rel: 'src/node/room.ts',
      note: 'A 回环那条筛选摘掉（internal）',
      from: "      if (net.family !== 'IPv4' || net.internal) continue;",
      to: "      if (net.family !== 'IPv4') continue;",
      expect: '回环那张（internal）不报：别人照着敲只能敲到自己',
    },
    {
      rel: 'src/node/room.ts',
      note: 'B 连地址类型都不看（v6 也照报）',
      from: "      if (net.family !== 'IPv4' || net.internal) continue;",
      to: '      if (net.internal) continue;',
      expect: 'v6 那条不报：寻呼那两头吃的是点分四段',
    },
    {
      rel: 'src/node/room.ts',
      note: 'C 没配上 DHCP 时自己编的那条不摘',
      from: "      if (net.address.startsWith('169.254.')) continue;",
      to: '',
      expect: '169.254 那张不报：那是没配上 DHCP 时自己编的，出不了这块网卡',
    },
    {
      rel: 'src/node/room.ts',
      note: 'D VPN／网桥／容器那串名字整条不摘',
      from: '    if (NIC_SKIP.test(name)) continue;',
      to: '',
      expect: '翻来覆去要摘的那串名字都不报：VPN／网桥／容器上的地址到不了别的设备',
    },
    {
      rel: 'src/node/room.ts',
      note: 'E 掩码不抄那块网卡上的，写死一个 /24（寻呼就此算错广播地址）',
      from: '      hits.push({ name, ip: net.address, mask: net.netmask });',
      to: "      hits.push({ name, ip: net.address, mask: '255.255.255.0' });",
      expect: '一张干净的路由器网卡：IP 和掩码一起给，掩码得是那块网卡上抄来的，寻呼算广播地址吃的就是这两样',
    },
    {
      rel: 'src/node/room.ts',
      note: 'F wlan 不当「最像连路由器那张」，跟一块叫 ath0 的口一样排到最后',
      from: "  if (m[1] === 'wlan') return 0;",
      to: "  if (m[1] === 'wlan') return 9;",
      expect: '连着路由器的那张多半是 wlan：wlan1 排在内置口 en5 之前',
    },
    {
      rel: 'src/node/room.ts',
      note: 'G 并列时不按名字，谁在网卡表里排前面算谁',
      from: "  hits.sort((a, b) => nicScore(a.name) - nicScore(b.name) || a.name.localeCompare(b.name, 'en', { numeric: true }));",
      to: '  hits.sort((a, b) => nicScore(a.name) - nicScore(b.name));',
      expect: '二维码就该画那张：wlan 与 en0 并列最前，并列时按名字排',
    },
    {
      rel: 'src/node/room.ts',
      note: 'H 按名字排却不认数字（en10 插到 en2 前头）',
      from: ".localeCompare(b.name, 'en', { numeric: true }));",
      to: ".localeCompare(b.name, 'en'));",
      expect: '序号写到两位也别按字典序排：en2 在 en10 前',
    },
    {
      rel: 'src/node/room.ts',
      note: 'I 打分一律给 9：谁都不比谁更像那张，只剩按名字排',
      from: "  return m[1] === 'en' && n === 0 ? 0 : n === 1 ? 1 : 2;",
      to: '  return 9;',
      expect: '认不出的名字一律排到最后（不摘掉，只是不占头一份）',
    },
    {
      rel: 'src/node/room.ts',
      note: 'J 某块网卡在表里是 undefined 就当场抛穿',
      from: '    for (const net of list ?? []) {',
      to: '    for (const net of list!) {',
      expect: '一块网卡压根没列（undefined）不抛，也别塞进结果',
    },
    {
      rel: 'src/node/room.ts',
      note: 'K 一块网卡上只报头一条地址（多口机器就此少一条二维码能扫的地址）',
      from: '    for (const net of list ?? []) {',
      to: '    for (const net of (list ?? []).slice(0, 1)) {',
      expect: '一块网卡上两条地址都报，谁先谁后按这块网卡自己的顺序',
    },
  ],
};
