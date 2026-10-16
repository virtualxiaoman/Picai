/** 工具标识：前四个为阶段一；ai-* 为阶段二；magic-wand 为阶段三 */
export type ToolId =
  | 'brush-circle'
  | 'brush-square'
  | 'marquee-rect'
  | 'marquee-ellipse'
  | 'ai-remove-bg'
  | 'ai-object'
  | 'ai-point'
  | 'magic-wand';

/** 选区组合方式：新建/增加/减去/交集 */
export type CombineMode = 'new' | 'add' | 'subtract' | 'intersect';

export type ExportFormat = 'png' | 'jpeg' | 'webp';

export interface TransparentOp {
  type: 'transparent';
}

export interface SolidFillOp {
  type: 'solid';
  color: [number, number, number];
}

/** 线性渐变替换：按角度方向在 start~end 范围间从 color1 过渡到 color2（0-1 相对值） */
export interface GradientFillOp {
  type: 'gradient';
  angleDeg: number;
  start: number;
  end: number;
  color1: [number, number, number];
  color2: [number, number, number];
}

export type PixelOp = TransparentOp | SolidFillOp | GradientFillOp;

export type MaskOpKind = 'feather' | 'dilate' | 'erode';

export interface DeviceInfo {
  torch_installed: boolean;
  torch_version: string | null;
  cuda_available: boolean;
  device_name: string | null;
  message: string;
}

export interface ExportOptions {
  format: ExportFormat;
  /** JPEG/WebP 透明区域铺底颜色（CSS 颜色），PNG 忽略 */
  background: string;
  quality: number;
}
