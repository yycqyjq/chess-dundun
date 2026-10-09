# 发布口径

三端产物统一落在 `release/`：mac 的 dmg、win 的 exe、安卓的 apk。发布是一条命令的事：

```bash
npm run release -- --patch        # 0.3.2 → 0.3.3（--minor / --major / --version=x.y.z 也认）
```

脚本（`tools/release.mjs`）做的事，按序：

1. 工作区必须干净（版本号那一笔要落在干净历史上），否则当场拒
2. 改 `package.json` 的版本号——vite 的首页版本行、安卓的 `versionName`/`versionCode` 都从这儿读，只养这一份
3. `npm run verify`（类型 + 规则自检 + 全部套件），不是绿的当场停
4. `npm run build` + `desktop:mac` + `desktop:win` + `apk:release` 三端出包（`--skip=mac,win,apk` 可跳）
5. 提交「版本号 A → B」并打 `v` 对应的 tag（`--no-tag` 可关）
6. **不自动推送**：`git push --follow-tags` 手动来

`--dry-run` 只打印每一步要干什么，什么都不动。

## 版本号口径

pre-1.0 阶段走 minor：加一档玩法/大功能升 minor（0.2.0 → 0.3.0 那两次），修与调优走 patch。

## 安卓正式签名

APK 的 `versionName`/`versionCode` 从 package.json 现读（gradle 按 semver 摊成整数码）。release 包要正式签名时：

```bash
keytool -genkeypair -v -keystore ~/qdd-release.keystore -alias qdd -keyalg RSA -keysize 2048 -validity 10000
```

然后在 `android/keystore.properties`（**不进仓库**，`storeFile` 可以指到仓库外）写四行：

```
storeFile=/Users/你/qdd-release.keystore
storePassword=……
keyAlias=qdd
keyPassword=……
```

没有这份文件时，`apk:release` 自动退回 debug 签名——装得上、能玩，只是别当正式分发件。keystore 丢了，这个身份的包就再也没法升级安装，备份好。

## CI

push / PR 会自动跑 `npm run verify` + `npm run build` + `npm run smoke`（`.github/workflows/ci.yml`，electron 二进制跳过下载）。刀架（298 把）太重，不上 CI，留在本机按批跑。
