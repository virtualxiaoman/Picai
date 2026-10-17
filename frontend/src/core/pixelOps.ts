/**
 * 全分辨率像素运算（纯函数，可单元测试；在 Web Worker 中执行）。
 * 蒙版约定：0 = 未选中，255 = 完全选中，中间值为软边缘权重。
 */

import type { PixelOp } from '../types';

/** 颜色距离归一化系数（加权欧氏距离的理论最大值 ≈ 3.464*255） */
const COLOR_DIST_SCALE = 3.4641;

/**
 * 加权欧氏颜色距离（redmean 近似），更符合人眼感知；
 * 返回 0-255 区间的距离，便于容差参数直观理解。
 */
export function colorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const rmean = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  const dist = Math.sqrt(
    (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db,
  );
  return dist / COLOR_DIST_SCALE;
}

/**
 * 按蒙版权重对 RGBA 像素执行操作（原地修改）。
 * - 透明化：newAlpha = alpha * (255 - mask) / 255
 * - 纯色替换：RGB 按 mask/255 与目标色混合，Alpha 不变
 * - 渐变替换：RGB 按 mask/255 与渐变采样色混合
 * - mask = 0 的像素严格不变
 */
export function applyPixelOp(
  pixels: Uint8ClampedArray,
  mask: Uint8Array | Uint8ClampedArray,
  op: PixelOp,
  width: number,
  height: number,
): void {
  const count = mask.length;
  if (op.type === 'transparent') {
    for (let i = 0; i < count; i++) {
      const m = mask[i];
      if (m === 0) continue;
      const a = i * 4 + 3;
      pixels[a] = (pixels[a] * (255 - m)) / 255;
    }
    return;
  }
  if (op.type === 'color_shift') {
    applyColorShift(pixels, mask, op.target, strengthOf(op.strength), op.mode, op.targetStd);
    return;
  }
  if (op.type === 'flatten_wrinkles') {
    flattenWrinkles(
      pixels,
      mask,
      width,
      height,
      op.strength,
      op.scale,
      op.textureKeep,
    );
    return;
  }
  if (op.type === 'solid') {
    const [r, g, b] = op.color;
    for (let i = 0; i < count; i++) {
      const m = mask[i];
      if (m === 0) continue;
      const w = m / 255;
      const p = i * 4;
      pixels[p] = pixels[p] + (r - pixels[p]) * w;
      pixels[p + 1] = pixels[p + 1] + (g - pixels[p + 1]) * w;
      pixels[p + 2] = pixels[p + 2] + (b - pixels[p + 2]) * w;
    }
    return;
  }
  // 线性渐变替换
  const rad = (op.angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const { color1, color2 } = op;
  // 以像素中心为基准：首像素投影为 0、末像素投影为 1
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const halfExtent = (Math.abs(dx) * (width - 1) + Math.abs(dy) * (height - 1)) / 2 || 1;
  const rangeStart = op.start;
  const rangeEnd = op.end;
  const rangeSpan = Math.max(1e-6, rangeEnd - rangeStart);
  for (let y = 0; y < height; y++) {
    const py = y - cy;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const m = mask[i];
      if (m === 0) continue;
      const proj = (x - cx) * dx + py * dy;
      const t = Math.min(1, Math.max(0, (proj / halfExtent + 1) / 2));
      const tt = Math.min(1, Math.max(0, (t - rangeStart) / rangeSpan));
      const r = color1[0] + (color2[0] - color1[0]) * tt;
      const g = color1[1] + (color2[1] - color1[1]) * tt;
      const b = color1[2] + (color2[2] - color1[2]) * tt;
      const w = m / 255;
      const p = i * 4;
      pixels[p] = pixels[p] + (r - pixels[p]) * w;
      pixels[p + 1] = pixels[p + 1] + (g - pixels[p + 1]) * w;
      pixels[p + 2] = pixels[p + 2] + (b - pixels[p + 2]) * w;
    }
  }
}

/** 从 RGBA 数据中提取蒙版灰度值（取 Alpha 通道） */
export function alphaToGray(rgba: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  const count = rgba.length / 4;
  const gray = new Uint8ClampedArray(count);
  for (let i = 0; i < count; i++) gray[i] = rgba[i * 4 + 3];
  return gray;
}

/**
 * 灰度蒙版 -> RGBA 数据（白色 + Alpha=灰度），用于写回蒙版画布。
 * 之所以用「白底 Alpha」表示蒙版，是为了让画布的 source-over /
 * destination-out / destination-in 复合运算直接等价于选区的增减交。
 */
export function grayToRgba(gray: Uint8Array | Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(gray.length * 4);
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4;
    rgba[p] = 255;
    rgba[p + 1] = 255;
    rgba[p + 2] = 255;
    rgba[p + 3] = gray[i];
  }
  return rgba;
}

/** '#rrggbb' -> [r, g, b] */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// ---------- 色彩靠近（Lab 均值偏移迁移） ----------

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(1, v)) * 255;
}

function labF(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

function labFInv(t: number): number {
  const t3 = t * t * t;
  return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
}

/** sRGB -> CIELAB（D65） */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  const x = 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
  const z = 0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl;
  const fx = labF(x / 0.95047);
  const fy = labF(y);
  const fz = labF(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIELAB -> sRGB（含色域裁剪） */
export function labToRgb(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = 0.95047 * labFInv(fx);
  const y = labFInv(fy);
  const z = 1.08883 * labFInv(fz);
  const rl = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const gl = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [linearToSrgb(rl), linearToSrgb(gl), linearToSrgb(bl)];
}

function strengthOf(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** 计算蒙版区域（按蒙版权重）的 Lab 加权均值与标准差 */
function maskedLabStats(
  pixels: Uint8ClampedArray,
  mask: Uint8Array | Uint8ClampedArray,
): { mean: [number, number, number]; std: [number, number, number]; weight: number } | null {
  let w = 0;
  let mL = 0;
  let mA = 0;
  let mB = 0;
  let sL = 0;
  let sA = 0;
  let sB = 0;
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i];
    if (m === 0) continue;
    const p = i * 4;
    const lab = rgbToLab(pixels[p], pixels[p + 1], pixels[p + 2]);
    mL += lab[0] * m;
    mA += lab[1] * m;
    mB += lab[2] * m;
    sL += lab[0] * lab[0] * m;
    sA += lab[1] * lab[1] * m;
    sB += lab[2] * lab[2] * m;
    w += m;
  }
  if (w === 0) return null;
  const mean: [number, number, number] = [mL / w, mA / w, mB / w];
  const std: [number, number, number] = [
    Math.sqrt(Math.max(0, sL / w - mean[0] * mean[0])),
    Math.sqrt(Math.max(0, sA / w - mean[1] * mean[1])),
    Math.sqrt(Math.max(0, sB / w - mean[2] * mean[2])),
  ];
  return { mean, std, weight: w };
}

/** Lab -> LCh（明度、饱和度、色相弧度） */
function labToLch(l: number, a: number, b: number): [number, number, number] {
  return [l, Math.hypot(a, b), Math.atan2(b, a)];
}

function lchToLab(l: number, c: number, h: number): [number, number, number] {
  return [l, c * Math.cos(h), c * Math.sin(h)];
}

/** 最短路径色相差 */
function hueDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * 色彩靠近核心（三种迁移模式）：
 * - offset：区域均值 -> 目标色的加性偏移，明暗纹理完全保留
 * - hue：仅旋转色相（保留 L 与 C），灰度/低饱和像素不迁移
 * - match：均值与标准差同时向目标对齐（分布匹配）
 */
function applyColorShift(
  pixels: Uint8ClampedArray,
  mask: Uint8Array | Uint8ClampedArray,
  target: [number, number, number],
  strength: number,
  mode: 'offset' | 'hue' | 'match',
  targetStd?: [number, number, number],
): void {
  const s = strength;
  if (s === 0) return;
  const stats = maskedLabStats(pixels, mask);
  if (!stats) return;
  const mean1 = stats.mean;
  const std1 = stats.std;
  const tgt = rgbToLab(target[0], target[1], target[2]);
  const count = mask.length;

  if (mode === 'hue') {
    const mean1Lch = labToLch(mean1[0], mean1[1], mean1[2]);
    const tgtLch = labToLch(tgt[0], tgt[1], tgt[2]);
    const deltaH = hueDelta(mean1Lch[2], tgtLch[2]) * s;
    if (deltaH === 0) return;
    for (let i = 0; i < count; i++) {
      const m = mask[i];
      if (m === 0) continue;
      const p = i * 4;
      const lab = rgbToLab(pixels[p], pixels[p + 1], pixels[p + 2]);
      const lch = labToLch(lab[0], lab[1], lab[2]);
      if (lch[1] <= 2) continue; // 近灰色像素无有意义色相，保持不变
      const shifted = labToRgb(...lchToLab(lch[0], lch[1], lch[2] + deltaH));
      const w = m / 255;
      pixels[p] = pixels[p] + (shifted[0] - pixels[p]) * w;
      pixels[p + 1] = pixels[p + 1] + (shifted[1] - pixels[p + 1]) * w;
      pixels[p + 2] = pixels[p + 2] + (shifted[2] - pixels[p + 2]) * w;
    }
    return;
  }

  if (mode === 'match') {
    const stdT = targetStd ?? [0, 0, 0];
    const K: [number, number, number] = [0, 0, 0];
    const M: [number, number, number] = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      // stdT 为 0（点色/手动色目标）时 scale 为 0：强度拉满即靠向纯色；
      // 上限 5 防止应用区域本身接近均匀时对比度被放大过度
      const base = Math.max(std1[ch], 1e-3);
      const scale = Math.min(5, Math.max(0, stdT[ch] / base));
      K[ch] = 1 + (scale - 1) * s;
      M[ch] = mean1[ch] + (tgt[ch] - mean1[ch]) * s;
    }
    for (let i = 0; i < count; i++) {
      const m = mask[i];
      if (m === 0) continue;
      const p = i * 4;
      const lab = rgbToLab(pixels[p], pixels[p + 1], pixels[p + 2]);
      const nl = Math.min(100, Math.max(0, (lab[0] - mean1[0]) * K[0] + M[0]));
      const na = Math.min(127, Math.max(-128, (lab[1] - mean1[1]) * K[1] + M[1]));
      const nb = Math.min(127, Math.max(-128, (lab[2] - mean1[2]) * K[2] + M[2]));
      const shifted = labToRgb(nl, na, nb);
      const w = m / 255;
      pixels[p] = pixels[p] + (shifted[0] - pixels[p]) * w;
      pixels[p + 1] = pixels[p + 1] + (shifted[1] - pixels[p + 1]) * w;
      pixels[p + 2] = pixels[p + 2] + (shifted[2] - pixels[p + 2]) * w;
    }
    return;
  }

  // offset：加性偏移（默认）
  const dL = (tgt[0] - mean1[0]) * s;
  const da = (tgt[1] - mean1[1]) * s;
  const db = (tgt[2] - mean1[2]) * s;
  if (dL === 0 && da === 0 && db === 0) return;
  for (let i = 0; i < count; i++) {
    const m = mask[i];
    if (m === 0) continue;
    const p = i * 4;
    const lab = rgbToLab(pixels[p], pixels[p + 1], pixels[p + 2]);
    const nl = Math.min(100, Math.max(0, lab[0] + dL));
    const shifted = labToRgb(nl, lab[1] + da, lab[2] + db);
    const w = m / 255;
    pixels[p] = pixels[p] + (shifted[0] - pixels[p]) * w;
    pixels[p + 1] = pixels[p + 1] + (shifted[1] - pixels[p + 1]) * w;
    pixels[p + 2] = pixels[p + 2] + (shifted[2] - pixels[p + 2]) * w;
  }
}

/** 蒙版区域加权平均色（RGB，无像素时返回 null） */
export function maskedMeanColor(
  pixels: Uint8ClampedArray,
  gray: Uint8Array | Uint8ClampedArray,
): [number, number, number] | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i < gray.length; i++) {
    const m = gray[i];
    if (m === 0) continue;
    const p = i * 4;
    r += pixels[p] * m;
    g += pixels[p + 1] * m;
    b += pixels[p + 2] * m;
    w += m;
  }
  if (w === 0) return null;
  return [r / w, g / w, b / w];
}

/**
 * 蒙版区域众数色：按 RGB 高 4 位量化到 16³ 色块，取权重最大的色块，
 * 返回该色块内像素的加权均值。
 */
export function maskedModeColor(
  pixels: Uint8ClampedArray,
  gray: Uint8Array | Uint8ClampedArray,
): [number, number, number] | null {
  const counts = new Float64Array(4096);
  const sumR = new Float64Array(4096);
  const sumG = new Float64Array(4096);
  const sumB = new Float64Array(4096);
  for (let i = 0; i < gray.length; i++) {
    const m = gray[i];
    if (m === 0) continue;
    const p = i * 4;
    const bin = ((pixels[p] >> 4) << 8) | ((pixels[p + 1] >> 4) << 4) | (pixels[p + 2] >> 4);
    counts[bin] += m;
    sumR[bin] += pixels[p] * m;
    sumG[bin] += pixels[p + 1] * m;
    sumB[bin] += pixels[p + 2] * m;
  }
  let best = -1;
  for (let bin = 0; bin < 4096; bin++) {
    if (counts[bin] > 0 && (best === -1 || counts[bin] > counts[best])) best = bin;
  }
  if (best === -1) return null;
  return [sumR[best] / counts[best], sumG[best] / counts[best], sumB[best] / counts[best]];
}

// ---------- AI 前后差异蒙版 ----------

/**
 * 比较原图与 AI 结果，自动得到“被修改的区域”蒙版。
 * 原图透明区域先按白底合成（与发送给 AI 服务端时的处理一致），再按感知颜色距离比较。
 */
export function diffMask(
  original: Uint8ClampedArray,
  modified: Uint8ClampedArray,
  threshold: number,
): Uint8ClampedArray<ArrayBuffer> {
  const count = original.length / 4;
  const out = new Uint8ClampedArray(count);
  const limit = Math.max(0, threshold);
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    const alpha = original[p + 3] / 255;
    const r = original[p] * alpha + 255 * (1 - alpha);
    const g = original[p + 1] * alpha + 255 * (1 - alpha);
    const b = original[p + 2] * alpha + 255 * (1 - alpha);
    if (colorDistance(r, g, b, modified[p], modified[p + 1], modified[p + 2]) > limit) {
      out[i] = 255;
    }
  }
  return out;
}

// ---------- 抚平褶皱（频率分解） ----------

/** 浮点灰度可分离盒模糊（用于提取低频照明/褶皱阴影） */
function boxBlurFloat(
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) {
    dst.set(src);
    return;
  }
  const win = r * 2 + 1;
  const tmp = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + Math.min(width - 1, Math.max(0, i))];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / win;
      const outIdx = Math.min(width - 1, Math.max(0, x - r));
      const inIdx = Math.min(width - 1, Math.max(0, x + r + 1));
      sum += src[row + inIdx] - src[row + outIdx];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += tmp[Math.min(height - 1, Math.max(0, i)) * width + x];
    for (let y = 0; y < height; y++) {
      dst[y * width + x] = sum / win;
      const outIdx = Math.min(height - 1, Math.max(0, y - r));
      const inIdx = Math.min(height - 1, Math.max(0, y + r + 1));
      sum += tmp[inIdx * width + x] - tmp[outIdx * width + x];
    }
  }
}

/**
 * 抚平褶皱：亮度 = 低频（照明/褶皱阴影） + 高频（布料纹理）。
 * 将低频向区域均值压平（strength），高频纹理按 textureKeep 保留，
 * 按蒙版权重混合；颜色以亮度比例缩放（保持色相）。
 */
function flattenWrinkles(
  pixels: Uint8ClampedArray,
  mask: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  strength: number,
  scale: number,
  textureKeep: number,
): void {
  const s = strengthOf(strength);
  if (s === 0) return;
  const keep = strengthOf(textureKeep);
  const total = width * height;

  const lum = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const p = i * 4;
    lum[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
  }

  // 三遍盒模糊近似大半径高斯 → 低频
  const passRadius = Math.max(1, Math.round(scale / 3));
  let current: Float32Array = lum;
  for (let pass = 0; pass < 3; pass++) {
    const next = new Float32Array(total);
    boxBlurFloat(current, next, width, height, passRadius);
    current = next;
  }
  const low = current;

  // 蒙版内低频均值 = 压平目标
  let sum = 0;
  let weight = 0;
  for (let i = 0; i < total; i++) {
    const m = mask[i];
    if (m === 0) continue;
    sum += low[i] * m;
    weight += m;
  }
  if (weight === 0) return;
  const meanLow = sum / weight;
  const lowKeep = 1 - s;

  for (let i = 0; i < total; i++) {
    const m = mask[i];
    if (m === 0) continue;
    const L = lum[i];
    if (L < 1) continue;
    const detail = L - low[i];
    const targetS = meanLow + (low[i] - meanLow) * lowKeep;
    let targetL = targetS + detail * keep;
    targetL = Math.min(255, Math.max(0, targetL));
    const factor = Math.min(5, Math.max(0.2, targetL / L));
    const w = m / 255;
    const p = i * 4;
    pixels[p] = pixels[p] + (pixels[p] * factor - pixels[p]) * w;
    pixels[p + 1] = pixels[p + 1] + (pixels[p + 1] * factor - pixels[p + 1]) * w;
    pixels[p + 2] = pixels[p + 2] + (pixels[p + 2] * factor - pixels[p + 2]) * w;
  }
}

// ---------- 蒙版后处理 ----------

/** 一维滑动盒滤波（行内），用于可分离盒模糊 */
function boxBlur1D(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  start: number,
  stride: number,
  count: number,
  radius: number,
): void {
  const window = radius * 2 + 1;
  let sum = 0;
  // 初始化窗口（左边缘钳制）
  for (let i = -radius; i <= radius; i++) {
    sum += src[start + Math.min(count - 1, Math.max(0, i)) * stride];
  }
  for (let i = 0; i < count; i++) {
    dst[start + i * stride] = sum / window;
    const outIdx = Math.min(count - 1, Math.max(0, i - radius));
    const inIdx = Math.min(count - 1, Math.max(0, i + radius + 1));
    sum += src[start + inIdx * stride] - src[start + outIdx * stride];
  }
}

/**
 * 羽化 / 边缘平滑：多遍可分离盒模糊近似高斯模糊（3 遍非常接近）。
 */
export function featherGray(
  gray: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  passes = 3,
): Uint8ClampedArray<ArrayBuffer> {
  const r = Math.max(0, Math.round(radius));
  let current = new Uint8ClampedArray(gray);
  if (r === 0) return current;
  // 每遍使用 r/passes 的半径，总和约为 r 的高斯等效
  const passRadius = Math.max(1, Math.round(r / passes));
  let tmp = new Uint8ClampedArray(width * height);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) {
      boxBlur1D(current, tmp, y * width, 1, width, passRadius);
    }
    for (let x = 0; x < width; x++) {
      boxBlur1D(tmp, current, x, width, height, passRadius);
    }
  }
  return current;
}

/**
 * 膨胀 / 收缩：可分离滑动窗口最大值/最小值滤波（单调队列，O(n)）。
 */
export function morphGray(
  gray: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  mode: 'dilate' | 'erode',
): Uint8ClampedArray<ArrayBuffer> {
  const r = Math.max(0, Math.round(radius));
  const src = new Uint8ClampedArray(gray);
  if (r === 0) return src;
  const tmp = new Uint8ClampedArray(width * height);
  const out = new Uint8ClampedArray(width * height);
  const isMax = mode === 'dilate';
  // 单调队列：存索引；头部始终是窗口内极值
  const deque = new Int32Array(Math.max(width, height));

  const runLine = (
    s: Uint8ClampedArray,
    d: Uint8ClampedArray,
    start: number,
    stride: number,
    count: number,
  ): void => {
    let head = 0;
    let tail = 0;
    for (let i = 0; i < count; i++) {
      const enter = i + r;
      if (enter < count) {
        const enterVal = s[start + enter * stride];
        while (head < tail) {
          const backVal = s[start + deque[tail - 1] * stride];
          if (isMax ? backVal <= enterVal : backVal >= enterVal) tail--;
          else break;
        }
        deque[tail++] = enter;
      }
      while (deque[head] < i - r) head++;
      d[start + i * stride] = s[start + deque[head] * stride];
    }
  };

  for (let y = 0; y < height; y++) runLine(src, tmp, y * width, 1, width);
  for (let x = 0; x < width; x++) runLine(tmp, out, x, width, height);
  return out;
}

// ---------- 魔棒（颜色选择） ----------

export interface MagicWandOptions {
  refColor: [number, number, number];
  /** 容差 0-255（感知归一化颜色距离） */
  tolerance: number;
  /** true = 连续区域（与种子点连通），false = 全图颜色相近像素 */
  contiguous: boolean;
  seedX: number;
  seedY: number;
}

export function magicWand(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: MagicWandOptions,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height);
  const [rr, rg, rb] = options.refColor;
  const tolerance = Math.max(0, Math.min(255, options.tolerance));
  const total = width * height;
  const matches = (i: number): boolean => {
    const p = i * 4;
    return colorDistance(pixels[p], pixels[p + 1], pixels[p + 2], rr, rg, rb) <= tolerance;
  };

  if (!options.contiguous) {
    for (let i = 0; i < total; i++) {
      if (matches(i)) out[i] = 255;
    }
    return out;
  }

  const seedIndex = options.seedY * width + options.seedX;
  if (options.seedX < 0 || options.seedY < 0 || options.seedX >= width || options.seedY >= height) {
    return out;
  }
  if (!matches(seedIndex)) return out;

  // 扫描线洪水填充（栈存 (x, y) 行段起点）
  const visited = new Uint8Array(total);
  const stack: number[] = [options.seedX, options.seedY];
  while (stack.length > 0) {
    const y = stack.pop()!;
    const sx = stack.pop()!;
    let x1 = sx;
    while (x1 >= 0 && !visited[y * width + x1] && matches(y * width + x1)) x1--;
    x1++;
    let spanUp = false;
    let spanDown = false;
    for (let x = x1; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx] || !matches(idx)) break;
      visited[idx] = 1;
      out[idx] = 255;
      if (y > 0) {
        const up = (y - 1) * width + x;
        if (!visited[up] && matches(up)) {
          if (!spanUp) {
            stack.push(x, y - 1);
            spanUp = true;
          }
        } else {
          spanUp = false;
        }
      }
      if (y < height - 1) {
        const down = (y + 1) * width + x;
        if (!visited[down] && matches(down)) {
          if (!spanDown) {
            stack.push(x, y + 1);
            spanDown = true;
          }
        } else {
          spanDown = false;
        }
      }
    }
  }
  return out;
}
