/** 画布编码与缩略图工具 */

import { grayToRgba } from './pixelOps';

export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = 'image/png',
  quality?: number,
): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new Error(`画布编码失败：${type}`);
  return blob;
}

/** 灰度蒙版 -> 小尺寸缩略图 Blob（区域列表展示用） */
export async function grayToThumbBlob(
  gray: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  maxSize = 96,
): Promise<Blob | null> {
  try {
    const cv = document.createElement('canvas');
    cv.width = width;
    cv.height = height;
    const ctx = cv.getContext('2d')!;
    ctx.putImageData(new ImageData(grayToRgba(gray), width, height), 0, 0);
    return await makeThumbnail(cv, width, height, maxSize);
  } catch {
    return null;
  }
}

/** 灰度蒙版 -> PNG Blob（用于上传给后端做邻域填充等处理） */
export async function grayMaskToPngBlob(
  gray: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Blob> {
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d')!;
  ctx.putImageData(new ImageData(grayToRgba(gray), width, height), 0, 0);
  return canvasToBlob(cv, 'image/png');
}

/** 生成历史面板缩略图（不超过 maxSize，PNG 保留透明） */
export async function makeThumbnail(
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  maxSize = 256,
): Promise<Blob | null> {
  try {
    const scale = Math.min(1, maxSize / Math.max(srcWidth, srcHeight));
    const w = Math.max(1, Math.round(srcWidth * scale));
    const h = Math.max(1, Math.round(srcHeight * scale));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    return await canvasToBlob(cv, 'image/png');
  } catch {
    return null;
  }
}
