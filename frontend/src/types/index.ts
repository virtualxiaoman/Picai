/** 工具标识：前四个为阶段一；ai-* 为阶段二；magic-wand 为阶段三 */
export type ToolId =
  | 'brush-circle'
  | 'brush-square'
  | 'brush-eraser'
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

export type ColorShiftMode = 'offset' | 'hue' | 'match';

/**
 * 色彩靠近：把蒙版区域整体色彩朝目标色迁移，strength 控制靠近程度（0-1）。
 * - offset 均值偏移：区域整体平移色彩，明暗纹理完全保留
 * - hue 仅色相迁移：保留明度与饱和度，只把色相朝目标转动
 * - match 分布匹配：颜色均值与色彩分布范围同时向目标对齐
 *   （targetStd 为目标区域在 Lab 空间的颜色标准差；省略时按点色处理）
 */
export interface ColorShiftOp {
  type: 'color_shift';
  mode: ColorShiftMode;
  target: [number, number, number];
  targetStd?: [number, number, number];
  strength: number;
}

/**
 * 抚平褶皱：频率分解——压平低频阴影/褶皱起伏，同时保留高频布料纹理。
 * strength 0-1 压平程度；scale 为低频半径（图像像素，决定"什么算褶皱"）；
 * textureKeep 0-1 高频纹理保留度。
 */
export interface FlattenWrinklesOp {
  type: 'flatten_wrinkles';
  strength: number;
  scale: number;
  textureKeep: number;
}

export type PixelOp =
  | TransparentOp
  | SolidFillOp
  | GradientFillOp
  | ColorShiftOp
  | FlattenWrinklesOp;

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
