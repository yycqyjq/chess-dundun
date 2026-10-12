package com.qdd.chessdundun;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

/**
 * 让 App 外壳自己扫一张二维码，把读到的那串字递给 JS。
 *
 * 为什么要有它：候场厅里那张码本来就是给别的设备扫的（`qrCanvas` 画的是 `inviteUrls()` 第一条），
 * 可原来只有「用系统相机/微信扫了再开浏览器」这一条路；App 里想进另一台设备上那张桌，
 * 只能靠手填地址。这个插件补的就是这一格。
 *
 * 只干「把镜头里的东西读成一串字」这一件：那串字是不是一张桌、能不能连，全归 JS
 * （src/web/nativeScan.ts → home.ts 的 normAddr，跟手敲地址走同一条路，一把尺子量两遍）。
 * 分工跟 LanSweepPlugin 一个调子：原生只搬料，判断留在有闸的那一侧。
 *
 * 相机那一屏在 QrScanActivity 里；这一层只管权限与来回。
 */
@CapacitorPlugin(
    name = "QrScan",
    permissions = {@Permission(alias = "camera", strings = {Manifest.permission.CAMERA})})
public class QrScanPlugin extends Plugin {

  /**
   * 扫一次。回来的是 { text }：
   * `text` 是读到的那串字；人按了返回、或者相机起不来时是 `null`（**不是 reject**——
   * 「这一趟没扫到」是正常结果，跟「这件事压根办不成」不是一回事，别让 JS 那一头去 catch）。
   * 权限没给才是 reject：那是要人去设置里点一下的事，得说清楚。
   */
  @PluginMethod
  public void scan(PluginCall call) {
    if (getPermissionState("camera") != PermissionState.GRANTED) {
      requestPermissionForAlias("camera", call, "cameraBack");
      return;
    }
    openScanner(call);
  }

  /** 权限那一趟回来：给了就接着扫，没给就把话说明白 */
  @PermissionCallback
  private void cameraBack(PluginCall call) {
    if (getPermissionState("camera") != PermissionState.GRANTED) {
      call.reject("没给相机权限：扫不了码");
      return;
    }
    openScanner(call);
  }

  private void openScanner(PluginCall call) {
    Intent intent = new Intent(getContext(), QrScanActivity.class);
    startActivityForResult(call, intent, "scanned");
  }

  /**
   * 那一屏回来了：读到就是那串字，没读到就是 null。
   *
   * `call == null` 是一格**只能 no-op** 的分支：Capacitor 在进程被系统回收之后重建 Bridge 时，
   * 拿不回当初那个 call，这一格就回不了话（`call.resolve` / `call.reject` 都得有个 call）。
   * 所以这儿只能记一笔日志，别静默——真在 logcat 里看见它，就说明有一趟扫码的回话丢了。
   * JS 那一头另有一道「同一时刻只起一趟」的闸（`src/web/nativeScan.ts`），
   * 双击那颗按钮不会再叠出第二趟来撞这一格。
   */
  @ActivityCallback
  private void scanned(PluginCall call, ActivityResult result) {
    if (call == null) {
      Log.w("QrScan", "这一趟扫码的回话丢了（Bridge 重建后拿不回 PluginCall），没处可回");
      return;
    }
    String text = null;
    if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
      text = result.getData().getStringExtra(QrScanActivity.EXTRA_TEXT);
    }
    JSObject out = new JSObject();
    // 用 JSONObject.NULL 而不是裸 null：JSObject 底下是 JSONObject，put 一个 null 是把键**删掉**，
    // 那样 JS 收到的是 {}，`res.text` 变成 undefined——虽然那一头也当「没扫到」处理，
    // 但「没扫到」和「这一版压根没这个字段」就分不出来了。
    out.put("text", text == null ? JSONObject.NULL : text);
    call.resolve(out);
  }
}
