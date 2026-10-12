package com.qdd.chessdundun;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;

/**
 * 让 App 外壳自己发同网寻呼。
 *
 * 浏览器里那一屏「同网桌列表」靠的是本机宿主进程代跑 UDP 广播（一句 find 递过去，由 Node 那边
 * 朝八槽发口令、把回包递回来）。App 外壳里没有那个宿主，WebView 也发不出 UDP，所以那一屏
 * 原来只能退化成手填地址。这个插件把那件事自己干了：拿网卡、发广播、收回包。
 *
 * 只干「搬字节」这一件：口令长什么样、往哪八槽发、广播地址怎么算、回包怎么认，全住在
 * src/net/discover.ts，跟电脑那一头同一份。这儿报的是原料（网卡、回包），不做判断。
 */
@CapacitorPlugin(name = "LanSweep")
public class LanSweepPlugin extends Plugin {

  /**
   * 本机网卡：{ ip, mask }。mask 是点分四段（255.255.255.0 这种），跟 discover.ts 的
   * targetsFor 吃的那一味对齐——算广播地址那套（哪块网该发、/31 与 /32 为什么不算、
   * 回环与全网广播怎么加）全在 JS 那一份里，这儿只报料。
   */
  @PluginMethod
  public void networks(PluginCall call) {
    JSArray nets = new JSArray();
    try {
      Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
      for (NetworkInterface nif : Collections.list(ifaces)) {
        if (!nif.isUp() || nif.isLoopback()) continue;
        for (InterfaceAddress ia : nif.getInterfaceAddresses()) {
          InetAddress addr = ia.getAddress();
          if (addr == null) continue;
          // 只要点分四段：寻呼那两头吃的是 IPv4，v6 那条在这儿没有用处
          if (addr.getAddress() == null || addr.getAddress().length != 4) continue;
          if (addr.isLoopbackAddress() || addr.isLinkLocalAddress()) continue;
          JSObject one = new JSObject();
          one.put("ip", addr.getHostAddress());
          one.put("mask", prefixToMask(ia.getNetworkPrefixLength()));
          nets.put(one);
        }
      }
    } catch (Exception e) {
      call.reject("枚举网卡失败：" + e.getMessage());
      return;
    }
    JSObject out = new JSObject();
    out.put("nets", nets);
    call.resolve(out);
  }

  /**
   * 往 targets 上每个地址 × ports 里每个端口发一遍 text，再把 waitMs 毫秒内收到的回包全捞回来。
   * 返回 { replies: [{ text, ip }] }：ip 是回包那个来源地址（discover.ts 的 parseOffer 要用它）。
   *
   * 网络那一套全在后台线程：Android 主线程不许碰 socket。call.resolve / call.reject 本身是
   * 线程安全的，Capacitor 自己会把它送回 JS 那一侧。
   */
  @PluginMethod
  public void sweep(PluginCall call) {
    JSArray targetsArg = call.getArray("targets");
    JSArray portsArg = call.getArray("ports");
    String text = call.getString("text", "");
    Integer waitArg = call.getInt("waitMs", 700);

    if (targetsArg == null || portsArg == null || text.isEmpty()) {
      call.reject("sweep 缺 targets / ports / text");
      return;
    }

    final List<Object> rawTargets;
    final List<Object> rawPorts;
    try {
      rawTargets = targetsArg.toList();
      rawPorts = portsArg.toList();
    } catch (Exception e) {
      call.reject("sweep 的 targets / ports 读不出来：" + e.getMessage());
      return;
    }
    if (rawTargets.isEmpty() || rawPorts.isEmpty()) {
      // 一块网卡都算不出广播地址时就是这样：没地方可发，直接回个空的，别让人对着转圈
      JSObject out = new JSObject();
      out.put("replies", new JSArray());
      call.resolve(out);
      return;
    }

    final String payload = text;
    final int wait = waitArg == null ? 700 : waitArg;

    new Thread(
        () -> {
          JSArray replies = new JSArray();
          DatagramSocket socket = null;
          try {
            socket = new DatagramSocket();
            socket.setBroadcast(true);
            byte[] data = payload.getBytes(StandardCharsets.UTF_8);
            for (Object t : rawTargets) {
              if (t == null) continue;
              InetAddress to = InetAddress.getByName(String.valueOf(t));
              for (Object p : rawPorts) {
                if (p == null) continue;
                int port = Integer.parseInt(String.valueOf(p));
                socket.send(new DatagramPacket(data, data.length, to, port));
              }
            }
            long deadline = System.currentTimeMillis() + wait;
            while (true) {
              long left = deadline - System.currentTimeMillis();
              if (left <= 0) break;
              socket.setSoTimeout((int) Math.max(1L, left));
              byte[] buf = new byte[1024];
              DatagramPacket in = new DatagramPacket(buf, buf.length);
              try {
                socket.receive(in);
              } catch (SocketTimeoutException e) {
                break;
              }
              JSObject one = new JSObject();
              one.put("text", new String(in.getData(), 0, in.getLength(), StandardCharsets.UTF_8));
              one.put("ip", in.getAddress().getHostAddress());
              replies.put(one);
            }
          } catch (Exception e) {
            call.reject("寻呼失败：" + e.getMessage());
            return;
          } finally {
            if (socket != null) socket.close();
          }
          JSObject out = new JSObject();
          out.put("replies", replies);
          call.resolve(out);
        },
        "qdd-lan-sweep")
        .start();
  }

  /** 前缀长度（24）转点分掩码（255.255.255.0）。越界就退回全 1，让 JS 那边按「算不出广播」处理。 */
  private static String prefixToMask(int prefix) {
    if (prefix < 0 || prefix > 32) return "255.255.255.255";
    long m = prefix == 0 ? 0L : (0xFFFFFFFFL << (32 - prefix)) & 0xFFFFFFFFL;
    return ((m >> 24) & 0xFF) + "." + ((m >> 16) & 0xFF) + "." + ((m >> 8) & 0xFF) + "." + (m & 0xFF);
  }
}
