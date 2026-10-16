/**
 * 导出服务：把编辑结果全分辨率导出为文件。
 * PNG 保留透明通道；JPEG 不支持透明度，用指定颜色铺底；WebP 支持透明但同样提供铺底选项。
 */

import type { ExportFormat, ExportOptions } from '../types';

const MIME: Record<ExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const EXT: Record<ExportFormat, string> = {
  png: '.png',
  jpeg: '.jpg',
  webp: '.webp',
};

/** 去掉原扩展名并附上目标格式扩展名 */
export function buildExportFilename(sourceName: string, format: ExportFormat): string {
  const base = sourceName.replace(/\.[a-z0-9]+$/i, '') || 'image';
  return base + EXT[format];
}

/** 把画布内容编码为指定格式（JPEG/WebP 先铺底，尺寸不变） */
export async function encodeCanvas(
  source: HTMLCanvasElement,
  options: ExportOptions,
): Promise<Blob> {
  let target = source;
  if (options.format !== 'png') {
    const tmp = document.createElement('canvas');
    tmp.width = source.width;
    tmp.height = source.height;
    const ctx = tmp.getContext('2d')!;
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, tmp.width, tmp.height);
    ctx.drawImage(source, 0, 0);
    target = tmp;
  }
  const quality = options.format === 'png' ? undefined : options.quality;
  const blob = await new Promise<Blob | null>((resolve) =>
    target.toBlob(resolve, MIME[options.format], quality),
  );
  if (!blob) throw new Error(`导出失败：无法编码为 ${options.format}`);
  return blob;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
