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
