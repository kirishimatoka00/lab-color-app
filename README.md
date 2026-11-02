# Lab Gamut Simulator（Lab 色域模擬器）

在 Lab 色彩空間中輸入 Base / History / Test 點，即時以 3D 與 2D 檢視色域範圍、ΔE 與色域修正量。支援 Excel 匯入／匯出、相機取色，並可打包成 Android APK 安裝在手機上。

## 在手機上安裝 APK

1. 到本 repo 的 **Releases** 頁面，下載最新的 `lab-color-app.apk`（標籤為 `latest`）。
2. 用手機開啟下載的 APK，依提示允許「安裝未知來源應用程式」後安裝。
3. 之後有新版本時直接下載新的 APK 覆蓋安裝即可（簽章固定，資料不會消失）。

APK 由 GitHub Actions 自動建置：每次推送到 `main`，或在 **Actions → Build Android APK → Run workflow** 手動執行，都會產生新的 APK。建置約需 5～10 分鐘。

> 這個 APK 使用 repo 內公開的固定 keystore（`android/keystore/debug.keystore`）簽署，僅供個人／內部自用，不適合上架 Google Play。

## 手機版面

- 手機（寬度小於 768px）：底部分頁切換 **Points（資料）** 與 **Viewer（視圖）**；視圖右上角的全螢幕按鈕可放大單一視圖。
- 平板與桌機：維持左右並排。
- 匯出 Excel／儲存截圖：在 APK 內會開啟系統分享面板，可儲存到檔案、雲端硬碟或傳給其他 App。

## 相機取色

- **範圍平均取色**：畫面上有明確的白色範圍框，框內所有像素以「線性光」平均後轉成 Lab（和色彩量測儀器同樣的算法），框外會變暗。底部「Area」滑桿可調整範圍大小（3%～40%，會記住上次設定），並顯示取樣的像素大小與範圍內顏色是否均勻（Uniform / Slight variation / Uneven）。
- **鏡頭與變焦**：手機有多個後鏡頭時，畫面下方會出現 `Lens 1 / 2 / 3` 按鈕切換鏡頭，預設使用編號最小的後鏡頭（通常是 1x 主鏡頭），選擇會被記住；鏡頭支援變焦時另有 `0.5x / 1x / 2x…` 按鈕，開啟時預設回到 1x。畫面底部會顯示目前鏡頭的名稱。
- **相簿取色**：從相簿選圖後，點選或拖曳即可移動範圍框，範圍框同樣會取區域平均。

## 材質欄位

每個點（Base / History / Test）除了 Name、L、a、b 之外，都可以記錄 **Material（材質）**，輸入時會列出先前輸入過的材質供快速選擇。Excel 匯出會多一欄 `Material`；匯入時讀取 `Material`（或中文欄名「材質」），沒有這一欄也可以正常匯入。

## In Gamut 判定與 Correction A / B / C

視圖右上角的 **View Settings**（滑桿圖示）可選擇 **Gamut Mode**：

- **Projection**（預設）：假設 a,b 不隨 L 改變，以 Base + History 在 a-b 平面的投影範圍判定，ΔL 恆為 0。
- **Slice by L**：以 Test Point 同一 L 的 a-b 截面判定，更貼近實際色域在高亮／低亮處收窄的情形；L 超出 Gamut 的 L 範圍時，A、B 會先移到最近可用的 L。

Test Point 在範圍外時，卡片下方列出三種修正（皆顯示 L、a、b 與 ΔL / Δa / Δb / ΔC / ΔH / ΔE）：

- **A**：Chroma 維持、調整 Hue，取最接近且在 Gamut 內的 a,b。
- **B**：Hue 維持、降低 Chroma，取剛好落在 Gamut 內的 a,b。
- **C（建議）**：最小 ΔE。Projection 模式＝同 L 下 a-b 平面上最近的點；Slice 模式＝保持 Hue、L 與 Chroma 皆可調的最近點（HPMINDE）。

某個修正在該條件下無解時顯示 N/A。3D / 2D 視圖會用虛線把 Test Point 連到 A（橘）、B（青）、C（綠）的目標點，可在 View Settings 關閉。

## 材質分組與篩選

View Settings 內列出所有出現過的材質：點選標籤可在視圖中隱藏／顯示該材質的點（只影響顯示，不影響 Gamut 計算），**Color by Material** 可改用材質顏色標示各點。

## 匯出／匯入

標題列有四個按鈕：

- **Export Excel**：匯出 `lab_gamut_data.xlsx`，每個工作表（Base / History / Test Points）含 `Name、Material、L、a、b`，格式與 Excel 匯入相同，可直接再匯入。Test Points 工作表另有 `InGamut` 與 `A_L/A_a/A_b`、`B_*`、`C_*` 修正結果欄位（匯入時忽略）。
- **Export 全部資料與設定（.json）**：匯出 `lab_gamut_backup_時間.json`，包含 Base / History / Test 全部資料點（含材質、顯示與標準點狀態）與設定（色域顏色 L、透明度、標籤顯示、視圖模式、Gamut Mode、修正點顯示、材質篩選與配色、相機取樣範圍），另附 `corrections`（In Gamut 狀態與 A/B/C 修正結果，僅供參考）。
- **Import 備份（.json）**：讀回上述 JSON，會取代目前所有資料與設定（匯入前會確認）。
- **Import Excel**：維持原本行為，把資料點加到現有清單。

## 本機開發

需要 Node.js 22 以上。

```bash
npm install
npm run dev        # 開發伺服器
npm run build      # 打包網頁到 dist/
```

## 本機建置 APK（選用）

需要 JDK 21 與 Android SDK（或直接用 Android Studio）。

```bash
npm run android:sync          # 打包網頁並同步到 android/
cd android && ./gradlew assembleDebug
# 輸出：android/app/build/outputs/apk/debug/app-debug.apk
```

## 專案結構

| 路徑 | 說明 |
| --- | --- |
| `src/main.jsx` | 應用程式主體（React + react-three-fiber） |
| `src/index.css` | Tailwind 與全域樣式 |
| `capacitor.config.json` | Capacitor 設定（App 名稱、ID、狀態列） |
| `android/` | Capacitor 產生的 Android 專案（相機權限、簽章、圖示已設定） |
| `.github/workflows/build-apk.yml` | 自動建置 APK 並發佈到 Releases |
