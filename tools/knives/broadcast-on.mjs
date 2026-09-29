/**
 * 同网寻呼「发得出去」这一档的刀谱（2026-09-29：真机上一张空清单查出来的）。
 *
 * dgram 的广播默认**关着**：`ask()` 往 255.255.255.255 和定向广播发的那 16 个包当场 EACCES，
 * 只剩回环那一路，而回环绕回来的是它自己、`isMine` 一抹 ⇒「找同网的桌」永远空。
 * 测试那头是假 socket，看不见内核这一档，所以这三把刀钉的是「开广播」「开在 bind 之后」「把真原因端出来」这三个动作本身。
 */
export default {
  id: 'broadcast-on',
  title: '寻呼绑好就把广播打开，发不出去就念真原因（不许拿「这块网不让设备互访」顶）',
  via: 'test',
  suite: 'test:discover',
  knives: [
    {
      rel: 'src/node/discover.ts',
      note: 'A 绑好不开广播（＝2026-09-29 真机上那个样子：广播那两路一个包都出不去）',
      from: "    s.bind(port, '0.0.0.0', () => s.setBroadcast(true));",
      to: "    s.bind(port, '0.0.0.0');",
      expect: '绑好就把广播打开（不开的话广播那两路一个包都出不去）',
    },
    {
      rel: 'src/node/discover.ts',
      note: 'B 发不出去的原因不记（空清单就只剩那句「多半是 AP 隔离」替内核的错误打掩护）',
      from: '            if (err && !blocked) blocked = err.message;',
      to: "            if (err && !blocked) blocked = '';",
      expect: '广播真发不出去：说一句真原因，别拿「这块网不让设备之间互访」顶',
    },
    {
      rel: 'src/node/discover.ts',
      note: 'C 开广播排在 bind 之前（真 socket 上这是 EBADF，等于没开）',
      from: "    s.bind(port, '0.0.0.0', () => s.setBroadcast(true));",
      to: "    s.setBroadcast(true);\n    s.bind(port, '0.0.0.0');",
      expect: '开广播排在 bind 之后（bind 之前调是 EBADF）',
    },
  ],
};
