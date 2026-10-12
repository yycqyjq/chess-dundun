package com.qdd.chessdundun;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.nio.ByteBuffer;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 扫码那一屏：全屏取景，读到一串字就把它塞进 Intent 回给 QrScanPlugin。
 *
 * 为什么这一屏归原生、不归网页：WebView 里没有 BarcodeDetector（那是 Chrome 的东西），
 * 自己塞一个 JS 解码器进去既慢又破了这一头「零依赖」的调子；而相机本来就得走原生。
 * 这一屏只管「把镜头里的东西读成一串字」——读出来的字是给谁的、能不能连，全归 JS 那边
 * （src/web/nativeScan.ts 递进 normAddr 那一套，跟手敲地址走同一条路）。
 *
 * 为什么用 CameraX 不用老的 android.hardware.Camera：老的得自己挑预览尺寸、自己管生命周期，
 * 挑错就在某些机型上直接崩；CameraX 把这些包了，PreviewView 也自己跟着屏幕转。
 *
 * 解码那一步只喂 Y 那一层（灰度就够认二维码），省掉一层色彩转换；
 * 而且**不转方向**——ZXing 的二维码检测靠找三个定位角，本来就与方向无关。
 */
public class QrScanActivity extends AppCompatActivity {

  /** 读到的那串字；没读到（人按了返回）就没有这一项 */
  public static final String EXTRA_TEXT = "text";

  private PreviewView preview;
  private ExecutorService worker;
  private final MultiFormatReader reader = new MultiFormatReader();

  /** 已经读到过一句：别让后面几帧把先到的结果盖掉 */
  private volatile boolean got = false;

  @Override
  protected void onCreate(@Nullable Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // 版面用代码摆：这一屏只有一块取景和一行字，为它单开一份 layout XML 不值
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);

    preview = new PreviewView(this);
    root.addView(
        preview,
        new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

    TextView hint = new TextView(this);
    hint.setText("把另一台设备上那张桌的二维码对进画面里\n读到就自动进桌 · 返回键退出");
    hint.setTextColor(Color.WHITE);
    hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
    hint.setGravity(Gravity.CENTER);
    hint.setPadding(48, 48, 48, 96);
    FrameLayout.LayoutParams hintLp =
        new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    hintLp.gravity = Gravity.BOTTOM;
    root.addView(hint, hintLp);

    setContentView(root);

    // 只认二维码：这张桌的码是 qr.ts 自己画的，别的格式（条形码之类）在这儿只会白算
    Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
    hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
    reader.setHints(hints);

    worker = Executors.newSingleThreadExecutor();
    startCamera();
  }

  /** 起相机：预览 ＋ 逐帧分析。起不来就当场回「没扫到」，别让人对着黑屏等 */
  private void startCamera() {
    final ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
    future.addListener(
        () -> {
          try {
            ProcessCameraProvider provider = future.get();

            Preview pv = new Preview.Builder().build();
            pv.setSurfaceProvider(preview.getSurfaceProvider());

            ImageAnalysis analysis =
                new ImageAnalysis.Builder()
                    // 只留最新那一帧：解码跟不上时宁可丢帧，也别把一队旧帧排在那儿
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build();
            analysis.setAnalyzer(worker, this::look);

            provider.unbindAll();
            provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, pv, analysis);
          } catch (Exception e) {
            // 没相机、被别的应用占着、机型不给：都算「这一趟没扫到」
            finishWith(null);
          }
        },
        ContextCompat.getMainExecutor(this));
  }

  /** 一帧进来：取 Y 那一层 → 认码。认不出就等下一帧，这不是错 */
  private void look(@NonNull ImageProxy image) {
    try {
      if (got) return;
      ImageProxy.PlaneProxy plane = image.getPlanes()[0];
      byte[] luma = lumaOf(image, plane);
      if (luma == null) return;

      int w = image.getWidth();
      int h = image.getHeight();
      PlanarYUVLuminanceSource source =
          new PlanarYUVLuminanceSource(luma, w, h, 0, 0, w, h, false);
      try {
        Result r = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(source)));
        String text = r == null ? null : r.getText();
        if (text != null && !text.isEmpty()) finishWith(text);
      } catch (Exception notFound) {
        // 这一帧里没有码（NotFoundException 最常见）：下一帧再说
      } finally {
        reader.reset();
      }
    } finally {
      image.close();
    }
  }

  /**
   * 把 Y 那一层搬成一个宽×高的紧凑数组。
   * 相机的 Y 面常常带行尾填充（`rowStride` 比宽大），直接当紧凑数组喂进去图会歪、码就认不出，
   * 所以行尾对不齐时一行一行搬。
   */
  @Nullable
  private static byte[] lumaOf(@NonNull ImageProxy image, @NonNull ImageProxy.PlaneProxy plane) {
    int w = image.getWidth();
    int h = image.getHeight();
    int rowStride = plane.getRowStride();
    if (w <= 0 || h <= 0 || rowStride < w) return null;

    ByteBuffer buf = plane.getBuffer();
    byte[] out = new byte[w * h];
    if (rowStride == w) {
      if (buf.remaining() < w * h) return null;
      buf.get(out, 0, w * h);
      return out;
    }
    byte[] row = new byte[rowStride];
    for (int r = 0; r < h; r++) {
      if (buf.remaining() < rowStride) return null;
      buf.get(row, 0, rowStride);
      System.arraycopy(row, 0, out, r * w, w);
    }
    return out;
  }

  /** 收工：text 是读到的那串字，null＝没扫到（人按了返回、或者相机起不来） */
  private void finishWith(@Nullable String text) {
    runOnUiThread(
        () -> {
          if (got) return;
          got = true;
          Intent out = new Intent();
          if (text != null) out.putExtra(EXTRA_TEXT, text);
          setResult(text == null ? Activity.RESULT_CANCELED : Activity.RESULT_OK, out);
          finish();
        });
  }

  @Override
  protected void onDestroy() {
    if (worker != null) worker.shutdown();
    super.onDestroy();
  }
}
