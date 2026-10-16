/**
 * 选区工具的修饰键解析（统一规则，保证画笔/几何选区/魔棒行为一致）：
 * - Ctrl 或 Shift：并集（加选）——如自动抠图反选得到背景后按住 Ctrl 用魔棒补选缺失部分
 * - Alt：减去
 * - Shift + Alt：交集
 * - 无修饰键：使用工具面板中的默认模式
 */

import type { CombineMode } from '../types';

export interface PointerModifiers {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function resolveCombineMode(
  modifiers: PointerModifiers,
  fallback: CombineMode,
): CombineMode {
  if (modifiers.altKey && modifiers.shiftKey) return 'intersect';
  if (modifiers.altKey) return 'subtract';
  if (modifiers.ctrlKey || modifiers.shiftKey) return 'add';
  return fallback;
}
