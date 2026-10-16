/**
 * 选区管理：统一的全分辨率灰度蒙版（以「白色 + Alpha」画布承载）。
 * 0 = 未选中，255 = 完全选中，中间值为软边缘权重。
 * 复合运算映射：新建 = copy，增加 = source-over，
 * 减去 = destination-out，交集 = destination-in。
 */

import type { CombineMode } from '../types';
import { alphaToGray, grayToRgba } from './pixelOps';

export interface StampPoint {
  x: number;
  y: number;
}

/** 笔迹插值：从 (x0,y0) 到 (x1,y1) 按最大间距 maxSpacing 均匀采样（含终点），保证连续笔迹 */
export function interpolateStamps(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  maxSpacing: number,
): StampPoint[] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  if (dist <= maxSpacing || maxSpacing <= 0) return [{ x: x1, y: y1 }];
  const steps = Math.ceil(dist / maxSpacing);
  const points: StampPoint[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    points.push({ x: x0 + dx * t, y: y0 + dy * t });
  }
  return points;
}

export type BrushShape = 'circle' | 'square';

export class SelectionManager {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  version = 0;

  private width: number;
  private height: number;
  /** 可复用的全尺寸临时层（交集笔画、剪贴形状） */
  private layer: HTMLCanvasElement;
  private layerCtx: CanvasRenderingContext2D;
  private stampCache = new Map<string, HTMLCanvasElement>();

  private strokeShape: BrushShape = 'circle';
  private strokeSize = 32;
  private strokeHardness = 1;
  private strokeMode: CombineMode = 'add';
  private strokeActive = false;
  private lastPoint: StampPoint | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.layer = document.createElement('canvas');
    this.layer.width = width;
    this.layer.height = height;
    this.layerCtx = this.layer.getContext('2d')!;
  }

  // ---------- 画笔 ----------

  /** 开始一笔：size 为图像像素直径，hardness 0~1 */
  beginStroke(shape: BrushShape, size: number, hardness: number, mode: CombineMode): void {
    this.strokeShape = shape;
    this.strokeSize = Math.max(1, size);
    this.strokeHardness = Math.min(1, Math.max(0, hardness));
    this.strokeMode = mode === 'new' ? 'add' : mode;
    this.strokeActive = true;
    this.lastPoint = null;
    if (this.strokeMode === 'intersect') {
      this.layerCtx.clearRect(0, 0, this.width, this.height);
    }
  }

  /** 笔画移动到图像坐标 (x, y)：与上一点之间插值补点 */
  strokeTo(x: number, y: number): void {
    if (!this.strokeActive) return;
    const target = this.strokeMode === 'intersect' ? this.layerCtx : this.ctx;
    const stamp = this.getStamp();
    const spacing = Math.max(1, this.strokeSize * 0.15);
    const points = this.lastPoint
      ? interpolateStamps(this.lastPoint.x, this.lastPoint.y, x, y, spacing)
      : [{ x, y }];
    if (this.strokeMode === 'subtract') target.globalCompositeOperation = 'destination-out';
    else target.globalCompositeOperation = 'source-over';
    for (const p of points) {
      target.drawImage(stamp, p.x - this.strokeSize / 2, p.y - this.strokeSize / 2);
    }
    this.lastPoint = { x, y };
    // 每段笔迹递增版本号，渲染层据此实时刷新蒙版覆盖层
    this.bump();
  }

  endStroke(): void {
    if (!this.strokeActive) return;
    this.strokeActive = false;
    this.lastPoint = null;
    if (this.strokeMode === 'intersect') this.combineLayer('intersect');
    this.bump();
  }

  // ---------- 几何选区 ----------

  marquee(
    shape: 'rect' | 'ellipse',
    rect: { x: number; y: number; width: number; height: number },
    mode: CombineMode,
  ): void {
    const lc = this.layerCtx;
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, this.width, this.height);
    lc.fillStyle = '#ffffff';
    if (shape === 'rect') {
      lc.fillRect(rect.x, rect.y, rect.width, rect.height);
    } else {
      lc.beginPath();
      lc.ellipse(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        Math.abs(rect.width) / 2,
        Math.abs(rect.height) / 2,
        0,
        0,
        Math.PI * 2,
      );
      lc.fill();
    }
    this.combineLayer(mode);
    this.bump();
  }

  // ---------- 整体操作 ----------

  selectAll(): void {
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.bump();
  }

  clearAll(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.bump();
  }

  /** 反选：newAlpha = 255 - oldAlpha（借助中间层） */
  invert(): void {
    const c = this.ctx;
    const lc = this.layerCtx;
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, this.width, this.height);
    lc.drawImage(this.canvas, 0, 0);
    c.clearRect(0, 0, this.width, this.height);
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, this.width, this.height);
    c.globalCompositeOperation = 'destination-out';
    c.drawImage(this.layer, 0, 0);
    c.globalCompositeOperation = 'source-over';
    this.bump();
  }

  // ---------- 读写 ----------

  /** 扫描（1/4 采样）判断是否存在非空选区 */
  isEmpty(): boolean {
    const data = this.ctx.getImageData(0, 0, this.width, this.height).data;
    for (let i = 3; i < data.length; i += 4 * 4) {
      if (data[i] !== 0) return false;
    }
    return true;
  }

  /** 导出全分辨率灰度蒙版（长度 = width * height） */
  getGrayMask(): Uint8ClampedArray {
    const id = this.ctx.getImageData(0, 0, this.width, this.height);
    return alphaToGray(id.data);
  }

  /** 从灰度蒙版写回（供 AI 结果、蒙版后处理使用） */
  setFromGray(gray: Uint8Array | Uint8ClampedArray): void {
    const id = new ImageData(grayToRgba(gray), this.width, this.height);
    this.ctx.putImageData(id, 0, 0);
    this.bump();
  }

  /** 把灰度蒙版按组合方式并入当前选区（供魔棒、AI 结果使用） */
  combineGray(gray: Uint8Array | Uint8ClampedArray, mode: CombineMode): void {
    const lc = this.layerCtx;
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, this.width, this.height);
    lc.putImageData(new ImageData(grayToRgba(gray), this.width, this.height), 0, 0);
    this.combineLayer(mode);
    this.bump();
  }

  private combineLayer(mode: CombineMode): void {
    const c = this.ctx;
    if (mode === 'new') c.globalCompositeOperation = 'copy';
    else if (mode === 'add') c.globalCompositeOperation = 'source-over';
    else if (mode === 'subtract') c.globalCompositeOperation = 'destination-out';
    else c.globalCompositeOperation = 'destination-in';
    c.drawImage(this.layer, 0, 0);
    c.globalCompositeOperation = 'source-over';
  }

  /** 预生成笔刷印章（按尺寸+硬度缓存），保证拖动时笔迹连续且形状正确 */
  private getStamp(): HTMLCanvasElement {
    const shape = this.strokeShape;
    const size = Math.max(1, Math.round(this.strokeSize));
    const hardness = this.strokeHardness;
    const key = `${shape}-${size}-${hardness.toFixed(3)}`;
    const cached = this.stampCache.get(key);
    if (cached) return cached;

    // 超大画布上限保护：印章边长不超过 4096
    const s = Math.min(4096, size);
    const cv = document.createElement('canvas');
    cv.width = s;
    cv.height = s;
    const c = cv.getContext('2d')!;
    const r = s / 2;
    if (shape === 'circle') {
      if (hardness >= 0.995) {
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.arc(r, r, r, 0, Math.PI * 2);
        c.fill();
      } else {
        const g = c.createRadialGradient(r, r, 0, r, r, r);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(Math.min(0.98, hardness), 'rgba(255,255,255,1)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.fillRect(0, 0, s, s);
      }
    } else {
      const blur = (1 - hardness) * s * 0.12;
      if (blur > 0.5) c.filter = `blur(${blur.toFixed(2)}px)`;
      const inset = blur * 1.2;
      c.fillStyle = '#ffffff';
      c.fillRect(inset, inset, s - inset * 2, s - inset * 2);
    }
    if (this.stampCache.size > 24) this.stampCache.clear();
    this.stampCache.set(key, cv);
    return cv;
  }

  private bump(): void {
    this.version++;
  }
}
