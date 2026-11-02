import React, { useState, useMemo, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, MapControls, Text, Html, Billboard, Line } from '@react-three/drei';
import * as THREE from 'three';
import * as XLSX from '@e965/xlsx';
import './index.css';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry';
import { Plus, Trash2, RotateCcw, Info, Box, Camera, Maximize, Minimize, Tag, Eye, EyeOff, LayoutTemplate, Square, Circle, Target, X, Aperture, Upload, Image as ImageIcon, CornerRightDown, FileSpreadsheet, Download, CheckSquare as CheckSquareIcon, SlidersHorizontal, Sun, Droplet, List, FileDown, FileUp } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import robotoFontUrl from '@fontsource/roboto/files/roboto-latin-700-normal.woff?url';

// 3D 標籤字型改用本機打包的檔案（drei 預設會從網路 CDN 下載，離線時整個畫布會卡住）
const LABEL_FONT = new URL(robotoFontUrl, document.baseURI).href;

/**
 * 檔案儲存：
 * - Android APK（Capacitor 原生）：WebView 不支援 <a download>，改為寫入快取後呼叫系統分享面板
 *   （可選擇「儲存到雲端硬碟 / 檔案」、LINE、Email 等）。
 * - 一般瀏覽器：沿用原本的下載行為。
 * dataBase64 為不含 data: 前綴的 base64 字串。
 */
const saveFile = async (fileName, dataBase64, mimeType) => {
    if (Capacitor.isNativePlatform()) {
        const written = await Filesystem.writeFile({ path: fileName, data: dataBase64, directory: Directory.Cache });
        await Share.share({ title: fileName, url: written.uri, dialogTitle: fileName });
        return;
    }
    const bytes = Uint8Array.from(atob(dataBase64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    const link = document.createElement('a');
    link.download = fileName;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/**
 * Math & Color Utility Functions
 */
const ColorUtils = {
    clamp: (num, min, max) => Math.min(Math.max(num, min), max),

    // Lab to XYZ
    labToXyz: (l, a, b) => {
        let y = (l + 16) / 116;
        let x = a / 500 + y;
        let z = y - b / 200;

        const targetX = 0.95047;
        const targetY = 1.00000;
        const targetZ = 1.08883;

        const pow3 = (v) => {
            return (v > 0.206893034) ? v * v * v : (v - 16 / 116) / 7.787;
        };

        const X = targetX * pow3(x);
        const Y = targetY * pow3(y);
        const Z = targetZ * pow3(z);

        return [X, Y, Z];
    },

    // XYZ to Linear RGB
    xyzToRgbLinear: (x, y, z) => {
        const rLinear = x * 3.2406 + y * -1.5372 + z * -0.4986;
        const gLinear = x * -0.9689 + y * 1.8758 + z * 0.0415;
        const bLinear = x * 0.0557 + y * -0.2040 + z * 1.0570;
        return [rLinear, gLinear, bLinear];
    },

    // XYZ to RGB (sRGB) [0-255]
    xyzToRgb: (x, y, z) => {
        const [rL, gL, bL] = ColorUtils.xyzToRgbLinear(x, y, z);
        
        const adjust = (v) => {
            return v > 0.0031308
                ? 1.055 * Math.pow(v, 1.0 / 2.4) - 0.055
                : 12.92 * v;
        };

        const R = Math.round(ColorUtils.clamp(adjust(rL), 0, 1) * 255);
        const G = Math.round(ColorUtils.clamp(adjust(gL), 0, 1) * 255);
        const B = Math.round(ColorUtils.clamp(adjust(bL), 0, 1) * 255);

        return `rgb(${R}, ${G}, ${B})`;
    },

    // RGB (0-255) to Lab
    rgbToLab: (r, g, b) => {
        let R = r / 255;
        let G = g / 255;
        let B = b / 255;

        R = (R > 0.04045) ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
        G = (G > 0.04045) ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
        B = (B > 0.04045) ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;

        let X = R * 0.4124 + G * 0.3576 + B * 0.1805;
        let Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
        let Z = R * 0.0193 + G * 0.1192 + B * 0.9505;

        const refX = 0.95047;
        const refY = 1.00000;
        const refZ = 1.08883;

        X = X / refX;
        Y = Y / refY;
        Z = Z / refZ;

        const f = (val) => (val > 0.008856) ? Math.pow(val, 1/3) : (7.787 * val) + (16/116);

        const fx = f(X);
        const fy = f(Y);
        const fz = f(Z);

        const L = (116 * fy) - 16;
        const a = 500 * (fx - fy);
        const B_lab = 200 * (fy - fz);

        return {
            l: Math.round(L * 10) / 10,
            a: Math.round(a * 10) / 10,
            b: Math.round(B_lab * 10) / 10
        };
    },

    // Helper: Lab to [r,g,b] normalized (0-1)
    labToRgbNormalized: (l, a, b) => {
        const [x, y, z] = ColorUtils.labToXyz(l, a, b);
        const [rL, gL, bL] = ColorUtils.xyzToRgbLinear(x, y, z);
        
        const adjust = (v) => {
            return v > 0.0031308
                ? 1.055 * Math.pow(v, 1.0 / 2.4) - 0.055
                : 12.92 * v;
        };

        return [
            ColorUtils.clamp(adjust(rL), 0, 1),
            ColorUtils.clamp(adjust(gL), 0, 1),
            ColorUtils.clamp(adjust(bL), 0, 1)
        ];
    },

    labToHex: (l, a, b) => {
        const [x, y, z] = ColorUtils.labToXyz(l, a, b);
        return ColorUtils.xyzToRgb(x, y, z);
    },

    calculateDeltaE: (p1, p2) => {
        const dL = p1.l - p2.l;
        const da = p1.a - p2.a;
        const db = p1.b - p2.b;
        return Math.sqrt(dL * dL + da * da + db * db).toFixed(2);
    }
};

/**
 * Gamut Calculation Utilities
 */
const GamutUtils = {
    // 2D 凸包（Monotone chain），回傳逆時針多邊形
    hull2D: (input) => {
        const pts = input.map(q => [q[0], q[1]]).sort((u, w) => u[0] - w[0] || u[1] - w[1]);
        if (pts.length < 3) return pts;
        const cross = (o, p1, p2) => (p1[0] - o[0]) * (p2[1] - o[1]) - (p1[1] - o[1]) * (p2[0] - o[0]);
        const lower = [];
        for (const q of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-12) lower.pop(); lower.push(q); }
        const upper = [];
        for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-12) upper.pop(); upper.push(q); }
        lower.pop(); upper.pop();
        return lower.concat(upper);
    },
    insidePoly: (poly, x, y) => {
        const n = poly.length;
        if (n < 3) return false;
        return poly.every((P, i) => { const Q = poly[(i + 1) % n]; return (Q[0] - P[0]) * (y - P[1]) - (Q[1] - P[1]) * (x - P[0]) >= -1e-9; });
    },
    // 多邊形（含邊界）上離 (x,y) 最近的點
    nearestOnPoly: (poly, x, y) => {
        let best = null, bd = Infinity;
        const n = poly.length;
        for (let i = 0; i < n; i++) {
            const P = poly[i], Q = poly[(i + 1) % n];
            const dx = Q[0] - P[0], dy = Q[1] - P[1];
            const len2 = dx * dx + dy * dy;
            let t = len2 < 1e-12 ? 0 : ((x - P[0]) * dx + (y - P[1]) * dy) / len2;
            t = Math.max(0, Math.min(1, t));
            const cx = P[0] + t * dx, cy = P[1] + t * dy;
            const d = (cx - x) ** 2 + (cy - y) ** 2;
            if (d < bd) { bd = d; best = [cx, cy]; }
        }
        return best;
    },
    // 模式 projection：假設 a,b 不隨 L 改變，取 Gamut 頂點投影到 a-b 平面的凸包
    projectAB: (mesh) => {
        const pos = mesh.geometry.attributes.position;
        const pts = [];
        for (let i = 0; i < pos.count; i++) pts.push([pos.getX(i), pos.getZ(i)]); // X=a, Z=b
        const hull = GamutUtils.hull2D(pts);
        return hull.length >= 3 ? hull : null;
    },
    // 取三角形各邊與一個「函數 f=0」平面的交點；f(P) 為頂點 [a,L,b] 到平面的帶號距離，out(P) 轉成 2D 座標
    _planeSection: (mesh, f, out) => {
        const pos = mesh.geometry.attributes.position;
        const idx = mesh.geometry.index ? mesh.geometry.index.array : null;
        const triCount = idx ? idx.length / 3 : pos.count / 3;
        const EPS = 1e-9;
        const pts = [];
        const vert = (n) => { const i = idx ? idx[n] : n; return [pos.getX(i), pos.getY(i), pos.getZ(i)]; };
        for (let t = 0; t < triCount; t++) {
            const v = [vert(t * 3), vert(t * 3 + 1), vert(t * 3 + 2)];
            for (let i = 0; i < 3; i++) {
                const P = v[i], Q = v[(i + 1) % 3];
                const fp = f(P), fq = f(Q);
                if (Math.abs(fp) < EPS) pts.push(out(P));
                if (fp * fq < 0) {
                    const k = fp / (fp - fq);
                    pts.push(out([P[0] + k * (Q[0] - P[0]), P[1] + k * (Q[1] - P[1]), P[2] + k * (Q[2] - P[2])]));
                }
            }
        }
        if (pts.length < 3) return null;
        const hull = GamutUtils.hull2D(pts);
        return hull.length >= 3 ? hull : null;
    },
    // 模式 slice：Gamut 在固定 L 的 a-b 截面
    sliceAtL: (mesh, L) => GamutUtils._planeSection(mesh, (P) => P[1] - L, (P) => [P[0], P[2]]),
    // 通過 L 軸、色相為 H 的半平面截面，座標為 [Chroma, L]（只保留 Chroma >= 0）
    sliceAtHue: (mesh, H) => {
        const ch = Math.cos(H), sh = Math.sin(H);
        const full = GamutUtils._planeSection(mesh, (P) => -P[0] * sh + P[2] * ch, (P) => [P[0] * ch + P[2] * sh, P[1]]);
        if (!full) return null;
        const out = [];
        const n = full.length;
        for (let i = 0; i < n; i++) {
            const P = full[i], Q = full[(i + 1) % n];
            const inP = P[0] >= 0, inQ = Q[0] >= 0;
            if (inP) out.push(P);
            if (inP !== inQ) { const k = P[0] / (P[0] - Q[0]); out.push([0, P[1] + k * (Q[1] - P[1])]); }
        }
        return out.length >= 1 ? out : null;
    },

    // 判定 In Gamut，並計算三種修正：
    //  A：Chroma 維持、調整 Hue 到最接近且在 Gamut 內的 a,b（同 L）
    //  B：Hue 維持、降低 Chroma 到剛好在 Gamut 內的 a,b（同 L）
    //  C：最小 ΔE（建議）。projection 模式＝同 L 下 a-b 平面最近點；
    //     slice 模式＝保持 Hue、L 與 Chroma 皆可調的最近點（HPMINDE）
    // mode='projection'：假設 a,b 不隨 L 改變，ΔL 恆為 0；mode='slice'：使用同 L 截面，L 超出範圍時先移到最近可用 L
    calculateCorrections: (pt, mesh, mode = 'projection') => {
        if (!mesh || !mesh.geometry || !pt) return null;
        const slice = mode === 'slice';
        let Lc = pt.l, lInRange = true;
        if (slice) {
            const pos = mesh.geometry.attributes.position;
            let minL = Infinity, maxL = -Infinity;
            for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); if (y < minL) minL = y; if (y > maxL) maxL = y; }
            lInRange = pt.l >= minL && pt.l <= maxL;
            const margin = Math.min(0.05, (maxL - minL) / 4);
            Lc = lInRange ? pt.l : Math.min(maxL - margin, Math.max(minL + margin, pt.l));
        }
        const poly = slice ? GamutUtils.sliceAtL(mesh, Lc) : GamutUtils.projectAB(mesh);
        if (!poly) return { isInside: false, noSlice: true };

        const inside = GamutUtils.insidePoly(poly, pt.a, pt.b);
        if (lInRange && inside) return { isInside: true };

        const C = Math.hypot(pt.a, pt.b);
        const H = Math.atan2(pt.b, pt.a);
        const hueDeg = (rad) => { const d = rad * 180 / Math.PI; return d < 0 ? d + 360 : d; };
        const make = (l, a, b) => {
            let dh = hueDeg(Math.atan2(b, a)) - hueDeg(H);
            dh = ((dh + 540) % 360) - 180;
            const dl = l - pt.l, da = a - pt.a, db = b - pt.b;
            return { l, a, b, dl, da, db, dC: Math.hypot(a, b) - C, dH: C < 1e-6 ? 0 : dh, dE: Math.sqrt(dl * dl + da * da + db * db) };
        };
        const wrap = (x) => { let d = x; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
        const n = poly.length;

        // C：最小 ΔE
        let Cc = null;
        if (slice) {
            const hp = GamutUtils.sliceAtHue(mesh, H);
            if (hp) { const q = GamutUtils.nearestOnPoly(hp, C, pt.l); if (q) Cc = make(q[1], q[0] * Math.cos(H), q[0] * Math.sin(H)); }
        } else {
            const q = GamutUtils.nearestOnPoly(poly, pt.a, pt.b);
            if (q) Cc = make(Lc, q[0], q[1]);
        }

        // L 超出範圍但 a,b 已在該截面內：A、B 只需調整 L
        if (inside) { const same = make(Lc, pt.a, pt.b); return { isInside: false, A: same, B: same, C: Cc }; }

        // A：與半徑 C 的圓相交的各邊交點，取色相角最近者
        let A = null;
        if (C > 1e-6) {
            let bestAng = null, bestDiff = Infinity;
            for (let i = 0; i < n; i++) {
                const P = poly[i], Q = poly[(i + 1) % n];
                const dx = Q[0] - P[0], dy = Q[1] - P[1];
                const qa = dx * dx + dy * dy, qb = 2 * (P[0] * dx + P[1] * dy), qc = P[0] * P[0] + P[1] * P[1] - C * C;
                if (qa < 1e-12) continue;
                const disc = qb * qb - 4 * qa * qc;
                if (disc < 0) continue;
                const sq = Math.sqrt(disc);
                for (const t of [(-qb - sq) / (2 * qa), (-qb + sq) / (2 * qa)]) {
                    if (t < -1e-9 || t > 1 + 1e-9) continue;
                    const ang = Math.atan2(P[1] + t * dy, P[0] + t * dx);
                    const diff = Math.abs(wrap(ang - H));
                    if (diff < bestDiff) { bestDiff = diff; bestAng = ang; }
                }
            }
            if (bestAng !== null) A = make(Lc, C * Math.cos(bestAng), C * Math.sin(bestAng));
        }

        // B：沿原色相的射線與截面相交，取半徑 ≤ C 的最大值
        let B = null;
        if (C > 1e-6) {
            const d = [Math.cos(H), Math.sin(H)];
            let rLo = 0, rHi = Infinity, empty = false;
            for (let i = 0; i < n; i++) {
                const P = poly[i], Q = poly[(i + 1) % n];
                const e = [Q[0] - P[0], Q[1] - P[1]];
                const ced = e[0] * d[1] - e[1] * d[0];
                const cep = e[0] * P[1] - e[1] * P[0];
                if (Math.abs(ced) < 1e-12) { if (-cep < -1e-9) empty = true; }
                else if (ced > 0) rLo = Math.max(rLo, cep / ced);
                else rHi = Math.min(rHi, cep / ced);
            }
            if (!empty && rLo <= rHi + 1e-9 && rLo < C) {
                const r = Math.min(C, rHi);
                B = make(Lc, r * d[0], r * d[1]);
            }
        }
        return { isInside: false, A, B, C: Cc };
    }
};

/**
 * Camera Color Picker
 */
/**
 * 範圍平均取色
 * 以「線性光」平均再轉回 sRGB（與色彩量測儀器相同的做法），比直接平均 sRGB 數值更準確。
 */
const SRGB_TO_LINEAR = (() => {
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const c = i / 255; lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    return lut;
})();
const linearToSrgb255 = (v) => {
    const c = Math.min(Math.max(v, 0), 1);
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
};

// 回傳平均 RGB（0-255）與 spread（範圍內各通道標準差的均方根，越小代表範圍內顏色越均勻）
const averageRegion = (ctx, w, h) => {
    const data = ctx.getImageData(0, 0, w, h).data;
    let lr = 0, lg = 0, lb = 0, sr = 0, sg = 0, sb = 0, qr = 0, qg = 0, qb = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        lr += SRGB_TO_LINEAR[r]; lg += SRGB_TO_LINEAR[g]; lb += SRGB_TO_LINEAR[b];
        sr += r; sg += g; sb += b; qr += r * r; qg += g * g; qb += b * b;
        n++;
    }
    if (!n) return { r: 0, g: 0, b: 0, spread: 0 };
    const varOf = (s, q) => Math.max(q / n - (s / n) * (s / n), 0);
    const spread = Math.sqrt((varOf(sr, qr) + varOf(sg, qg) + varOf(sb, qb)) / 3);
    return { r: linearToSrgb255(lr / n), g: linearToSrgb255(lg / n), b: linearToSrgb255(lb / n), spread };
};

// 在來源（video 或 img）以 (cx, cy) 為中心、邊長 side（來源像素）的正方形範圍內取平均色
const sampleRegion = (canvas, source, W, H, cx, cy, side) => {
    side = Math.max(2, Math.min(side, W, H));
    const x0 = Math.min(Math.max(cx - side / 2, 0), W - side);
    const y0 = Math.min(Math.max(cy - side / 2, 0), H - side);
    const out = Math.max(2, Math.min(Math.round(side), 192)); // 範圍很大時縮小取樣以維持流暢
    canvas.width = out; canvas.height = out;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, x0, y0, side, side, 0, 0, out, out);
    return { ...averageRegion(ctx, out, out), area: Math.round(side) };
};

// 找出所有後置鏡頭，依 Android camera2 編號由小到大排序（編號最小的通常是 1x 主鏡頭）
const listBackCameras = (devices) => {
    const cams = devices.filter(d => d.kind === 'videoinput');
    let backs = cams.filter(d => /back|rear|environment/i.test(d.label));
    if (backs.length === 0) backs = cams.filter(d => !/front|user/i.test(d.label));
    const idOf = (d) => { const m = /camera\d*\s+(\d+)/i.exec(d.label); return m ? parseInt(m[1], 10) : 1e9; };
    return [...backs].sort((a, b) => idOf(a) - idOf(b));
};

const ZOOM_PRESETS = [0.5, 1, 2, 3, 5, 10];

// 取色範圍框：框內就是實際取平均的範圍，框外變暗
const RoiBox = ({ side, style }) => (
    <div
        className="absolute pointer-events-none"
        style={{ width: side, height: side, border: '2px solid #fff', boxSizing: 'border-box', boxShadow: '0 0 0 1px rgba(0,0,0,0.65), 0 0 0 9999px rgba(0,0,0,0.5)', ...style }}
    >
        <div className="absolute left-1/2 top-1/2 w-1 h-1 -ml-0.5 -mt-0.5 rounded-full bg-white/80" />
    </div>
);

const CameraPicker = ({ onCapture, onClose }) => {
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const imgRef = useRef(null);
    const fileInputRef = useRef(null);
    const viewRef = useRef(null);
    const streamRef = useRef(null);
    const aliveRef = useRef(true);
    const draggingRef = useRef(false);

    const [color, setColor] = useState({ r: 0, g: 0, b: 0 });
    const [lab, setLab] = useState({ l: 0, a: 0, b: 0 });
    const [info, setInfo] = useState({ area: 0, spread: 0 });
    const [stream, setStream] = useState(null);
    const [error, setError] = useState('');
    const [imageMode, setImageMode] = useState(false);
    const [uploadedImgSrc, setUploadedImgSrc] = useState(null);
    const [pointerPos, setPointerPos] = useState(null); // 相簿模式：範圍框中心（相對取色畫面）與邊長
    const [isLocalFile] = useState(window.location.protocol === 'file:');

    // 取色範圍大小：占畫面短邊的百分比，記住上次設定
    const [roiPct, setRoiPct] = useState(() => {
        try { const v = parseFloat(localStorage.getItem('lab_camRoiPct')); return v >= 3 && v <= 40 ? v : 12; } catch (e) { return 12; }
    });
    const [viewSize, setViewSize] = useState({ w: 0, h: 0 });

    // 鏡頭與變焦
    const [cameras, setCameras] = useState([]);
    const [cameraId, setCameraId] = useState(null);
    const [zoomCaps, setZoomCaps] = useState(null);
    const [zoom, setZoom] = useState(1);

    const roiSide = Math.round(Math.min(viewSize.w, viewSize.h) * roiPct / 100);

    const applySample = (res) => {
        const r = Math.round(res.r), g = Math.round(res.g), b = Math.round(res.b);
        setColor({ r, g, b });
        setLab(ColorUtils.rgbToLab(res.r, res.g, res.b));
        setInfo({ area: res.area, spread: res.spread });
    };

    // 追蹤取色畫面尺寸（用來畫範圍框）
    useEffect(() => {
        const el = viewRef.current; if (!el) return;
        const update = () => setViewSize({ w: el.clientWidth, h: el.clientHeight });
        update();
        const ro = new ResizeObserver(update); ro.observe(el);
        return () => ro.disconnect();
    }, []);

    useEffect(() => { try { localStorage.setItem('lab_camRoiPct', String(roiPct)); } catch (e) {} }, [roiPct]);

    const stopStream = () => {
        if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    };

    // 開啟指定鏡頭（wantedId 為空時使用預設後鏡頭），並讀取變焦能力
    const openCamera = async (wantedId) => {
        stopStream(); setStream(null);
        const video = wantedId ? { deviceId: { exact: wantedId } } : { facingMode: { ideal: 'environment' } };
        const s = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        if (!aliveRef.current) { s.getTracks().forEach(t => t.stop()); throw new Error('cancelled'); }
        streamRef.current = s;
        if (videoRef.current) videoRef.current.srcObject = s;
        setStream(s);
        const track = s.getVideoTracks()[0];
        const settings = track.getSettings ? track.getSettings() : {};
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        setCameraId(settings.deviceId || wantedId || null);
        if (caps.zoom && caps.zoom.max > caps.zoom.min) {
            setZoomCaps({ min: caps.zoom.min, max: caps.zoom.max });
            let z = typeof settings.zoom === 'number' ? settings.zoom : 1;
            // 預設回到 1x（部分手機預設倍率不在 1x）
            if (caps.zoom.min <= 1 && caps.zoom.max >= 1 && Math.abs(z - 1) > 0.01) {
                try { await track.applyConstraints({ advanced: [{ zoom: 1 }] }); z = 1; } catch (e) { /* 此鏡頭不支援變焦 */ }
            }
            setZoom(z);
        } else { setZoomCaps(null); setZoom(1); }
        return settings.deviceId;
    };

    useEffect(() => {
        if (imageMode) return;
        aliveRef.current = true;
        (async () => {
            if (isLocalFile) {
                setError("Browser Security Restriction: Local files (file://) cannot access camera directly.\nPlease use the 'Album/Photo' button below.");
                return;
            }
            try {
                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Browser API not supported");
                let saved = null;
                try { saved = localStorage.getItem('lab_camDeviceId'); } catch (e) {}
                let usedId;
                try { usedId = await openCamera(saved); }
                catch (e) { if (saved && aliveRef.current) usedId = await openCamera(null); else throw e; } // 記住的鏡頭不存在時改用預設
                const devices = await navigator.mediaDevices.enumerateDevices();
                if (!aliveRef.current) return;
                const backs = listBackCameras(devices);
                setCameras(backs);
                // 沒有手動選過鏡頭時，預設改用編號最小的後鏡頭（通常是 1x 主鏡頭）
                if (!saved && backs.length > 1 && backs[0].deviceId !== usedId) await openCamera(backs[0].deviceId);
            } catch (err) {
                if (!aliveRef.current) return;
                console.warn("Camera access failed", err);
                setError("Cannot start camera. Reasons might be:\n1. Browser security (HTTPS required)\n2. Permission denied\nPlease use 'Album/Photo' button.");
            }
        })();
        return () => { aliveRef.current = false; stopStream(); };
    }, [imageMode, isLocalFile]);

    // 即時畫面：每 0.1 秒對畫面中央的範圍框取平均色
    useEffect(() => {
        if (!stream || imageMode) return;
        const interval = setInterval(() => {
            const video = videoRef.current, canvas = canvasRef.current, view = viewRef.current;
            if (!video || !canvas || !view || !video.videoWidth || video.readyState < video.HAVE_ENOUGH_DATA) return;
            const cw = view.clientWidth, ch = view.clientHeight;
            const scale = Math.max(cw / video.videoWidth, ch / video.videoHeight); // object-cover 的縮放倍率
            const sideCss = Math.min(cw, ch) * roiPct / 100;
            applySample(sampleRegion(canvas, video, video.videoWidth, video.videoHeight, video.videoWidth / 2, video.videoHeight / 2, sideCss / scale));
        }, 100);
        return () => clearInterval(interval);
    }, [stream, imageMode, roiPct]);

    const switchLens = async (deviceId) => {
        if (deviceId === cameraId) return;
        try { localStorage.setItem('lab_camDeviceId', deviceId); } catch (e) {}
        try { await openCamera(deviceId); }
        catch (e) { console.warn('Switch lens failed', e); }
    };

    const applyZoom = async (z) => {
        const track = streamRef.current && streamRef.current.getVideoTracks()[0];
        if (!track) return;
        try { await track.applyConstraints({ advanced: [{ zoom: z }] }); setZoom(z); }
        catch (e) { console.warn('Zoom failed', e); }
    };

    const handleCaptureClick = () => { onCapture(lab); onClose(); };
    const triggerFileInput = () => fileInputRef.current && fileInputRef.current.click();
    const handleFileUpload = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (evt) => {
                setUploadedImgSrc(evt.target.result);
                setPointerPos(null);
                setImageMode(true);
                setError('');
                stopStream(); setStream(null);
            };
            reader.readAsDataURL(file);
        }
    };

    // 相簿模式：以點選／拖曳位置為中心取範圍平均（範圍框不會超出圖片邊界）
    const pickAt = (clientX, clientY) => {
        const img = imgRef.current, canvas = canvasRef.current, view = viewRef.current;
        if (!img || !canvas || !view || !img.naturalWidth) return;
        const rect = img.getBoundingClientRect(), vr = view.getBoundingClientRect();
        const sideCss = Math.min(Math.min(vr.width, vr.height) * roiPct / 100, rect.width, rect.height);
        const cx = Math.min(Math.max(clientX, rect.left + sideCss / 2), rect.right - sideCss / 2);
        const cy = Math.min(Math.max(clientY, rect.top + sideCss / 2), rect.bottom - sideCss / 2);
        const k = img.naturalWidth / rect.width;
        applySample(sampleRegion(canvas, img, img.naturalWidth, img.naturalHeight, (cx - rect.left) * k, (cy - rect.top) * k, sideCss * k));
        setPointerPos({ x: cx - vr.left, y: cy - vr.top, side: sideCss });
    };
    const onImgPointerDown = (e) => {
        draggingRef.current = true;
        e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId);
        pickAt(e.clientX, e.clientY);
    };
    const onImgPointerMove = (e) => { if (draggingRef.current) pickAt(e.clientX, e.clientY); };
    const onImgPointerUp = (e) => {
        draggingRef.current = false;
        e.currentTarget.releasePointerCapture && e.currentTarget.releasePointerCapture(e.pointerId);
    };
    const onImgLoad = () => {
        const r = imgRef.current.getBoundingClientRect();
        pickAt(r.left + r.width / 2, r.top + r.height / 2);
    };
    // 相簿模式下調整範圍大小時，以同一個中心點重新取色
    useEffect(() => {
        if (!imageMode || !pointerPos || !viewRef.current) return;
        const vr = viewRef.current.getBoundingClientRect();
        pickAt(vr.left + pointerPos.x, vr.top + pointerPos.y);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [roiPct]);

    const uniformity = info.spread <= 6 ? ['Uniform area', 'text-emerald-400']
        : info.spread <= 15 ? ['Slight variation', 'text-yellow-400']
        : ['Uneven – aim at a flat area', 'text-red-400'];
    const zoomChips = zoomCaps ? ZOOM_PRESETS.filter(v => v >= zoomCaps.min - 0.01 && v <= zoomCaps.max + 0.01) : [];
    const chip = (active) => `px-3 py-1.5 rounded-full text-xs font-bold border backdrop-blur-md transition-colors active:scale-95 ${active ? 'bg-blue-600 text-white border-blue-400' : 'bg-black/50 text-white/80 border-white/20'}`;
    const currentLensLabel = (cameras.find(c => c.deviceId === cameraId) || {}).label;

    return (
        <div className="fixed inset-0 z-50 bg-black flex flex-col" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
            <div ref={viewRef} className="relative flex-1 bg-black flex items-center justify-center overflow-hidden">
                {imageMode ? (
                    <div className="relative w-full h-full flex items-center justify-center bg-gray-900">
                        <img
                            ref={imgRef} src={uploadedImgSrc} alt="Uploaded"
                            className="max-w-full max-h-full object-contain cursor-crosshair select-none"
                            style={{ touchAction: 'none' }}
                            draggable={false}
                            onLoad={onImgLoad}
                            onPointerDown={onImgPointerDown} onPointerMove={onImgPointerMove} onPointerUp={onImgPointerUp} onPointerCancel={onImgPointerUp}
                        />
                        {pointerPos && <RoiBox side={pointerPos.side} style={{ left: pointerPos.x - pointerPos.side / 2, top: pointerPos.y - pointerPos.side / 2 }} />}
                        <div className="absolute top-6 bg-black/70 text-white px-4 py-2 rounded-full text-sm pointer-events-none backdrop-blur-md shadow-lg border border-white/10">👆 Tap or drag to move the sampling box</div>
                    </div>
                ) : (
                    <>
                        {error ? (
                            <div className="text-white p-8 text-center max-w-sm flex flex-col items-center animate-pulse">
                                <Camera size={64} className="mb-6 text-gray-500 opacity-80" />
                                <p className="font-bold mb-3 text-xl">Camera Mode</p>
                                <p className="text-sm text-gray-400 mb-8 whitespace-pre-line leading-relaxed">{error}</p>
                                <button onClick={triggerFileInput} className="bg-blue-600 hover:bg-blue-500 active:scale-95 text-white px-8 py-4 rounded-full font-bold flex items-center gap-3 shadow-xl transition-all"><ImageIcon size={24} /> Album / Camera</button>
                            </div>
                        ) : (
                            <>
                                <video ref={videoRef} autoPlay playsInline muted className="absolute w-full h-full object-cover" />
                                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                    {roiSide > 0 && <RoiBox side={roiSide} />}
                                </div>
                                <div className="absolute top-6 left-0 right-0 text-center pointer-events-none"><span className="bg-black/60 text-white/90 px-4 py-1.5 rounded-full text-xs backdrop-blur-sm border border-white/10">⚠ Values affected by lighting, for reference only</span></div>
                                {(cameras.length > 1 || zoomChips.length > 1) && (
                                    <div className="absolute bottom-3 left-0 right-0 z-10 flex flex-col items-center gap-2 px-3">
                                        {zoomChips.length > 1 && (
                                            <div className="flex gap-2" role="group" aria-label="Zoom">
                                                {zoomChips.map(v => (
                                                    <button key={v} onClick={() => applyZoom(v)} className={chip(Math.abs(zoom - v) < 0.05)}>{v}x</button>
                                                ))}
                                            </div>
                                        )}
                                        {cameras.length > 1 && (
                                            <div className="flex gap-2" role="group" aria-label="Lens">
                                                {cameras.map((c, i) => (
                                                    <button key={c.deviceId} onClick={() => switchLens(c.deviceId)} title={c.label} className={chip(c.deviceId === cameraId)}>Lens {i + 1}</button>
                                                ))}
                                            </div>
                                        )}
                                        {currentLensLabel && <span className="text-[10px] text-white/60 bg-black/40 px-2 py-0.5 rounded-full">{currentLensLabel}</span>}
                                    </div>
                                )}
                            </>
                        )}
                    </>
                )}
                <canvas ref={canvasRef} className="hidden" />
                <input ref={fileInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFileUpload} />
            </div>
            <div className="bg-gray-900 p-5 flex flex-col gap-4 border-t border-gray-800" style={{ paddingBottom: 'max(2.5rem, calc(env(safe-area-inset-bottom) + 1rem))' }}>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className="w-14 h-14 rounded-full border-2 border-white shadow-lg transition-colors duration-200" style={{ backgroundColor: `rgb(${color.r}, ${color.g}, ${color.b})` }}></div>
                        <div className="flex flex-col text-white">
                            <span className="text-xs text-gray-400 font-mono tracking-wider">RGB: {color.r}, {color.g}, {color.b}</span>
                            <span className="font-mono font-bold text-xl text-yellow-400 tracking-tight">L{lab.l} a{lab.a} b{lab.b}</span>
                            <span className="text-[11px] text-gray-400">Avg of {info.area}×{info.area}px · <span className={uniformity[1]}>{uniformity[0]}</span></span>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-3 text-white">
                    <span className="text-xs text-gray-400 font-bold w-12 shrink-0">Area</span>
                    <input type="range" min="3" max="40" step="1" value={roiPct} onChange={(e) => setRoiPct(Number(e.target.value))} aria-label="Sampling area size" className="flex-1 accent-blue-500" />
                    <span className="text-xs font-mono text-gray-300 w-10 text-right">{roiPct}%</span>
                </div>
                <div className="grid grid-cols-3 gap-4">
                    <button onClick={onClose} className="bg-gray-800 active:bg-gray-700 text-white py-3.5 rounded-xl font-bold text-sm transition-colors">Cancel</button>
                    <button onClick={triggerFileInput} className="bg-gray-800 active:bg-gray-700 text-white py-3.5 rounded-xl font-bold flex items-center justify-center gap-2 cursor-pointer text-sm transition-colors"><ImageIcon size={18} /><span>Album</span></button>
                    <button onClick={handleCaptureClick} className="bg-blue-600 active:bg-blue-500 text-white py-3.5 rounded-xl font-bold flex items-center justify-center gap-2 text-sm transition-colors shadow-lg shadow-blue-900/30"><CheckSquare size={18} /><span>Confirm</span></button>
                </div>
            </div>
        </div>
    );
};

// 3D/2D Components
const AxesSystem3D = () => (
    <group>
        <line><bufferGeometry attach="geometry" {...new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 210, 0)])} /><lineBasicMaterial attach="material" color="#888" opacity={0.5} transparent /></line>
        <Billboard position={[0, 215, 0]}><Text font={LABEL_FONT} fontSize={4} color="black" outlineWidth={0.2} outlineColor="white">L</Text></Billboard>
        <line><bufferGeometry attach="geometry" {...new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-200, 0, 0), new THREE.Vector3(200, 0, 0)])} /><lineBasicMaterial attach="material" color="#ff0000" opacity={0.3} transparent /></line>
        <Billboard position={[210, 0, 0]}><Text font={LABEL_FONT} fontSize={4} color="#cc0000" outlineWidth={0.2} outlineColor="white">+a</Text></Billboard>
        <Billboard position={[-210, 0, 0]}><Text font={LABEL_FONT} fontSize={4} color="#00aa00" outlineWidth={0.2} outlineColor="white">-a</Text></Billboard>
        <line><bufferGeometry attach="geometry" {...new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -200), new THREE.Vector3(0, 0, 200)])} /><lineBasicMaterial attach="material" color="#0000ff" opacity={0.3} transparent /></line>
        <Billboard position={[0, 0, 210]}><Text font={LABEL_FONT} fontSize={4} color="#aaaa00" outlineWidth={0.2} outlineColor="white">+b</Text></Billboard>
        <Billboard position={[0, 0, -210]}><Text font={LABEL_FONT} fontSize={4} color="#0000cc" outlineWidth={0.2} outlineColor="white">-b</Text></Billboard>
    </group>
);

const AxesSystem2D = () => (
    <group>
        <line><bufferGeometry attach="geometry" {...new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-200, 0, 0), new THREE.Vector3(200, 0, 0)])} /><lineBasicMaterial attach="material" color="#ff0000" opacity={0.5} transparent /></line>
        <Text font={LABEL_FONT} position={[210, 0, 0]} fontSize={4} color="#cc0000" outlineWidth={0.2} outlineColor="white">+a</Text>
        <Text font={LABEL_FONT} position={[-210, 0, 0]} fontSize={4} color="#00aa00" outlineWidth={0.2} outlineColor="white">-a</Text>
        <line><bufferGeometry attach="geometry" {...new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -200, 0), new THREE.Vector3(0, 200, 0)])} /><lineBasicMaterial attach="material" color="#0000ff" opacity={0.5} transparent /></line>
        <Text font={LABEL_FONT} position={[0, 210, 0]} fontSize={4} color="#aaaa00" outlineWidth={0.2} outlineColor="white">+b</Text>
        <Text font={LABEL_FONT} position={[0, -210, 0]} fontSize={4} color="#0000cc" outlineWidth={0.2} outlineColor="white">-b</Text>
    </group>
);

const LabPoint = ({ l, a, b, name, isTestPoint = false, id, showLabels, typeLabel, mode = '3d', deltaE, isStandard, matColor }) => {
    const color = matColor || ColorUtils.labToHex(l, a, b);
    const position = mode === '2d' ? [a, b, 0] : [a, l, b];
    const [hovered, setHover] = useState(false);
    const hasName = name && name.trim().length > 0;
    const labelVisible = showLabels && (hasName || isTestPoint);
    let defaultLabel = isTestPoint ? "Test" : (typeLabel || "Pt");
    let labelText = hasName ? name : defaultLabel;
    if (isStandard) labelText += " (Std)";
    else if (deltaE) labelText += ` (ΔE: ${deltaE})`;

    return (
        <group position={position}>
            <mesh onPointerOver={(e) => { e.stopPropagation(); setHover(true); }} onPointerOut={(e) => setHover(false)}>
                {isTestPoint ? <boxGeometry args={[5, 5, 5]} /> : <sphereGeometry args={[3, 32, 32]} />}
                <meshStandardMaterial color={color} emissive={isStandard ? "#ffff00" : (isTestPoint ? "#ffffff" : "#000000")} emissiveIntensity={isStandard ? 0.3 : (isTestPoint && hovered ? 0.5 : 0)} />
                {isTestPoint && <lineSegments><edgesGeometry args={[new THREE.BoxGeometry(5, 5, 5)]} /><lineBasicMaterial color={isStandard ? "#ffff00" : "white"} opacity={isStandard ? 0.8 : 0.5} transparent /></lineSegments>}
                {isStandard && <lineSegments rotation={[mode === '2d' ? 0 : Math.PI/2, 0, 0]}><edgesGeometry args={[new THREE.CylinderGeometry(6, 6, 0.5, 16)]} /><lineBasicMaterial color="#ffff00" /></lineSegments>}
            </mesh>
            {labelVisible && labelText && (
                mode === '3d' ? <Billboard position={[0, 6, 0]}><Text font={LABEL_FONT} fontSize={3} color={isTestPoint ? "#d8b4fe" : "white"} outlineWidth={0.15} outlineColor="black" anchorY="bottom">{labelText}</Text></Billboard> 
                : <Text font={LABEL_FONT} position={[0, 6, 0]} fontSize={3} color={isTestPoint ? "#581c87" : "#1e293b"} outlineWidth={0.2} outlineColor="white" anchorY="bottom">{labelText}</Text>
            )}
            {/* Fixed: Conditional distanceFactor logic to prevent huge scaling in 2D/Orthographic view */}
            <Html distanceFactor={mode === '2d' ? undefined : 200} zIndexRange={[100, 0]} style={{ pointerEvents: 'none', opacity: hovered ? 1 : 0, transition: 'opacity 0.2s' }}>
                <div className={`tooltip-animate px-2 py-1 rounded text-xs whitespace-nowrap border shadow-xl transform -translate-x-1/2 -translate-y-full mt-[-10px] ${isTestPoint ? 'bg-purple-900 text-white border-purple-500' : 'bg-gray-800 text-white border-gray-600'}`}>
                    <strong>{name || defaultLabel} {isStandard ? "(Standard)" : ""}</strong><br/>L:{l} a:{a} b:{b}<br/>{deltaE && <span className="text-yellow-300">ΔE: {deltaE}</span>}
                </div>
            </Html>
        </group>
    );
};

const GamutVolume = ({ points, mode = '3d', colorL = 50, autoL = true, opacity = 0.6 }) => {
    const { geometry } = useMemo(() => {
        if (points.length < 3) return { geometry: null };
        const vectors = [];
        // Fix for 2D Sync: Ensure 2D hull has volume by duplicating points with +/- Z
        if (mode === '2d') {
            points.forEach(p => {
                vectors.push(new THREE.Vector3(p.a, p.b, 0.1));
                vectors.push(new THREE.Vector3(p.a, p.b, -0.1));
            });
        } else {
            points.forEach(p => {
                vectors.push(new THREE.Vector3(p.a, p.l, p.b));
            });
        }
        
        let geo;
        try {
            geo = new ConvexGeometry(vectors);
            const count = geo.attributes.position.count;
            const colors = [];
            const pos = geo.attributes.position;
            for(let i = 0; i < count; i++) {
                const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i);
                let minD = Infinity; let closest = points[0];
                for(let p of points) {
                    let d;
                    if (mode === '2d') d = (p.a - x)**2 + (p.b - y)**2;
                    else d = (p.a - x)**2 + (p.l - y)**2 + (p.b - z)**2;
                    if(d < minD) { minD = d; closest = p; }
                }
                // L value used for gamut surface coloring: either each facet's own nearest-point L (auto),
                // or a single user-adjustable L value applied uniformly (manual).
                const useL = autoL ? closest.l : colorL;
                const rgb = ColorUtils.labToRgbNormalized(useL, closest.a, closest.b);
                colors.push(rgb[0], rgb[1], rgb[2]);
            }
            geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        } catch (e) { return { geometry: null }; }
        return { geometry: geo };
    }, [points, mode, autoL, colorL]);
    if (!geometry) return null;
    return <group><mesh geometry={geometry}><meshBasicMaterial vertexColors={true} transparent={true} opacity={opacity} side={THREE.DoubleSide} depthWrite={false} /></mesh></group>;
};

/**
 * Draggable slider control (pointer-drag adjustable), used for Gamut L / Opacity controls.
 */
const DragSlider = ({ label, value, min, max, step = 1, onChange, unit = '', accent = '#3b82f6', disabled = false, formatValue }) => {
    const trackRef = useRef(null);
    const draggingRef = useRef(false);

    const pct = ColorUtils.clamp((value - min) / (max - min), 0, 1) * 100;

    const updateFromClientX = (clientX) => {
        if (!trackRef.current) return;
        const rect = trackRef.current.getBoundingClientRect();
        const ratio = ColorUtils.clamp((clientX - rect.left) / rect.width, 0, 1);
        let raw = min + ratio * (max - min);
        raw = Math.round(raw / step) * step;
        raw = ColorUtils.clamp(raw, min, max);
        onChange(parseFloat(raw.toFixed(4)));
    };

    const handlePointerDown = (e) => {
        if (disabled) return;
        draggingRef.current = true;
        e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId);
        updateFromClientX(e.clientX);
    };
    const handlePointerMove = (e) => {
        if (!draggingRef.current || disabled) return;
        updateFromClientX(e.clientX);
    };
    const handlePointerUp = (e) => {
        draggingRef.current = false;
        e.currentTarget.releasePointerCapture && e.currentTarget.releasePointerCapture(e.pointerId);
    };

    return (
        <div className={`select-none transition-opacity ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}>
            <div className="flex justify-between items-center mb-1.5">
                <span className="text-[11px] font-bold text-white/70 uppercase tracking-wider">{label}</span>
                <span className="text-xs font-mono font-bold text-white bg-white/10 px-1.5 py-0.5 rounded">{formatValue ? formatValue(value) : value}{unit}</span>
            </div>
            <div
                ref={trackRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                className={`relative h-5 flex items-center touch-none ${disabled ? 'pointer-events-none cursor-not-allowed' : 'cursor-pointer'}`}
                style={{ touchAction: 'none' }}
            >
                <div className="absolute left-0 right-0 h-1.5 rounded-full bg-white/15" />
                <div className="absolute left-0 h-1.5 rounded-full" style={{ width: `${pct}%`, backgroundColor: disabled ? '#6b7280' : accent }} />
                <div
                    className="absolute w-4 h-4 rounded-full shadow-lg border-2 border-white -translate-x-1/2"
                    style={{ left: `${pct}%`, backgroundColor: disabled ? '#6b7280' : accent }}
                />
            </div>
        </div>
    );
};

const ToggleSwitch = ({ checked, onChange, disabled = false }) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative inline-flex items-center w-9 h-5 rounded-full shrink-0 transition-colors duration-200 ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'} ${checked ? 'bg-blue-600' : 'bg-white/20'}`}
    >
        <span
            className={`absolute left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${checked ? 'translate-x-4' : 'translate-x-0'}`}
        />
    </button>
);

const GamutDisplayPanel = ({ open, onClose, autoL, setAutoL, colorL, setColorL, opacity, setOpacity, gamutMode, setGamutMode, showCorrections, setShowCorrections, materials, hiddenMaterials, toggleMaterial, setHiddenMaterials, colorByMaterial, setColorByMaterial, materialSwatch }) => {
    if (!open) return null;
    return (
        <div className="absolute top-14 right-4 z-30 w-72 max-h-[75vh] overflow-y-auto bg-[#26262e]/95 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl p-4 space-y-4 tooltip-animate">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <div className="flex items-center gap-2 text-white text-xs font-bold uppercase tracking-wider"><SlidersHorizontal size={14} /> View Settings</div>
                <button onClick={onClose} className="text-white/40 hover:text-white transition-colors"><X size={16} /></button>
            </div>

            <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-white/70 uppercase tracking-wider flex items-center gap-1.5"><Sun size={12}/> Auto L (per-facet)</span>
                <ToggleSwitch checked={autoL} onChange={setAutoL} />
            </div>


            <div className="space-y-2 pt-1 border-t border-white/10">
                <span className="text-[11px] font-bold text-white/70 uppercase tracking-wider">Gamut Mode</span>
                <div className="flex bg-black/40 rounded-lg p-1 border border-white/10">
                    {[['projection', 'Projection'], ['slice', 'Slice by L']].map(([k, label]) => (
                        <button key={k} onClick={() => setGamutMode(k)} className={`flex-1 px-2 py-1.5 text-[11px] font-bold rounded-md transition-all ${gamutMode === k ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>{label}</button>
                    ))}
                </div>
                <p className="text-[10px] text-white/40 leading-relaxed">{gamutMode === 'slice' ? '以 Test Point 同一 L 的 a-b 截面判定；C 為保持 Hue、L 與 Chroma 可調的最小 ΔE。' : '假設 a,b 不隨 L 改變，以 a-b 投影範圍判定，ΔL 恆為 0。'}</p>
            </div>

            <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-white/70 uppercase tracking-wider">Show Corrections A/B/C</span>
                <ToggleSwitch checked={showCorrections} onChange={setShowCorrections} />
            </div>

            <div className="space-y-2 pt-1 border-t border-white/10">
                <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-white/70 uppercase tracking-wider">Color by Material</span>
                    <ToggleSwitch checked={colorByMaterial} onChange={setColorByMaterial} />
                </div>
                {materials.length === 0 ? <p className="text-[10px] text-white/40">尚未輸入任何材質。</p> : (
                    <>
                        <div className="flex flex-wrap gap-1.5">
                            {materials.map(m => {
                                const hidden = hiddenMaterials.includes(m);
                                return (
                                    <button key={m || '__none'} onClick={() => toggleMaterial(m)} className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] border transition-all ${hidden ? 'border-white/10 text-white/30 line-through' : 'border-white/30 text-white'}`}>
                                        <span className="w-2.5 h-2.5 rounded-full" style={{ background: materialSwatch(m), opacity: hidden ? 0.3 : 1 }} />{m || '(none)'}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="flex gap-3 text-[10px]">
                            <button onClick={() => setHiddenMaterials([])} className="text-blue-300 underline">Show all</button>
                            <button onClick={() => setHiddenMaterials(materials.slice())} className="text-blue-300 underline">Hide all</button>
                        </div>
                    </>
                )}
            </div>

            <DragSlider
                label="Gamut Color L"
                value={colorL}
                min={0}
                max={100}
                step={1}
                onChange={setColorL}
                accent="#f59e0b"
                disabled={autoL}
            />

            <DragSlider
                label="Opacity"
                value={opacity}
                min={0.05}
                max={1}
                step={0.01}
                onChange={setOpacity}
                accent="#22c55e"
                formatValue={(v) => Math.round(v * 100)}
                unit="%"
            />

            <p className="text-[10px] text-white/40 leading-relaxed pt-1 border-t border-white/10">
                {autoL ? 'Each gamut facet is colored using its own nearest point\u2019s L value.' : 'A fixed L value is applied across the whole gamut surface color.'}
            </p>
        </div>
    );
};

const ViewContainer = ({ children, title, onFullscreen, onCapture, onToggleLabels, showLabels }) => {
    // 以 CSS 方式放大到整個畫面（瀏覽器 Fullscreen API 在 Android WebView 內不可靠）
    const [expanded, setExpanded] = useState(false);
    const btn = "p-2.5 md:p-2 bg-black/40 hover:bg-white/10 text-white/70 backdrop-blur-md rounded-lg shadow-lg border border-white/10 transition-all active:scale-95";
    return (
        <div
            className={`${expanded ? 'fixed inset-0 z-[60]' : 'relative w-full h-full'} bg-[#1e1e24] overflow-hidden group border-b border-white/5 last:border-0`}
            style={{ touchAction: 'none', ...(expanded ? { paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' } : {}) }}
        >
            <div className="absolute top-3 left-3 md:top-4 md:left-4 z-20 pointer-events-none select-none"><div className="bg-black/40 backdrop-blur-md text-white/90 text-xs md:text-sm font-bold px-3 py-1.5 rounded-lg border border-white/10 shadow-lg">{title}</div></div>
            <div className="absolute top-3 right-3 md:top-4 md:right-4 z-20 flex flex-col gap-2 opacity-90 transition-opacity" style={expanded ? { marginTop: 'env(safe-area-inset-top)' } : undefined}>
                <button onClick={onToggleLabels} aria-label="Toggle labels" className={`p-2.5 md:p-2 rounded-lg shadow-lg backdrop-blur-md border transition-all active:scale-95 ${showLabels ? 'bg-blue-600 text-white border-blue-500' : 'bg-black/40 text-white/70 border-white/10 hover:bg-white/10'}`}><Tag size={18} /></button>
                <button onClick={onCapture} aria-label="Save screenshot" className={btn}><Camera size={18} /></button>
                <button onClick={() => setExpanded(v => !v)} aria-label={expanded ? 'Exit full screen' : 'Full screen'} className={btn}>{expanded ? <Minimize size={18} /> : <Maximize size={18} />}</button>
            </div>
            {children}
        </div>
    );
};

const ScreenshotHandler = ({ captureRef }) => {
    const { gl, scene, camera } = useThree();
    useEffect(() => {
        if (captureRef) {
            captureRef.current = async () => {
                const originalSize = new THREE.Vector2(); gl.getSize(originalSize); const originalAspect = camera.aspect;
                gl.setSize(1200, 1200); if (!camera.isOrthographicCamera) { camera.aspect = 1; camera.updateProjectionMatrix(); }
                gl.render(scene, camera); const dataUrl = gl.domElement.toDataURL('image/png');
                gl.setSize(originalSize.width, originalSize.height); if (!camera.isOrthographicCamera) { camera.aspect = originalAspect; } camera.updateProjectionMatrix(); gl.render(scene, camera);
                try {
                    await saveFile(`lab-view-${Date.now()}.png`, dataUrl.split(',')[1], 'image/png');
                } catch (err) { console.warn('Screenshot save failed', err); }
            };
        }
    }, [gl, scene, camera, captureRef]);
    return null;
};

const CORR_STYLES = [['A', '#f97316'], ['B', '#22d3ee'], ['C', '#4ade80']];
// 把超出 Gamut 的 Test Point 連到修正點 A / B / C
const CorrectionLinks = ({ testPoints, mode }) => {
    const pos = (q) => mode === '2d' ? [q.a, q.b, 0.5] : [q.a, q.l, q.b];
    const items = [];
    testPoints.forEach(p => {
        const g = p.gamutDeltas;
        if (!g || g.isInside || p.showPoint === false) return;
        CORR_STYLES.forEach(([k, col]) => {
            const r = g[k];
            if (!r) return;
            const from = pos(p), to = pos(r);
            if (Math.hypot(from[0] - to[0], from[1] - to[1], from[2] - to[2]) < 1e-3) return;
            items.push({ key: `${p.id}-${k}`, k, col, from, to });
        });
    });
    return (
        <>
            {items.map(({ key, k, col, from, to }) => (
                <group key={key}>
                    <Line points={[from, to]} color={col} lineWidth={2} dashed dashSize={2} gapSize={1.5} />
                    <mesh position={to}><sphereGeometry args={[2, 16, 16]} /><meshBasicMaterial color={col} /></mesh>
                    <group position={to}>
                        {mode === '3d'
                            ? <Billboard position={[0, 4, 0]}><Text font={LABEL_FONT} fontSize={3.5} color={col} outlineWidth={0.2} outlineColor="black">{k}</Text></Billboard>
                            : <Text font={LABEL_FONT} position={[0, 4, 0]} fontSize={3.5} color={col} outlineWidth={0.25} outlineColor="black">{k}</Text>}
                    </group>
                </group>
            ))}
        </>
    );
};

const Scene3D = ({ basePoints, historyPoints, testPoints, captureRef, showLabels, gamutColorL, gamutAutoL, gamutOpacity, showCorrections, matShown, matColor }) => {
    const gamutPoints = useMemo(() => [...basePoints.filter(p=>p.visible!==false), ...historyPoints.filter(p=>p.visible!==false)], [basePoints, historyPoints]);
    const renderBase = useMemo(() => basePoints.filter(p => p.showPoint !== false && matShown(p)), [basePoints, matShown]);
    const renderHistory = useMemo(() => historyPoints.filter(p => p.showPoint !== false && matShown(p)), [historyPoints, matShown]);
    const renderTest = useMemo(() => testPoints.filter(p => p.showPoint !== false && matShown(p)), [testPoints, matShown]);
    return (
        <>
            <ScreenshotHandler captureRef={captureRef} />
            <ambientLight intensity={1.5} />
            <pointLight position={[200, 200, 200]} intensity={1} />
            <pointLight position={[-200, -200, -200]} intensity={0.5} />
            <OrbitControls makeDefault target={[0, 50, 0]} dampingFactor={0.1} />
            <AxesSystem3D />
            {renderBase.map((p) => <LabPoint key={p.id} {...p} matColor={matColor(p)} mode="3d" showLabels={showLabels} typeLabel="Base" />)}
            {renderHistory.map((p) => <LabPoint key={p.id} {...p} matColor={matColor(p)} mode="3d" showLabels={showLabels} typeLabel="Hist" />)}
            {renderTest.map((p) => <LabPoint key={p.id} {...p} matColor={matColor(p)} mode="3d" isTestPoint={true} showLabels={showLabels} />)}
            {showCorrections && <CorrectionLinks testPoints={renderTest} mode="3d" />}
            <GamutVolume points={gamutPoints} mode="3d" colorL={gamutColorL} autoL={gamutAutoL} opacity={gamutOpacity} />
        </>
    );
};

const Scene2D = ({ basePoints, historyPoints, testPoints, captureRef, showLabels, gamutColorL, gamutAutoL, gamutOpacity, showCorrections, matShown, matColor }) => {
    const gamutPoints = useMemo(() => [...basePoints.filter(p=>p.visible!==false), ...historyPoints.filter(p=>p.visible!==false)], [basePoints, historyPoints]);
    const renderBase = useMemo(() => basePoints.filter(p => p.showPoint !== false && matShown(p)), [basePoints, matShown]);
    const renderHistory = useMemo(() => historyPoints.filter(p => p.showPoint !== false && matShown(p)), [historyPoints, matShown]);
    const renderTest = useMemo(() => testPoints.filter(p => p.showPoint !== false && matShown(p)), [testPoints, matShown]);
    return (
        <>
            <ScreenshotHandler captureRef={captureRef} />
            <ambientLight intensity={1.5} />
            <directionalLight position={[0, 0, 100]} intensity={1} />
            <MapControls makeDefault screenSpacePanning={true} minZoom={0.5} maxZoom={5} dampingFactor={0.1} />
            <AxesSystem2D />
            {renderBase.map((p) => <LabPoint key={p.id} {...p} matColor={matColor(p)} mode="2d" showLabels={showLabels} typeLabel="Base" />)}
            {renderHistory.map((p) => <LabPoint key={p.id} {...p} matColor={matColor(p)} mode="2d" showLabels={showLabels} typeLabel="Hist" />)}
            {renderTest.map((p) => <LabPoint key={p.id} {...p} matColor={matColor(p)} mode="2d" isTestPoint={true} showLabels={showLabels} />)}
            {showCorrections && <CorrectionLinks testPoints={renderTest} mode="2d" />}
            <GamutVolume points={gamutPoints} mode="2d" colorL={gamutColorL} autoL={gamutAutoL} opacity={gamutOpacity} />
        </>
    );
};

const InputRow = ({ point, onChange, onDelete, isTestPoint = false, inputColorClass = 'text-blue-700', deltaE, isStandard, onToggleStandard }) => {
    const colorPreview = ColorUtils.labToHex(point.l, point.a, point.b);
    const handleChange = (field, value) => {
        if (field === 'name' || field === 'material' || field === 'visible' || field === 'showPoint') { onChange(point.id, field, value); return; }
        let val = parseFloat(value); if(isNaN(val)) val = 0;
        if (field === 'l') val = ColorUtils.clamp(val, 0, 200); if (field === 'a' || field === 'b') val = ColorUtils.clamp(val, -200, 200);
        onChange(point.id, field, val);
    };

    // Local text drafts for l/a/b so the user can type a leading "-" (or a trailing ".")
    // without it being immediately parsed back to 0. Only committed to parent state once
    // the draft is a complete, valid number.
    const [drafts, setDrafts] = useState({ l: String(point.l), a: String(point.a), b: String(point.b) });
    const focusedFieldRef = useRef(null);
    const NUMERIC_DRAFT_RE = /^-?\d*\.?\d*$/;

    useEffect(() => {
        setDrafts(prev => ({
            l: focusedFieldRef.current === 'l' ? prev.l : String(point.l),
            a: focusedFieldRef.current === 'a' ? prev.a : String(point.a),
            b: focusedFieldRef.current === 'b' ? prev.b : String(point.b),
        }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [point.l, point.a, point.b]);

    const handleNumericDraftChange = (field, rawValue) => {
        // Allow intermediate typing states: "", "-", "-.", "3.", "-3." etc. without committing yet.
        if (rawValue === '' || rawValue === '-' || NUMERIC_DRAFT_RE.test(rawValue)) {
            setDrafts(prev => ({ ...prev, [field]: rawValue }));
            // Only push to parent state once it's a complete number (not mid-typing like "-" or "3.")
            if (rawValue !== '' && rawValue !== '-' && !rawValue.endsWith('.') && !isNaN(parseFloat(rawValue))) {
                handleChange(field, rawValue);
            }
            return;
        }
        // Reject any character that doesn't fit a plain signed decimal number.
    };

    const handleNumericFocus = (field) => { focusedFieldRef.current = field; };
    const handleNumericBlur = (field) => {
        focusedFieldRef.current = null;
        // Finalize: if what's left isn't a full valid number, snap back to the committed point value.
        const raw = drafts[field];
        if (raw === '' || raw === '-' || raw.endsWith('.') || isNaN(parseFloat(raw))) {
            setDrafts(prev => ({ ...prev, [field]: String(point[field]) }));
        } else {
            handleChange(field, raw);
            setDrafts(prev => ({ ...prev, [field]: String(ColorUtils.clamp(parseFloat(raw), field === 'l' ? 0 : -200, field === 'l' ? 200 : 200)) }));
        }
    };

    return (
        <div className={`flex flex-col mb-2 bg-white p-2 rounded-lg shadow-sm border group transition-colors ${isStandard ? 'border-yellow-400 bg-yellow-50' : 'border-gray-100 hover:border-blue-300'}`}>
            <div className="mb-2 flex items-center border-b border-gray-100 pb-1">
                <div className="mr-2 flex items-center gap-1 border-r border-gray-100 pr-2">
                    {isTestPoint ? (
                        <>
                            <button onClick={() => onToggleStandard(point.id)} className={`w-9 h-9 md:w-6 md:h-6 flex items-center justify-center rounded transition-colors ${isStandard ? 'text-red-500 hover:text-red-600 bg-red-50' : 'text-gray-300 hover:text-red-400'}`} title={isStandard ? "Unset Standard" : "Set as Standard"}><Target size={16} fill={isStandard ? "currentColor" : "none"} /></button>
                            <button onClick={() => handleChange('showPoint', !(point.showPoint !== false))} className={`w-9 h-9 md:w-6 md:h-6 flex items-center justify-center rounded transition-colors ${point.showPoint !== false ? 'text-gray-600 hover:text-gray-800' : 'text-gray-300 hover:text-gray-400'}`} title="Show/Hide"><Eye size={16} /></button>
                        </>
                    ) : (
                        <>
                            <button 
                                onClick={() => handleChange('visible', !(point.visible !== false))}
                                className="w-9 h-9 md:w-6 md:h-6 flex items-center justify-center text-gray-400 hover:text-blue-600 transition-colors"
                                title="Toggle Gamut Visibility"
                            >
                                {point.visible !== false ? (
                                    <div className="w-4 h-4 bg-blue-100 text-blue-600 rounded flex items-center justify-center">
                                        <CheckSquareIcon size={14} />
                                    </div>
                                ) : (
                                    <div className="w-4 h-4 border border-gray-300 rounded hover:border-blue-400"></div>
                                )}
                            </button>
                            <button onClick={() => handleChange('showPoint', !(point.showPoint !== false))} className={`w-9 h-9 md:w-6 md:h-6 flex items-center justify-center rounded transition-colors ${point.showPoint !== false ? 'text-gray-600 hover:text-gray-800' : 'text-gray-300 hover:text-gray-400'}`}><Eye size={16} /></button>
                        </>
                    )}
                </div>
                <span className="text-[10px] text-gray-400 font-bold mr-1">Name:</span>
                <input type="text" placeholder="Name" value={point.name || ''} onChange={(e) => handleChange('name', e.target.value)} className={`flex-1 min-w-0 md:flex-none md:w-16 text-sm md:text-xs font-medium focus:outline-none placeholder-gray-300 bg-transparent ${inputColorClass}`} />
                {isTestPoint && !isStandard && deltaE && <div className="ml-auto bg-gray-100 px-1.5 py-0.5 rounded text-[10px] font-mono text-gray-600 flex items-center"><span className="font-bold text-gray-400 mr-1">ΔE</span><span className={parseFloat(deltaE) > 5 ? "text-red-500 font-bold" : "text-gray-800"}>{deltaE}</span></div>}
                {isStandard && <div className="ml-auto bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded text-[10px] font-bold">STD</div>}
            </div>
            <div className="mb-2 flex items-center gap-1 border-b border-gray-100 pb-1">
                <span className="text-[10px] text-gray-400 font-bold mr-1">Material:</span>
                <input type="text" list="material-options" placeholder="Material" value={point.material || ''} onChange={(e) => handleChange('material', e.target.value)} className={`flex-1 min-w-0 text-sm md:text-xs font-medium focus:outline-none placeholder-gray-300 bg-transparent ${inputColorClass}`} />
            </div>
            <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-md border border-gray-200 shadow-inner flex-shrink-0" style={{ backgroundColor: colorPreview }} title={`Preview: ${colorPreview}`} />
                <div className="grid grid-cols-3 gap-2 flex-grow">
                    {['l', 'a', 'b'].map(field => (
                        <div key={field} className="flex flex-col relative">
                            <label className="absolute -top-2 md:-top-1.5 left-1 text-[10px] md:text-[8px] bg-white px-0.5 text-gray-400 font-bold uppercase tracking-wider pointer-events-none">{field}</label>
                            <input
                                type="text"
                                inputMode="decimal"
                                value={drafts[field]}
                                onChange={(e) => handleNumericDraftChange(field, e.target.value)}
                                onFocus={() => handleNumericFocus(field)}
                                onBlur={() => handleNumericBlur(field)}
                                className={`w-full text-center text-base md:text-sm border border-gray-200 rounded py-2 md:py-1 px-0.5 focus:border-blue-500 focus:outline-none transition-all focus:bg-white ${point.visible === false ? 'bg-gray-50 text-gray-500' : 'bg-gray-50'}`}
                            />
                        </div>
                    ))}
                </div>
                <button onClick={() => onDelete(point.id)} className="text-gray-300 hover:text-red-500 hover:bg-red-50 p-2.5 md:p-1.5 rounded-full transition-all"><Trash2 size={14} /></button>
            </div>
            {/* Gamut Distance Info for Test Points */}
            {isTestPoint && point.gamutDeltas && (() => {
                const g = point.gamutDeltas;
                const f = (v) => (v > 0 ? '+' : '') + v.toFixed(1);
                const row = (label, hint, r, accent) => (
                    <div className="border-t border-slate-100 pt-1 mt-1">
                        <div className="flex items-center justify-between text-slate-400"><span className="font-bold flex items-center gap-1.5" style={{ color: accent }}><span className="inline-block w-5 h-5 rounded border border-gray-300 shrink-0" title={r ? `L ${r.l.toFixed(1)} a ${r.a.toFixed(1)} b ${r.b.toFixed(1)}` : 'N/A'} style={{ background: r ? ColorUtils.labToHex(r.l, r.a, r.b) : 'transparent', borderStyle: r ? 'solid' : 'dashed' }} />{label}</span><span>{hint}</span></div>
                        {r ? (
                            <div className="text-slate-700">
                                <div className="flex justify-between font-bold">
                                    <span>L: <span className="text-blue-600">{r.l.toFixed(1)}</span></span>
                                    <span>a: <span className="text-blue-600">{r.a.toFixed(1)}</span></span>
                                    <span>b: <span className="text-blue-600">{r.b.toFixed(1)}</span></span>
                                </div>
                                <div className="flex justify-between text-slate-500 flex-wrap gap-x-2">
                                    {Math.abs(r.dl) > 0.05 && <span>ΔL {f(r.dl)}</span>}
                                    <span>Δa {f(r.da)}</span><span>Δb {f(r.db)}</span>
                                    <span>ΔC {f(r.dC)}</span><span>ΔH {f(r.dH)}°</span><span className="font-bold">ΔE {r.dE.toFixed(1)}</span>
                                </div>
                            </div>
                        ) : <div className="text-slate-400">N/A（此條件下沒有解）</div>}
                    </div>
                );
                return (
                    <div className={`mt-2 rounded px-2 py-1.5 text-[10px] font-mono border ${g.isInside ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-slate-50 text-slate-600 border-slate-100'}`}>
                        {g.isInside ? (
                            <span className="font-bold flex items-center gap-1"><div className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></div> In Gamut</span>
                        ) : g.noSlice ? (
                            <span className="font-bold text-slate-500">Out of Gamut（Gamut 範圍不足以計算）</span>
                        ) : (
                            <div className="flex flex-col w-full">
                                <span className="font-bold text-orange-600 flex items-center gap-1"><CornerRightDown size={10}/> Out of Gamut — Correction A / B / C</span>
                                {row('A', 'Chroma 維持・調整 Hue', g.A, '#f97316')}
                                {row('B', 'Hue 維持・降低 Chroma', g.B, '#22d3ee')}
                                {row('C 建議', '最小 ΔE（最近點）', g.C, '#4ade80')}
                            </div>
                        )}
                    </div>
                );
            })()}
        </div>
    );
};

const CheckSquare = ({size}) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
);

// 手機（<768px）使用底部分頁切換「資料 / 視圖」；平板與桌機維持左右並排
const useIsDesktop = () => {
    const query = '(min-width: 768px)';
    const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
    useEffect(() => {
        const mql = window.matchMedia(query);
        const onChange = (e) => setMatches(e.matches);
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, []);
    return matches;
};

function App() {
    const getInitialData = (key, fallback) => { try { const item = window.localStorage.getItem(key); return item ? JSON.parse(item) : fallback; } catch (error) { return fallback; } };
    const [basePoints, setBasePoints] = useState(() => getInitialData('lab_basePoints', [{ id: 1, l: 80, a: 0, b: 0, name: '', visible: true, showPoint: true }, { id: 2, l: 20, a: 0, b: 0, name: '', visible: true, showPoint: true }, { id: 3, l: 50, a: 80, b: 60, name: '', visible: true, showPoint: true }, { id: 4, l: 50, a: -60, b: -40, name: '', visible: true, showPoint: true }]));
    const [historyPoints, setHistoryPoints] = useState(() => getInitialData('lab_historyPoints', [{ id: 501, l: 60, a: 40, b: -20, name: 'Old Mix', visible: true, showPoint: true }]));
    const [testPoints, setTestPoints] = useState(() => getInitialData('lab_testPoints', [{ id: 101, l: 55, a: 10, b: 10, name: 'Sample A', showPoint: true, isStandard: false }, { id: 102, l: 50, a: 15, b: 5, name: 'Sample B', showPoint: true, isStandard: false }]));
    const [showLabels, setShowLabels] = useState(false);
    const [viewMode, setViewMode] = useState('split');
    const [showCamera, setShowCamera] = useState(false);
    const [mobileTab, setMobileTab] = useState('data');
    const isDesktop = useIsDesktop();
    // 隱藏中的 3D/2D 畫布暫停繪製以節省手機電量
    const viewActive = isDesktop || mobileTab === 'view';
    const fileInputRef = useRef(null);

    // Gamut surface display settings (color L override + opacity), user-adjustable via drag sliders
    const [gamutAutoL, setGamutAutoL] = useState(true);
    const [gamutColorL, setGamutColorL] = useState(() => getInitialData('lab_gamutColorL', 50));
    const [gamutOpacity, setGamutOpacity] = useState(() => getInitialData('lab_gamutOpacity', 0.6));
    const [showGamutPanel, setShowGamutPanel] = useState(false);
    const [gamutMode, setGamutMode] = useState(() => getInitialData('lab_gamutMode', 'projection'));
    const [showCorrections, setShowCorrections] = useState(() => getInitialData('lab_showCorrections', true));
    const [colorByMaterial, setColorByMaterial] = useState(() => getInitialData('lab_colorByMaterial', false));
    const [hiddenMaterials, setHiddenMaterials] = useState(() => getInitialData('lab_hiddenMaterials', []));
    useEffect(() => {
        try {
            window.localStorage.setItem('lab_gamutMode', JSON.stringify(gamutMode));
            window.localStorage.setItem('lab_showCorrections', JSON.stringify(showCorrections));
            window.localStorage.setItem('lab_colorByMaterial', JSON.stringify(colorByMaterial));
            window.localStorage.setItem('lab_hiddenMaterials', JSON.stringify(hiddenMaterials));
        } catch (e) {}
    }, [gamutMode, showCorrections, colorByMaterial, hiddenMaterials]);
    useEffect(() => { window.localStorage.setItem('lab_gamutColorL', JSON.stringify(gamutColorL)); window.localStorage.setItem('lab_gamutOpacity', JSON.stringify(gamutOpacity)); }, [gamutColorL, gamutOpacity]);
    
    // Gamut Calculation Mesh (Memoized)
    const gamutMesh = useMemo(() => {
        const gamutPoints = [...basePoints.filter(p=>p.visible!==false), ...historyPoints.filter(p=>p.visible!==false)];
        if (gamutPoints.length < 4) return null;

        const vectors = gamutPoints.map(p => new THREE.Vector3(p.a, p.l, p.b)); // X=a, Y=l, Z=b
        
        try {
            const geo = new ConvexGeometry(vectors);
            // Critical Fix: Use DoubleSide to ensure Raycaster hits both entry (Top) and exit (Bottom) faces
            const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
            return mesh;
        } catch (e) {
            console.warn("Failed to generate hull for calc", e);
            return null;
        }
    }, [basePoints, historyPoints]);

    useEffect(() => { window.localStorage.setItem('lab_basePoints', JSON.stringify(basePoints)); window.localStorage.setItem('lab_historyPoints', JSON.stringify(historyPoints)); window.localStorage.setItem('lab_testPoints', JSON.stringify(testPoints)); }, [basePoints, historyPoints, testPoints]);
    
    const capture3DRef = useRef(null); const capture2DRef = useRef(null);
    const addPoint = (type) => { const newPoint = { id: Date.now(), l: 50, a: 0, b: 0, name: '', material: '', visible: true, showPoint: true, isStandard: false }; if (type === 'base') setBasePoints([...basePoints, newPoint]); else if (type === 'history') setHistoryPoints([...historyPoints, newPoint]); else setTestPoints([...testPoints, newPoint]); };
    const addFromCamera = (labData) => { const newPoint = { id: Date.now(), l: labData.l, a: labData.a, b: labData.b, name: 'Cam Capture', material: '', visible: true, showPoint: true, isStandard: false }; setTestPoints([...testPoints, newPoint]); };
    const updatePoint = (listType, id, field, value) => { let setter = listType === 'base' ? setBasePoints : (listType === 'history' ? setHistoryPoints : setTestPoints); setter(prev => prev.map(p => p.id === id ? { ...p, [field]: value } : p)); };
    const toggleStandard = (id) => { setTestPoints(prev => prev.map(p => ({ ...p, isStandard: p.id === id ? !p.isStandard : false }))); };
    const deletePoint = (listType, id) => { let setter = listType === 'base' ? setBasePoints : (listType === 'history' ? setHistoryPoints : setTestPoints); setter(prev => prev.filter(p => p.id !== id)); };
    const reset = () => { if(confirm('Are you sure you want to reset all data?')) { setBasePoints([{ id: 1, l: 80, a: 0, b: 0, name: '', visible: true, showPoint: true }, { id: 2, l: 20, a: 0, b: 0, name: '', visible: true, showPoint: true }, { id: 3, l: 50, a: 80, b: 60, name: '', visible: true, showPoint: true }, { id: 4, l: 50, a: -60, b: -40, name: '', visible: true, showPoint: true }]); setHistoryPoints([]); setTestPoints([]); } };
    const standardPoint = testPoints.find(p => p.isStandard);
    
    // Toggle All Helpers
    const toggleAll = (type, field) => {
        let setter = type === 'base' ? setBasePoints : (type === 'history' ? setHistoryPoints : setTestPoints);
        setter(prev => {
            const allTrue = prev.every(p => p[field] !== false); // Note: explicit check against false because undefined/true is visible
            const target = !allTrue;
            return prev.map(p => ({ ...p, [field]: target }));
        });
    };

    const isAllChecked = (points, field) => points.length > 0 && points.every(p => p[field] !== false);

    // Excel Import Handler
    const handleExcelImport = (e) => {
        const file = e.target.files[0];
        if(!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
            try {
                const data = new Uint8Array(evt.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                
                let newBase = [];
                let newHistory = [];
                let newTest = [];

                workbook.SheetNames.forEach(sheetName => {
                    const lowerName = sheetName.toLowerCase();
                    const sheet = workbook.Sheets[sheetName];
                    const json = XLSX.utils.sheet_to_json(sheet);
                    
                    // Helper to parse row
                    const parseRow = (row) => {
                        // Try to find keys case-insensitively
                        const keys = Object.keys(row);
                        const getVal = (k) => {
                            const key = keys.find(key => key.toLowerCase() === k.toLowerCase());
                            return key ? parseFloat(row[key]) : null;
                        };
                        const getName = () => {
                            const key = keys.find(key => key.toLowerCase() === 'name');
                            return key ? row[key] : '';
                        }
                        // 材質欄位：Material（或中文「材質」），可省略
                        const getMaterial = () => {
                            const key = keys.find(key => ['material', '材質'].includes(key.trim().toLowerCase()));
                            return key && row[key] != null ? String(row[key]) : '';
                        }

                        // Look for 'L', 'a', 'b' specifically
                        const l = getVal('l');
                        const a = getVal('a');
                        const b = getVal('b');
                        
                        if (l !== null && a !== null && b !== null && !isNaN(l) && !isNaN(a) && !isNaN(b)) {
                            return {
                                id: Date.now() + Math.random(),
                                l: ColorUtils.clamp(l, 0, 200),
                                a: ColorUtils.clamp(a, -200, 200),
                                b: ColorUtils.clamp(b, -200, 200),
                                name: getName(),
                                material: getMaterial(),
                                visible: true,
                                showPoint: true,
                                isStandard: false
                            };
                        }
                        return null;
                    };

                    const parsedPoints = json.map(parseRow).filter(p => p !== null);

                    if (lowerName.includes('base')) {
                        newBase = [...newBase, ...parsedPoints];
                    } else if (lowerName.includes('history')) {
                        newHistory = [...newHistory, ...parsedPoints];
                    } else if (lowerName.includes('test')) {
                        newTest = [...newTest, ...parsedPoints];
                    }
                });

                if (newBase.length > 0) setBasePoints(prev => [...prev, ...newBase]);
                if (newHistory.length > 0) setHistoryPoints(prev => [...prev, ...newHistory]);
                if (newTest.length > 0) setTestPoints(prev => [...prev, ...newTest]);

                alert(`Imported: ${newBase.length} Base, ${newHistory.length} History, ${newTest.length} Test points.`);
            } catch (err) {
                console.error(err);
                // Updated error message to reflect expected format
                alert("Failed to parse Excel file. Please check format: Name, Material (optional), L, a, b");
            }
            // Reset input
            if (fileInputRef.current) fileInputRef.current.value = '';
        };
        reader.readAsArrayBuffer(file);
    };

    const triggerExcelInput = () => fileInputRef.current && fileInputRef.current.click();

    // Excel Export Handler
    const handleExcelExport = () => {
        const wb = XLSX.utils.book_new();

        // 只輸出名稱、材質與 Lab 值（欄位與匯入格式相同，可直接再匯入）
        const formatData = (points) => points.map(p => ({
            Name: p.name,
            Material: p.material || '',
            L: p.l,
            a: p.a,
            b: p.b
        }));

        if (basePoints.length > 0) {
            const wsBase = XLSX.utils.json_to_sheet(formatData(basePoints));
            XLSX.utils.book_append_sheet(wb, wsBase, "Base Points");
        }
        if (historyPoints.length > 0) {
            const wsHist = XLSX.utils.json_to_sheet(formatData(historyPoints));
            XLSX.utils.book_append_sheet(wb, wsHist, "History Points");
        }
        if (testPoints.length > 0) {
            // Test Points 另外附上 In Gamut 狀態與 A/B/C 修正結果（匯入時會忽略這些欄位）
            const corrCols = (p) => {
                const g = (processedTestPoints.find(q => q.id === p.id) || {}).gamutDeltas;
                const out = { InGamut: !g ? 'N/A' : (g.isInside ? 'Yes' : 'No') };
                ['A', 'B', 'C'].forEach(k => {
                    const r = g && !g.isInside ? g[k] : null;
                    out[`${k}_L`] = r ? +r.l.toFixed(2) : ''; out[`${k}_a`] = r ? +r.a.toFixed(2) : ''; out[`${k}_b`] = r ? +r.b.toFixed(2) : '';
                });
                return out;
            };
            const wsTest = XLSX.utils.json_to_sheet(formatData(testPoints).map((row, i) => ({ ...row, ...corrCols(testPoints[i]) })));
            XLSX.utils.book_append_sheet(wb, wsTest, "Test Points");
        }

        const base64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
        saveFile("lab_gamut_data.xlsx", base64, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
            .catch(err => { console.warn('Excel export failed', err); alert('Export failed. Please try again.'); });
    };

    // JSON 完整備份：所有資料點 + 設定
    const jsonInputRef = useRef(null);
    const handleJsonExport = () => {
        let camRoiPct = null;
        try { const v = parseFloat(localStorage.getItem('lab_camRoiPct')); if (v >= 3 && v <= 40) camRoiPct = v; } catch (e) {}
        const payload = {
            app: 'lab-gamut-simulator',
            version: 1,
            exportedAt: new Date().toISOString(),
            points: { base: basePoints, history: historyPoints, test: testPoints },
            settings: { gamutAutoL, gamutColorL, gamutOpacity, showLabels, viewMode, camRoiPct, gamutMode, showCorrections, colorByMaterial, hiddenMaterials },
            // 計算結果（僅供參考，匯入時不會讀取）
            corrections: processedTestPoints.map(p => ({ id: p.id, name: p.name, material: p.material || '', inGamut: p.gamutDeltas ? !!p.gamutDeltas.isInside : null, A: p.gamutDeltas && p.gamutDeltas.A || null, B: p.gamutDeltas && p.gamutDeltas.B || null, C: p.gamutDeltas && p.gamutDeltas.C || null }))
        };
        const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
        let bin = ''; bytes.forEach(c => { bin += String.fromCharCode(c); });
        const stamp = new Date().toISOString().slice(0, 19).split('-').join('').split(':').join('').split('T').join('');
        saveFile(`lab_gamut_backup_${stamp}.json`, btoa(bin), 'application/json')
            .catch(err => { console.warn('JSON export failed', err); alert('Export failed. Please try again.'); });
    };
    const handleJsonImport = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            try {
                const data = JSON.parse(evt.target.result);
                const pts = data && data.points;
                if (!pts || !Array.isArray(pts.base) || !Array.isArray(pts.history) || !Array.isArray(pts.test)) throw new Error('bad format');
                const clean = (list) => list.filter(p => p && isFinite(p.l) && isFinite(p.a) && isFinite(p.b)).map((p, i) => ({
                    ...p, id: p.id != null ? p.id : Date.now() + i, l: Number(p.l), a: Number(p.a), b: Number(p.b),
                    name: p.name != null ? String(p.name) : '', material: p.material != null ? String(p.material) : ''
                }));
                if (!confirm('Importing will REPLACE all current points and settings. Continue?')) return;
                const nb = clean(pts.base), nh = clean(pts.history), nt = clean(pts.test);
                setBasePoints(nb); setHistoryPoints(nh); setTestPoints(nt);
                const st = data.settings || {};
                if (typeof st.gamutAutoL === 'boolean') setGamutAutoL(st.gamutAutoL);
                if (isFinite(st.gamutColorL)) setGamutColorL(Number(st.gamutColorL));
                if (isFinite(st.gamutOpacity)) setGamutOpacity(Number(st.gamutOpacity));
                if (typeof st.showLabels === 'boolean') setShowLabels(st.showLabels);
                if (typeof st.viewMode === 'string') setViewMode(st.viewMode);
                if (st.gamutMode === 'projection' || st.gamutMode === 'slice') setGamutMode(st.gamutMode);
                if (typeof st.showCorrections === 'boolean') setShowCorrections(st.showCorrections);
                if (typeof st.colorByMaterial === 'boolean') setColorByMaterial(st.colorByMaterial);
                if (Array.isArray(st.hiddenMaterials)) setHiddenMaterials(st.hiddenMaterials.map(String));
                if (isFinite(st.camRoiPct)) { try { localStorage.setItem('lab_camRoiPct', String(st.camRoiPct)); } catch (err) {} }
                alert(`Restored: ${nb.length} Base, ${nh.length} History, ${nt.length} Test points and settings.`);
            } catch (err) {
                console.error(err);
                alert('Failed to read JSON file. Please choose a backup exported by this app.');
            }
            if (jsonInputRef.current) jsonInputRef.current.value = '';
        };
        reader.readAsText(file);
    };

    // 材質清單、篩選與配色
    const MATERIAL_PALETTE = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#a78bfa', '#fb7185', '#2dd4bf', '#f97316', '#818cf8', '#4ade80'];
    const materials = useMemo(() => {
        const set = new Set([...basePoints, ...historyPoints, ...testPoints].map(p => (p.material || '').trim()));
        return [...set].sort((x, y) => (x === '' ? 1 : y === '' ? -1 : x.localeCompare(y)));
    }, [basePoints, historyPoints, testPoints]);
    const materialSwatch = (m) => m === '' ? '#9ca3af' : MATERIAL_PALETTE[materials.filter(x => x !== '').indexOf(m) % MATERIAL_PALETTE.length];
    const matShown = useMemo(() => (p) => !hiddenMaterials.includes((p.material || '').trim()), [hiddenMaterials]);
    const matColor = (p) => colorByMaterial ? materialSwatch((p.material || '').trim()) : null;
    const toggleMaterial = (m) => setHiddenMaterials(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]);

    // Process test points to add DeltaE and Gamut Delta info
    const processedTestPoints = testPoints.map(p => { 
        let processed = { ...p };
        // Delta E
        if (standardPoint && p.id !== standardPoint.id) { 
            processed.deltaE = ColorUtils.calculateDeltaE(standardPoint, p); 
        }
        // Gamut Delta
        if (gamutMesh) {
            processed.gamutDeltas = GamutUtils.calculateCorrections(p, gamutMesh, gamutMode);
        }
        return processed; 
    });

    return (
        <div className="fixed inset-0 flex flex-col md:flex-row w-full h-full bg-[#1e1e24] md:bg-slate-50 font-sans text-gray-800 overflow-hidden" style={{ paddingTop: 'env(safe-area-inset-top)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}>
            <input type="file" ref={jsonInputRef} onChange={handleJsonImport} accept=".json,application/json" className="hidden" />
            {showCamera && <CameraPicker onCapture={addFromCamera} onClose={() => setShowCamera(false)} />}
            <input type="file" ref={fileInputRef} onChange={handleExcelImport} accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" className="hidden" />
            {/* 材質欄位的輸入建議：列出已輸入過的材質 */}
            <datalist id="material-options">
                {[...new Set([...basePoints, ...historyPoints, ...testPoints].map(p => (p.material || '').trim()).filter(Boolean))].map(m => <option key={m} value={m} />)}
            </datalist>
            <nav className="order-last md:hidden shrink-0 flex bg-[#1e1e24] border-t border-white/10" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
                {[['data', 'Points', List], ['view', 'Viewer', Box]].map(([key, label, Icon]) => (
                    <button key={key} onClick={() => setMobileTab(key)} aria-current={mobileTab === key ? 'page' : undefined} className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-bold transition-colors active:bg-white/5 ${mobileTab === key ? 'text-blue-400' : 'text-gray-500'}`}>
                        <Icon size={22} />{label}
                    </button>
                ))}
            </nav>
            
            <div className={`${mobileTab === 'data' ? 'flex' : 'hidden'} md:flex w-full md:w-1/2 flex-col bg-white border-r border-gray-200 flex-1 min-h-0 md:flex-none md:h-full z-10 shadow-xl overflow-hidden`}>
                <div className="p-4 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-white flex justify-between items-center flex-shrink-0">
                    <div className="flex items-center gap-2"><div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold shadow-blue-200 shadow-lg">Lab</div><h1 className="text-lg font-bold text-gray-800">Gamut Simulator</h1></div>
                    <div className="flex gap-2">
                        <button onClick={triggerExcelInput} className="p-2.5 md:p-2 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-full transition-all" title="Import Excel"><FileSpreadsheet size={18} /></button>
                        <button onClick={handleExcelExport} className="p-2.5 md:p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-full transition-all" title="Export Excel (.xlsx: Name, Material, L, a, b)"><Download size={18} /></button>
                        <button onClick={handleJsonExport} className="p-2.5 md:p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-all" title="Export all data & settings (.json)"><FileDown size={18} /></button>
                        <button onClick={() => jsonInputRef.current && jsonInputRef.current.click()} className="p-2.5 md:p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-all" title="Import backup (.json)"><FileUp size={18} /></button>
                        <button onClick={reset} className="p-2.5 md:p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-full transition-all" title="Reset"><RotateCcw size={18} /></button>
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto p-3 md:p-4 space-y-4 md:space-y-6 custom-scrollbar min-w-0 overscroll-contain">
                    <div className="bg-slate-50 p-3 rounded-xl border border-slate-100 flex flex-col md:max-h-[320px]">
                        <div className="flex justify-between items-center mb-3 flex-shrink-0">
                            <div className="flex items-center gap-2">
                                <h2 className="text-sm font-bold flex items-center gap-2 text-slate-700"><div className="w-2.5 h-2.5 rounded-full bg-blue-500 shadow-sm"></div> Base Points</h2>
                                <div className="flex items-center gap-1 ml-2 border-l border-slate-200 pl-2">
                                    <button onClick={() => toggleAll('base', 'visible')} className={`w-8 h-8 md:w-5 md:h-5 flex items-center justify-center rounded hover:bg-blue-100 transition-colors ${isAllChecked(basePoints, 'visible') ? 'text-blue-600' : 'text-gray-400'}`} title="Select/Deselect All Gamut">{isAllChecked(basePoints, 'visible') ? <CheckSquareIcon size={14} /> : <Square size={14} />}</button>
                                    <button onClick={() => toggleAll('base', 'showPoint')} className={`w-8 h-8 md:w-5 md:h-5 flex items-center justify-center rounded hover:bg-blue-100 transition-colors ${isAllChecked(basePoints, 'showPoint') ? 'text-gray-600' : 'text-gray-400'}`} title="Show/Hide All Points"><Eye size={14} /></button>
                                </div>
                            </div>
                            <button onClick={() => addPoint('base')} className="flex items-center gap-1 text-xs bg-white border border-blue-200 hover:border-blue-400 text-blue-600 px-3.5 py-2.5 md:px-3 md:py-1.5 rounded-full shadow-sm transition-all active:scale-95"><Plus size={14} /> <span className="font-medium">Add</span></button>
                        </div>
                        <div className="space-y-1 md:overflow-y-auto md:pr-2 custom-scrollbar flex-1">{basePoints.map(p => <InputRow key={p.id} point={p} onChange={(id, f, v) => updatePoint('base', id, f, v)} onDelete={(id) => deletePoint('base', id)} />)}</div>
                    </div>
                    
                    <div className="bg-orange-50 p-3 rounded-xl border border-orange-100 flex flex-col md:max-h-[320px]">
                        <div className="flex justify-between items-center mb-3 flex-shrink-0">
                            <div className="flex items-center gap-2">
                                <h2 className="text-sm font-bold flex items-center gap-2 text-orange-900"><div className="w-2.5 h-2.5 rounded-full bg-orange-500 shadow-sm"></div> History Points</h2>
                                <div className="flex items-center gap-1 ml-2 border-l border-orange-200 pl-2">
                                    <button onClick={() => toggleAll('history', 'visible')} className={`w-8 h-8 md:w-5 md:h-5 flex items-center justify-center rounded hover:bg-orange-200 transition-colors ${isAllChecked(historyPoints, 'visible') ? 'text-blue-600' : 'text-gray-400'}`} title="Select/Deselect All Gamut">{isAllChecked(historyPoints, 'visible') ? <CheckSquareIcon size={14} /> : <Square size={14} />}</button>
                                    <button onClick={() => toggleAll('history', 'showPoint')} className={`w-8 h-8 md:w-5 md:h-5 flex items-center justify-center rounded hover:bg-orange-200 transition-colors ${isAllChecked(historyPoints, 'showPoint') ? 'text-gray-600' : 'text-gray-400'}`} title="Show/Hide All Points"><Eye size={14} /></button>
                                </div>
                            </div>
                            <button onClick={() => addPoint('history')} className="flex items-center gap-1 text-xs bg-white border border-orange-200 hover:border-orange-400 text-orange-600 px-3.5 py-2.5 md:px-3 md:py-1.5 rounded-full shadow-sm transition-all active:scale-95"><Plus size={14} /> <span className="font-medium">Add</span></button>
                        </div>
                        <div className="space-y-1 md:overflow-y-auto md:pr-2 custom-scrollbar flex-1">{historyPoints.map(p => <InputRow key={p.id} point={p} inputColorClass="text-orange-700" onChange={(id, f, v) => updatePoint('history', id, f, v)} onDelete={(id) => deletePoint('history', id)} />)}</div>
                    </div>
                    
                    <div className="bg-purple-50 p-3 rounded-xl border border-purple-100 flex flex-col md:max-h-[40vh]">
                        <div className="flex justify-between items-center mb-3 flex-shrink-0">
                            <div className="flex items-center gap-2">
                                <h2 className="text-sm font-bold flex items-center gap-2 text-purple-900"><div className="w-2.5 h-2.5 rounded-sm bg-purple-600 shadow-sm"></div> Test Points</h2>
                                <div className="flex items-center gap-1 ml-2 border-l border-purple-200 pl-2">
                                    <button onClick={() => toggleAll('test', 'showPoint')} className={`w-8 h-8 md:w-5 md:h-5 flex items-center justify-center rounded hover:bg-purple-200 transition-colors ${isAllChecked(testPoints, 'showPoint') ? 'text-gray-600' : 'text-gray-400'}`} title="Show/Hide All Points"><Eye size={14} /></button>
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <button onClick={() => setShowCamera(true)} className="flex items-center gap-1 text-xs bg-white border border-purple-200 hover:border-purple-400 text-purple-600 px-3.5 py-2.5 md:px-3 md:py-1.5 rounded-full shadow-sm transition-all active:scale-95" title="Camera Picker"><Camera size={14} /></button>
                                <button onClick={() => addPoint('test')} className="flex items-center gap-1 text-xs bg-white border border-purple-200 hover:border-purple-400 text-purple-600 px-3.5 py-2.5 md:px-3 md:py-1.5 rounded-full shadow-sm transition-all active:scale-95"><Plus size={14} /> <span className="font-medium">Add</span></button>
                            </div>
                        </div>
                        <div className="space-y-1 md:overflow-y-auto md:pr-2 custom-scrollbar flex-1">{processedTestPoints.map(p => <InputRow key={p.id} point={p} isTestPoint={true} inputColorClass="text-purple-700" isStandard={p.isStandard} deltaE={p.deltaE} onChange={(id, f, v) => updatePoint('test', id, f, v)} onDelete={(id) => deletePoint('test', id)} onToggleStandard={toggleStandard} />)}</div>
                    </div>
                </div>
            </div>
            <div className={`${mobileTab === 'view' ? 'flex' : 'hidden'} md:flex flex-1 relative min-h-0 md:h-full flex-col bg-[#1e1e24] overflow-hidden min-w-0`}>
                <div className="relative flex items-center justify-center p-2 bg-[#1e1e24] border-b border-white/10 shrink-0 z-30">
                    <div className="flex bg-black/40 rounded-lg p-1 border border-white/10">
                        <button onClick={() => setViewMode('3d')} className={`px-4 py-2 md:py-1.5 text-xs font-bold rounded-md transition-all ${viewMode === '3d' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}>3D</button>
                        <button onClick={() => setViewMode('2d')} className={`px-4 py-2 md:py-1.5 text-xs font-bold rounded-md transition-all ${viewMode === '2d' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}>2D</button>
                        <button onClick={() => setViewMode('split')} className={`px-4 py-2 md:py-1.5 text-xs font-bold rounded-md transition-all ${viewMode === 'split' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}>Split</button>
                    </div>
                    <button
                        onClick={() => setShowGamutPanel(!showGamutPanel)}
                        className={`absolute right-3 top-1/2 -translate-y-1/2 p-2.5 md:p-2 rounded-lg border transition-all active:scale-95 ${showGamutPanel ? 'bg-blue-600 text-white border-blue-500' : 'bg-black/40 text-white/70 border-white/10 hover:bg-white/10'}`}
                        title="View Settings"
                    >
                        <SlidersHorizontal size={16} />
                    </button>
                    <GamutDisplayPanel
                        open={showGamutPanel}
                        onClose={() => setShowGamutPanel(false)}
                        autoL={gamutAutoL}
                        setAutoL={setGamutAutoL}
                        colorL={gamutColorL}
                        setColorL={setGamutColorL}
                        opacity={gamutOpacity}
                        setOpacity={setGamutOpacity}
                        gamutMode={gamutMode}
                        setGamutMode={setGamutMode}
                        showCorrections={showCorrections}
                        setShowCorrections={setShowCorrections}
                        materials={materials}
                        hiddenMaterials={hiddenMaterials}
                        toggleMaterial={toggleMaterial}
                        setHiddenMaterials={setHiddenMaterials}
                        colorByMaterial={colorByMaterial}
                        setColorByMaterial={setColorByMaterial}
                        materialSwatch={materialSwatch}
                    />
                </div>
                <div className="flex-1 relative flex flex-col">
                    {(viewMode === '3d' || viewMode === 'split') && <div className={`relative ${viewMode === 'split' ? 'h-1/2 border-b border-white/10' : 'h-full'}`}><ViewContainer title="3D View" onCapture={() => capture3DRef.current && capture3DRef.current()} onToggleLabels={() => setShowLabels(!showLabels)} showLabels={showLabels}><Canvas frameloop={viewActive ? 'always' : 'never'} camera={{ position: [200, 150, 200], fov: 40 }} dpr={[1, 2]}><color attach="background" args={['#1e1e24']} /><Scene3D basePoints={basePoints} historyPoints={historyPoints} testPoints={processedTestPoints} captureRef={capture3DRef} showLabels={showLabels} gamutColorL={gamutColorL} gamutAutoL={gamutAutoL} gamutOpacity={gamutOpacity} showCorrections={showCorrections} matShown={matShown} matColor={matColor} /></Canvas></ViewContainer></div>}
                    {(viewMode === '2d' || viewMode === 'split') && <div className={`relative ${viewMode === 'split' ? 'h-1/2' : 'h-full'}`}><ViewContainer title="2D View (a-b)" onCapture={() => capture2DRef.current && capture2DRef.current()} onToggleLabels={() => setShowLabels(!showLabels)} showLabels={showLabels}><Canvas frameloop={viewActive ? 'always' : 'never'} orthographic camera={{ position: [0, 0, 100], zoom: 1.5, near: 0.1, far: 1000 }} dpr={[1, 2]}><color attach="background" args={['#18181b']} /><Scene2D basePoints={basePoints} historyPoints={historyPoints} testPoints={processedTestPoints} captureRef={capture2DRef} showLabels={showLabels} gamutColorL={gamutColorL} gamutAutoL={gamutAutoL} gamutOpacity={gamutOpacity} showCorrections={showCorrections} matShown={matShown} matColor={matColor} /></Canvas></ViewContainer></div>}
                </div>
            </div>
        </div>
    );
}
const root = createRoot(document.getElementById('root')); root.render(<App />);
