import { describe, expect, it } from 'vitest';
import {
  alphaToGray,
  applyPixelOp,
  colorDistance,
  featherGray,
  grayToRgba,
  hexToRgb,
  labToRgb,
  magicWand,
  maskedMeanColor,
  maskedModeColor,
  morphGray,
  rgbToLab,
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

describe('rgbToLab / labToRgb：Lab 色彩空间转换', () => {
  it('往返转换在 ±1 容差内一致', () => {
    const colors: [number, number, number][] = [
      [0, 0, 0],
      [255, 255, 255],
      [128, 128, 128],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [200, 150, 80],
      [30, 40, 90],
      [10, 200, 120],
    ];
    for (const color of colors) {
      const back = labToRgb(...rgbToLab(color[0], color[1], color[2]));
      expect(Math.abs(back[0] - color[0])).toBeLessThanOrEqual(1.5);
      expect(Math.abs(back[1] - color[1])).toBeLessThanOrEqual(1.5);
      expect(Math.abs(back[2] - color[2])).toBeLessThanOrEqual(1.5);
    }
  });

  it('黑白 L 值在 [0, 100] 边界', () => {
    expect(rgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 1);
    expect(rgbToLab(255, 255, 255)[0]).toBeCloseTo(100, 1);
  });
});

describe('applyPixelOp color_shift：色彩靠近（保留原风格）', () => {
  function fillPixels(count: number, rgb: [number, number, number]): Uint8ClampedArray {
    const px = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i++) {
      px[i * 4] = rgb[0];
      px[i * 4 + 1] = rgb[1];
      px[i * 4 + 2] = rgb[2];
      px[i * 4 + 3] = 255;
    }
    return px;
  }

  it('强度 0 时像素严格不变', () => {
    const pixels = fillPixels(2, [200, 50, 50]);
    const before = [...pixels];
    applyPixelOp(
      pixels,
      new Uint8ClampedArray([255, 255]),
      { type: 'color_shift', mode: 'offset', target: [50, 50, 200], strength: 0 },
      2,
      1,
    );
    expect([...pixels]).toEqual(before);
  });

  it('均匀区域强度 1 时颜色到达目标色（容差内）', () => {
    const pixels = fillPixels(4, [200, 50, 50]);
    applyPixelOp(
      pixels,
      new Uint8ClampedArray(4).fill(255),
      { type: 'color_shift', mode: 'offset', target: [50, 50, 200], strength: 1 },
      4,
      1,
    );
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(pixels[i * 4] - 50)).toBeLessThanOrEqual(8);
      expect(Math.abs(pixels[i * 4 + 1] - 50)).toBeLessThanOrEqual(8);
      expect(Math.abs(pixels[i * 4 + 2] - 200)).toBeLessThanOrEqual(8);
    }
  });

  it('保留像素间的明暗结构（差异基本不丢失）', () => {
    // 两个不同亮度的红色像素
    const pixels = new Uint8ClampedArray([220, 60, 60, 255, 120, 30, 30, 255]);
    const mask = new Uint8ClampedArray([255, 255]);
    applyPixelOp(
      pixels,
      mask,
      { type: 'color_shift', mode: 'offset', target: [50, 50, 200], strength: 1 },
      2,
      1,
    );
    // 迁移后两像素仍保持明显的亮度差（结构保留），且都朝蓝色方向移动
    const bright = pixels[0] + pixels[1] + pixels[2];
    const dark = pixels[4] + pixels[5] + pixels[6];
    expect(bright).toBeGreaterThan(dark + 100);
    // 蓝色通道应显著提升（向蓝色靠近）
    expect(pixels[2]).toBeGreaterThan(60);
    expect(pixels[6]).toBeGreaterThan(30);
  });

  it('mask=0 的像素严格不变', () => {
    const pixels = new Uint8ClampedArray([200, 50, 50, 255, 10, 20, 30, 255]);
    applyPixelOp(
      pixels,
      new Uint8ClampedArray([255, 0]),
      { type: 'color_shift', mode: 'offset', target: [50, 50, 200], strength: 1 },
      2,
      1,
    );
    expect([pixels[4], pixels[5], pixels[6]]).toEqual([10, 20, 30]);
  });

  it('仅色相模式：色相转向目标、明度与饱和度保留、灰像素不受影响', () => {
    const orange: [number, number, number] = [200, 120, 40];
    const pixels = new Uint8ClampedArray([...orange, 255, 128, 128, 128, 255]);
    const mask = new Uint8ClampedArray([255, 255]);
    applyPixelOp(
      pixels,
      mask,
      { type: 'color_shift', mode: 'hue', target: [40, 80, 200], strength: 1 },
      2,
      1,
    );
    const lab0 = rgbToLab(...orange);
    const lab1 = rgbToLab(pixels[0], pixels[1], pixels[2]);
    const labT = rgbToLab(40, 80, 200);
    // 色相到达目标附近
    const hueOf = (lab: [number, number, number]): number => Math.atan2(lab[2], lab[1]);
    expect(Math.abs(hueOf(lab1) - hueOf(labT))).toBeLessThan(0.12);
    // 明度与饱和度保留
    expect(Math.abs(lab1[0] - lab0[0])).toBeLessThan(3);
    expect(Math.abs(Math.hypot(lab1[1], lab1[2]) - Math.hypot(lab0[1], lab0[2]))).toBeLessThan(6);
    // 近灰色像素保持不变
    expect(Math.abs(pixels[4] - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(pixels[5] - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(pixels[6] - 128)).toBeLessThanOrEqual(2);
  });

  it('分布匹配：目标统计等于自身统计时结果为原图（恒等变换）', () => {
    const a: [number, number, number] = [200, 50, 50];
    const b: [number, number, number] = [60, 20, 20];
    const labA = rgbToLab(...a);
    const labB = rgbToLab(...b);
    const mean: [number, number, number] = [
      (labA[0] + labB[0]) / 2,
      (labA[1] + labB[1]) / 2,
      (labA[2] + labB[2]) / 2,
    ];
    const std: [number, number, number] = [0, 1, 2].map((ch) =>
      Math.sqrt(
        Math.max(0, (Math.pow(labA[ch], 2) + Math.pow(labB[ch], 2)) / 2 - Math.pow(mean[ch], 2)),
      ),
    ) as [number, number, number];
    // 目标色取「Lab 均值的 RGB 表示」，使目标统计与应用区域统计一致（恒等条件）
    const target: [number, number, number] = labToRgb(...mean);
    const pixels = new Uint8ClampedArray([...a, 255, ...b, 255]);
    applyPixelOp(
      pixels,
      new Uint8ClampedArray([255, 255]),
      { type: 'color_shift', mode: 'match', target, targetStd: std, strength: 1 },
      2,
      1,
    );
    expect(Math.abs(pixels[0] - a[0])).toBeLessThanOrEqual(3);
    expect(Math.abs(pixels[1] - a[1])).toBeLessThanOrEqual(3);
    expect(Math.abs(pixels[2] - a[2])).toBeLessThanOrEqual(3);
    expect(Math.abs(pixels[4] - b[0])).toBeLessThanOrEqual(3);
    expect(Math.abs(pixels[5] - b[1])).toBeLessThanOrEqual(3);
    expect(Math.abs(pixels[6] - b[2])).toBeLessThanOrEqual(3);
  });

  it('分布匹配：目标为点色（零标准差）时强度 1 接近纯目标色', () => {
    const pixels = new Uint8ClampedArray([200, 50, 50, 255, 60, 20, 20, 255]);
    applyPixelOp(
      pixels,
      new Uint8ClampedArray([255, 255]),
      { type: 'color_shift', mode: 'match', target: [50, 50, 200], strength: 1 },
      2,
      1,
    );
    for (const offset of [0, 4]) {
      expect(Math.abs(pixels[offset] - 50)).toBeLessThanOrEqual(8);
      expect(Math.abs(pixels[offset + 1] - 50)).toBeLessThanOrEqual(8);
      expect(Math.abs(pixels[offset + 2] - 200)).toBeLessThanOrEqual(8);
    }
  });

  it('强度 0.5 时均值靠近一半距离', () => {
    const pixels = fillPixels(4, [200, 50, 50]);
    const mask = new Uint8ClampedArray(4).fill(255);
    const source = [...pixels];
    applyPixelOp(pixels, mask, { type: 'color_shift', mode: 'offset', target: [50, 50, 200], strength: 0.5 }, 4, 1);
    const fullShift = fillPixels(4, [200, 50, 50]);
    applyPixelOp(fullShift, mask, { type: 'color_shift', mode: 'offset', target: [50, 50, 200], strength: 1 }, 4, 1);
    // 半强度的位移量应约为全强度的一半（Lab 加性偏移的近似检查）
    const moved = pixels[2] - source[2];
    const movedFull = fullShift[2] - source[2];
    expect(moved).toBeGreaterThan(movedFull * 0.35);
    expect(moved).toBeLessThan(movedFull * 0.65);
  });
});

describe('maskedMeanColor / maskedModeColor：区域颜色统计', () => {
  it('均值：仅统计蒙版内的像素，软权重参与加权', () => {
    const pixels = new Uint8ClampedArray([100, 0, 0, 255, 200, 0, 0, 255, 50, 50, 50, 255]);
    const gray = new Uint8ClampedArray([255, 255, 0]);
    expect(maskedMeanColor(pixels, gray)).toEqual([150, 0, 0]);
    // 权重 255 与 128：结果偏向权重高的一侧
    const weighted = maskedMeanColor(pixels, new Uint8ClampedArray([255, 128, 0]));
    expect(weighted![0]).toBeGreaterThan(130);
    expect(weighted![0]).toBeLessThan(150);
  });

  it('全零蒙版返回 null', () => {
    const pixels = new Uint8ClampedArray([1, 2, 3, 255]);
    expect(maskedMeanColor(pixels, new Uint8ClampedArray([0]))).toBeNull();
    expect(maskedModeColor(pixels, new Uint8ClampedArray([0]))).toBeNull();
  });

  it('众数：数量占优的颜色块胜出（忽略少量杂色）', () => {
    // 5 个红系（同色块）+ 3 个蓝系
    const px = new Uint8ClampedArray(8 * 4);
    const gray = new Uint8ClampedArray(8).fill(255);
    for (let i = 0; i < 5; i++) {
      px[i * 4] = 200;
      px[i * 4 + 1] = 30;
      px[i * 4 + 2] = 30;
      px[i * 4 + 3] = 255;
    }
    for (let i = 5; i < 8; i++) {
      px[i * 4] = 30;
      px[i * 4 + 1] = 30;
      px[i * 4 + 2] = 200;
      px[i * 4 + 3] = 255;
    }
    const mode = maskedModeColor(px, gray);
    expect(mode![0]).toBeGreaterThan(mode![2]); // 红占优
  });
});
