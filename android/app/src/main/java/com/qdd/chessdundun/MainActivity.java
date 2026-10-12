package com.qdd.chessdundun;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  /**
   * 把两个自己写的插件挂上去：
   * LanSweep——App 外壳里的「同网桌列表」靠它自己发 UDP 广播；
   * QrScan——扫码入桌那一屏靠它起相机、认二维码。
   *
   * 都得排在 super.onCreate 之前：Bridge 是在 super 里建的，插件注册要赶在那之前落到表上，
   * 之后 JS 那一侧的 Capacitor.Plugins.LanSweep / QrScan 才认得出来。
   */
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(LanSweepPlugin.class);
    registerPlugin(QrScanPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
