import { describe, expect, it } from 'vitest';
import { MAX_SCALE, MIN_SCALE, Viewport, clampScale } from '../src/core/viewport';

function makeViewport(): Viewport {
  const vp = new Viewport();
  vp.setImage(4000, 3000);
  vp.setViewSize(1200, 800);
  return vp;
}

describe('Viewport 坐标映射（选区定位的数学基础）', () => {
  it('toScreen / toImage 互为逆变换', () => {
    const vp = makeViewport();
    vp.scale = 0.25;
    vp.offsetX = 40;
    vp.offsetY = -30;
    const p = { x: 1234.5, y: 987.6 };
    const back = vp.toImage(vp.toScreen(p));
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it('滚轮缩放锚点不漂移：缩放前后鼠标下的图像点保持不变', () => {
    const vp = makeViewport();
    vp.fit();
    const cursor = { x: 500, y: 300 };
    const before = vp.toImage(cursor);
    vp.zoomAt(cursor, 1.25);
    const after = vp.toImage(cursor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);

    // 连续缩放（放大 + 缩小混合）后仍不漂移
    vp.zoomAt(cursor, 1.25);
    vp.zoomAt(cursor, 0.8);
    vp.zoomAt(cursor, 0.8);
    const final = vp.toImage(cursor);
    expect(final.x).toBeCloseTo(before.x, 9);
    expect(final.y).toBeCloseTo(before.y, 9);
  });

  it('适应窗口：图像完整可见且居中', () => {
    const vp = makeViewport();
    vp.fit();
    const scaledW = vp.imageWidth * vp.scale;
    const scaledH = vp.imageHeight * vp.scale;
    expect(scaledW).toBeLessThanOrEqual(vp.viewWidth);
    expect(scaledH).toBeLessThanOrEqual(vp.viewHeight);
    expect(vp.offsetX).toBeCloseTo((vp.viewWidth - scaledW) / 2, 6);
    expect(vp.offsetY).toBeCloseTo((vp.viewHeight - scaledH) / 2, 6);
  });

  it('不同缩放比例下同一图像点的往返映射一致（跨缩放选区不偏移）', () => {
    const vp = makeViewport();
    const imgPoint = { x: 1000, y: 800 };
    for (const factor of [0.5, 1, 2, 4]) {
      vp.scale = clampScale(vp.fitScale() * factor);
      vp.center();
      const round = vp.toImage(vp.toScreen(imgPoint));
      expect(round.x).toBeCloseTo(imgPoint.x, 9);
      expect(round.y).toBeCloseTo(imgPoint.y, 9);
    }
  });

  it('100% 实际像素：scale = 1 并居中', () => {
    const vp = makeViewport();
    vp.fit();
    vp.actualSize();
    expect(vp.scale).toBe(1);
    expect(vp.offsetX).toBeCloseTo((vp.viewWidth - vp.imageWidth) / 2, 6);
    expect(vp.offsetY).toBeCloseTo((vp.viewHeight - vp.imageHeight) / 2, 6);
  });

  it('缩放比例受上下限约束', () => {
    expect(clampScale(0.0001)).toBe(MIN_SCALE);
    expect(clampScale(999)).toBe(MAX_SCALE);
    const vp = makeViewport();
    vp.zoomAt({ x: 0, y: 0 }, 1000);
    expect(vp.scale).toBeLessThanOrEqual(MAX_SCALE);
  });

  it('平移后图像不会完全移出视口', () => {
    const vp = makeViewport();
    vp.fit();
    vp.panBy(100000, 100000);
    const scaledW = vp.imageWidth * vp.scale;
    const scaledH = vp.imageHeight * vp.scale;
    expect(vp.offsetX).toBeLessThanOrEqual(vp.viewWidth);
    expect(vp.offsetY).toBeLessThanOrEqual(vp.viewHeight);
    expect(vp.offsetX + scaledW).toBeGreaterThanOrEqual(0);
    expect(vp.offsetY + scaledH).toBeGreaterThanOrEqual(0);
  });
});
