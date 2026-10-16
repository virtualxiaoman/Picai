import { describe, expect, it } from 'vitest';
import {
  alphaToGray,
  applyPixelOp,
  colorDistance,
  featherGray,
  grayToRgba,
  hexToRgb,
  magicWand,
  morphGray,
} from '../src/core/pixelOps';

describe('applyPixelOp：编辑操作按蒙版权重计算', () => {
  it('透明化：alpha 按 (255-mask)/255 缩放，mask=255 完全透明', () => {
    const pixels = new Uint8ClampedArray([200, 100, 50, 255, 200, 100, 50, 200]);
    const mask = new Uint8ClampedArray([255, 128]);
    applyPixelOp(pixels, mask, { type: 'transparent' }, 2, 1);
    expect(pixels[3]).toBe(0);
    expect(pixels[7]).toBe(Math.round((200 * 127) / 255));
    expect(pixels[0]).toBe(200);
    expect(pixels[4]).toBe(200);
  });

  it('透明化：mask=0 的像素严格不变（未选中区域不被意外修改）', () => {
    const pixels = new Uint8ClampedArray([10, 20, 30, 255]);
    applyPixelOp(pixels, new Uint8ClampedArray([0]), { type: 'transparent' }, 1, 1);
    expect([...pixels]).toEqual([10, 20, 30, 255]);
  });

  it('纯色替换：RGB 按权重混合，Alpha 不变；软边缘为部分混合', () => {
    const full = new Uint8ClampedArray([100, 150, 200, 180]);
    applyPixelOp(full, new Uint8ClampedArray([255]), { type: 'solid', color: [10, 20, 30] }, 1, 1);
    expect([...full]).toEqual([10, 20, 30, 180]);

    const half = new Uint8ClampedArray([100, 100, 100, 200]);
    applyPixelOp(
      half,
      new Uint8ClampedArray([128]),
      { type: 'solid', color: [255, 255, 255] },
      1,
      1,
    );
    expect(half[0]).toBe(Math.round(100 + ((255 - 100) * 128) / 255));
    expect(half[3]).toBe(200);

    const none = new Uint8ClampedArray([100, 100, 100, 200]);
    applyPixelOp(none, new Uint8ClampedArray([0]), { type: 'solid', color: [0, 0, 0] }, 1, 1);
    expect([...none]).toEqual([100, 100, 100, 200]);
  });

  it('渐变替换：mask=0 不变，mask=255 时按方向轴的 0-1 投影取渐变色', () => {
    // 2x1 图像，水平方向 0 度：左端 t=0 取 color1，右端 t=1 取 color2
    const pixels = new Uint8ClampedArray([50, 50, 50, 255, 50, 50, 50, 255]);
    const mask = new Uint8ClampedArray([255, 255]);
    applyPixelOp(
      pixels,
      mask,
      {
        type: 'gradient',
        angleDeg: 0,
        start: 0,
        end: 1,
        color1: [0, 0, 0],
        color2: [200, 200, 200],
      },
      2,
      1,
    );
    expect(pixels[0]).toBe(0); // 左端
    expect(pixels[4]).toBe(200); // 右端
    // alpha 不变
    expect(pixels[3]).toBe(255);
  });

  it('渐变替换：软蒙版权重按比例混合', () => {
    const pixels = new Uint8ClampedArray([100, 100, 100, 255]);
    applyPixelOp(
      pixels,
      new Uint8ClampedArray([128]),
      {
        type: 'gradient',
        angleDeg: 0,
        start: 0,
        end: 1,
        color1: [0, 0, 0],
        color2: [0, 0, 0],
      },
      1,
      1,
    );
    expect(pixels[0]).toBe(Math.round(100 + (0 - 100) * (128 / 255)));
  });

  it('蒙版灰度与 RGBA 数据往返一致', () => {
    const gray = new Uint8ClampedArray([0, 1, 127, 128, 254, 255]);
    const rgba = grayToRgba(gray);
    expect(alphaToGray(rgba)).toEqual(gray);
  });
});

describe('colorDistance（加权欧氏距离）', () => {
  it('相同颜色距离为 0', () => {
    expect(colorDistance(10, 20, 30, 10, 20, 30)).toBe(0);
  });
  it('黑白距离接近 255 上限', () => {
    const d = colorDistance(0, 0, 0, 255, 255, 255);
    expect(d).toBeGreaterThan(200);
    expect(d).toBeLessThanOrEqual(255);
  });
  it('距离随差异单调增大', () => {
    const d1 = colorDistance(100, 100, 100, 110, 100, 100);
    const d2 = colorDistance(100, 100, 100, 200, 100, 100);
    expect(d2).toBeGreaterThan(d1);
  });
});

describe('featherGray：羽化（可分离盒模糊近似）', () => {
  it('均匀蒙版模糊后保持均匀', () => {
    const gray = new Uint8ClampedArray(16 * 16).fill(200);
    const out = featherGray(gray, 16, 16, 4);
    for (const v of out) expect(v).toBeCloseTo(200, 0);
  });

  it('硬边缘被平滑：边界处出现中间值', () => {
    const w = 32;
    const h = 8;
    const gray = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) gray[y * w + x] = x < w / 2 ? 0 : 255;
    }
    const out = featherGray(gray, w, h, 6);
    // 边界两侧出现介于 0 和 255 的过渡值
    const mid = w / 2;
    expect(out[mid - 1]).toBeGreaterThan(10);
    expect(out[mid]).toBeLessThan(245);
    // 远离边界处保持原值
    expect(out[2]).toBeLessThan(5);
    expect(out[w - 3]).toBeGreaterThan(250);
  });
});

describe('morphGray：膨胀 / 收缩', () => {
  function pattern(): Uint8ClampedArray {
    // 9x9 图像，中心 3x3 为 255
    const w = 9;
    const gray = new Uint8ClampedArray(w * w);
    for (let y = 3; y <= 5; y++) {
      for (let x = 3; x <= 5; x++) gray[y * w + x] = 255;
    }
    return gray;
  }

  it('膨胀：半径 1 后覆盖 5x5 区域', () => {
    const out = morphGray(pattern(), 9, 9, 1, 'dilate');
    expect(out[2 * 9 + 2]).toBe(255);
    expect(out[2 * 9 + 6]).toBe(255);
    expect(out[1 * 9 + 4]).toBe(0);
  });

  it('收缩：半径 1 后仅剩中心 1 像素', () => {
    const out = morphGray(pattern(), 9, 9, 1, 'erode');
    expect(out[4 * 9 + 4]).toBe(255);
    expect(out[3 * 9 + 3]).toBe(0);
  });

  it('半径 0 时返回原蒙版拷贝', () => {
    const src = pattern();
    const out = morphGray(src, 9, 9, 0, 'dilate');
    expect([...out]).toEqual([...src]);
  });
});

describe('magicWand：颜色选择', () => {
  /** 4x1 像素：红、红、蓝、红（第二和第四个红像素被蓝色隔开） */
  function linePixels(): Uint8ClampedArray {
    return new Uint8ClampedArray([
      255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255,
    ]);
  }

  it('连续模式：只选择与种子点连通的同色区域', () => {
    const gray = magicWand(linePixels(), 4, 1, {
      refColor: [255, 0, 0],
      tolerance: 30,
      contiguous: true,
      seedX: 0,
      seedY: 0,
    });
    expect(gray[0]).toBe(255);
    expect(gray[1]).toBe(255);
    expect(gray[2]).toBe(0); // 蓝色隔断
    expect(gray[3]).toBe(0); // 连通不到
  });

  it('非连续模式：选择全图颜色接近的所有像素', () => {
    const gray = magicWand(linePixels(), 4, 1, {
      refColor: [255, 0, 0],
      tolerance: 30,
      contiguous: false,
      seedX: 0,
      seedY: 0,
    });
    expect([...gray]).toEqual([255, 255, 0, 255]);
  });

  it('容差为 0 时只选中与参考色完全相同的像素', () => {
    const gray = magicWand(linePixels(), 4, 1, {
      refColor: [255, 0, 0],
      tolerance: 0,
      contiguous: false,
      seedX: 0,
      seedY: 0,
    });
    expect([...gray]).toEqual([255, 255, 0, 255]);
    const gray2 = magicWand(linePixels(), 4, 1, {
      refColor: [250, 5, 5],
      tolerance: 0,
      contiguous: false,
      seedX: 0,
      seedY: 0,
    });
    expect([...gray2]).toEqual([0, 0, 0, 0]);
  });

  it('种子点超出图像范围时返回空蒙版', () => {
    const gray = magicWand(linePixels(), 4, 1, {
      refColor: [255, 0, 0],
      tolerance: 30,
      contiguous: true,
      seedX: 10,
      seedY: 0,
    });
    expect([...gray]).toEqual([0, 0, 0, 0]);
  });
});

describe('hexToRgb', () => {
  it('解析标准 HEX', () => {
    expect(hexToRgb('#ff5a1f')).toEqual([255, 90, 31]);
    expect(hexToRgb('000000')).toEqual([0, 0, 0]);
  });
  it('非法输入回退为黑色', () => {
    expect(hexToRgb('zzz')).toEqual([0, 0, 0]);
  });
});
