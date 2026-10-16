/**
 * 界面偏好持久化（localStorage，跨项目 / 跨会话记忆）：
 * 工具参数默认值（画笔尺寸、容差、渐变角度、色彩靠近设置等）、
 * 导出选项等与具体项目数据无关的配置存这里；
 * 区域、历史、图片等项目数据仍存于 IndexedDB（ProjectStorage）。
 */

const PREFS_KEY = 'picai.prefs';

export function loadPrefs(): Record<string, unknown> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    }
  } catch {
    /* 数据损坏时回退默认值 */
  }
  return {};
}

export function savePrefs(prefs: Record<string, unknown>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 存储不可用时忽略 */
  }
}

export function readPrefNumber(
  prefs: Record<string, unknown>,
  key: string,
  fallback: number,
  min?: number,
  max?: number,
): number {
  const value = prefs[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (min !== undefined && value < min) return fallback;
  if (max !== undefined && value > max) return fallback;
  return value;
}

/** 读取字符串偏好；提供 allowed 时进行白名单校验（如工具 id、模式枚举） */
export function readPrefString(
  prefs: Record<string, unknown>,
  key: string,
  fallback: string,
  allowed?: string[],
): string {
  const value = prefs[key];
  if (typeof value !== 'string' || value.length === 0) return fallback;
  if (allowed && !allowed.includes(value)) return fallback;
  return value;
}

export function readPrefBool(
  prefs: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = prefs[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** 读取 [number, number] 区间偏好（如渐变范围） */
export function readPrefRange(
  prefs: Record<string, unknown>,
  key: string,
  fallback: [number, number],
): [number, number] {
  const value = prefs[key];
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  ) {
    return [value[0], value[1]];
  }
  return [fallback[0], fallback[1]];
}
