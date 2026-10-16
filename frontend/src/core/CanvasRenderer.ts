/**
 * 画布渲染器：在屏幕空间绘制棋盘格背景、图像、蒙版覆盖层与工具预览。
 * 所有图像内容均按视口变换绘制，原始分辨率不受缩放影响。
 */

import type { Viewport } from './viewport';

export interface MarqueePreview {
  kind: 'rect' | 'ellipse';
  /** 图像坐标（已规范化为正值宽高） */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrushPreview {
  kind: 'brush';
  shape: 'circle' | 'square';
  /** 屏幕坐标 */
  screenX: number;
  screenY: number;
  /** 图像像素直径 */
  sizeImage: number;
}

export interface PointsPreview {
  kind: 'points';
  /** 图像坐标；label 1 = 正样本，0 = 负样本 */
  points: { x: number; y: number; label: number }[];
}

export interface InsertPreview {
  kind: 'insert';
  bitmap: ImageBitmap;
  /** 图像坐标矩形 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ToolPreview = MarqueePreview | BrushPreview | PointsPreview | InsertPreview;

export interface RenderState {
  viewport: Viewport;
  dpr: number;
  image: CanvasImageSource | null;
  /** 蒙版着色层（填色模式；查看原图/查看区域时为 null） */
  overlay: HTMLCanvasElement | null;
  /** 差分模式：原始蒙版画布（白色+Alpha），以 difference 合成显示为底色反相 */
  differenceMask?: HTMLCanvasElement | null;
  preview: ToolPreview[];
}

function makeCheckerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const tile = document.createElement('canvas');
  tile.width = 16;
  tile.height = 16;
  const c = tile.getContext('2d')!;
  c.fillStyle = '#3a3a41';
  c.fillRect(0, 0, 16, 16);
  c.fillStyle = '#2c2c31';
  c.fillRect(0, 0, 8, 8);
  c.fillRect(8, 8, 8, 8);
  return ctx.createPattern(tile, 'repeat');
}

export class CanvasRenderer {
  private checker: CanvasPattern | null = null;

  render(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number, state: RenderState): void {
    const pw = Math.max(1, Math.round(cssWidth * state.dpr));
    const ph = Math.max(1, Math.round(cssHeight * state.dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.fillStyle = '#141416';
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const vp = state.viewport;
    if (!state.image || !vp.hasImage) return;

    const rx = vp.offsetX;
    const ry = vp.offsetY;
    const rw = vp.imageWidth * vp.scale;
    const rh = vp.imageHeight * vp.scale;

    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();

    // 透明棋盘格：固定在屏幕空间，不随缩放变化
    if (!this.checker) this.checker = makeCheckerPattern(ctx);
    if (this.checker) {
      ctx.fillStyle = this.checker;
      ctx.fillRect(rx, ry, rw, rh);
    }

    // 缩小时平滑采样、放大时最近邻（真实像素）
    const smooth = vp.scale < 1.5;
    ctx.imageSmoothingEnabled = smooth;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.image, rx, ry, rw, rh);
    if (state.differenceMask) {
      // 差分：|底色 - 白色| = 反相；软边缘按 Alpha 自然过渡
      ctx.globalCompositeOperation = 'difference';
      ctx.drawImage(state.differenceMask, rx, ry, rw, rh);
      ctx.globalCompositeOperation = 'source-over';
    } else if (state.overlay) {
      ctx.drawImage(state.overlay, rx, ry, rw, rh);
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(0, rw - 1), Math.max(0, rh - 1));

    for (const item of state.preview) this.drawPreview(ctx, vp, item);
  }

  private drawPreview(
    ctx: CanvasRenderingContext2D,
    vp: Viewport,
    preview: ToolPreview,
  ): void {
    if (preview.kind === 'insert') {
      const a = vp.toScreen({ x: preview.x, y: preview.y });
      const b = vp.toScreen({ x: preview.x + preview.width, y: preview.y + preview.height });
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.drawImage(preview.bitmap, a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.globalAlpha = 1;
      ctx.setLineDash([8, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#3b82f6';
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.restore();
      return;
    }
    if (preview.kind === 'points') {
      for (const point of preview.points) {
        const screen = vp.toScreen(point);
        const radius = 6;
        ctx.save();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.fillStyle = point.label === 1 ? '#22c55e' : '#ef4444';
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
      return;
    }
    if (preview.kind === 'brush') {
      const r = (preview.sizeImage * vp.scale) / 2;
      ctx.save();
      // 黑色外圈 + 白色内圈，任何底色下均可见
      for (const [color, extra] of [
        ['rgba(0,0,0,0.85)', 1],
        ['#ffffff', 0.6],
      ] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 + extra;
        ctx.beginPath();
        if (preview.shape === 'circle') {
          ctx.arc(preview.screenX, preview.screenY, Math.max(1, r), 0, Math.PI * 2);
        } else {
          ctx.rect(preview.screenX - r, preview.screenY - r, r * 2, r * 2);
        }
        ctx.stroke();
      }
      ctx.restore();
      return;
    }

    const a = vp.toScreen({ x: preview.x, y: preview.y });
    const b = vp.toScreen({ x: preview.x + preview.width, y: preview.y + preview.height });
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    for (const [color, offset] of [
      ['rgba(0,0,0,0.9)', 0],
      ['#ffffff', 6],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.lineDashOffset = offset;
      ctx.beginPath();
      if (preview.kind === 'rect') {
        ctx.rect(x, y, w, h);
      } else {
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
