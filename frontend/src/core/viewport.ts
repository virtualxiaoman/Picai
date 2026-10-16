/**
 * 视口数学：图像像素坐标 <-> 屏幕(CSS px)坐标 的唯一映射来源。
 * 纯计算类，不依赖 DOM，可单元测试。
 */

export interface Point {
  x: number;
  y: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 16;

/** 平移时图像至少保留在视口内的可见边距（CSS px） */
const EDGE_MARGIN = 60;
/** 适应窗口时图像四周留白（CSS px） */
const FIT_PADDING = 24;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export class Viewport {
  imageWidth = 0;
  imageHeight = 0;
  /** 缩放比例：屏幕像素 / 图像像素 */
  scale = 1;
  /** 图像左上角在屏幕中的位置（CSS px） */
  offsetX = 0;
  offsetY = 0;
  /** 视口尺寸（CSS px） */
  viewWidth = 0;
  viewHeight = 0;

  setImage(width: number, height: number): void {
    this.imageWidth = width;
    this.imageHeight = height;
  }

  setViewSize(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
  }

  get hasImage(): boolean {
    return this.imageWidth > 0 && this.imageHeight > 0;
  }

  toScreen(p: Point): Point {
    return { x: p.x * this.scale + this.offsetX, y: p.y * this.scale + this.offsetY };
  }

  toImage(p: Point): Point {
    return { x: (p.x - this.offsetX) / this.scale, y: (p.y - this.offsetY) / this.scale };
  }

  /** 以屏幕上某点为锚点缩放：该点下方的图像位置保持不动 */
  zoomAt(screenPoint: Point, factor: number): void {
    const next = clampScale(this.scale * factor);
    const k = next / this.scale;
    this.offsetX = screenPoint.x - (screenPoint.x - this.offsetX) * k;
    this.offsetY = screenPoint.y - (screenPoint.y - this.offsetY) * k;
    this.scale = next;
  }

  zoomAtCenter(factor: number): void {
    this.zoomAt({ x: this.viewWidth / 2, y: this.viewHeight / 2 }, factor);
  }

  fitScale(): number {
    if (!this.hasImage || this.viewWidth <= 0 || this.viewHeight <= 0) return 1;
    const sx = (this.viewWidth - FIT_PADDING * 2) / this.imageWidth;
    const sy = (this.viewHeight - FIT_PADDING * 2) / this.imageHeight;
    return clampScale(Math.min(sx, sy));
  }

  /** 适应窗口并居中 */
  fit(): void {
    if (!this.hasImage) return;
    this.scale = this.fitScale();
    this.center();
  }

  /** 100% 实际像素并居中 */
  actualSize(): void {
    if (!this.hasImage) return;
    this.scale = 1;
    this.center();
  }

  center(): void {
    if (!this.hasImage) return;
    this.offsetX = (this.viewWidth - this.imageWidth * this.scale) / 2;
    this.offsetY = (this.viewHeight - this.imageHeight * this.scale) / 2;
  }

  panBy(dx: number, dy: number): void {
    this.offsetX += dx;
    this.offsetY += dy;
    this.clampOffsets();
  }

  /** 保证图像始终至少有一部分在视口内 */
  clampOffsets(): void {
    if (!this.hasImage) return;
    const scaledW = this.imageWidth * this.scale;
    const scaledH = this.imageHeight * this.scale;
    const minX = Math.min(EDGE_MARGIN - scaledW, this.viewWidth - EDGE_MARGIN);
    const maxX = Math.max(this.viewWidth - EDGE_MARGIN, EDGE_MARGIN - scaledW);
    const minY = Math.min(EDGE_MARGIN - scaledH, this.viewHeight - EDGE_MARGIN);
    const maxY = Math.max(this.viewHeight - EDGE_MARGIN, EDGE_MARGIN - scaledH);
    this.offsetX = Math.min(maxX, Math.max(minX, this.offsetX));
    this.offsetY = Math.min(maxY, Math.max(minY, this.offsetY));
  }
}
