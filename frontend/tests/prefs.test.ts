import { describe, expect, it } from 'vitest';
import {
  loadPrefs,
  readPrefBool,
  readPrefNumber,
  readPrefRange,
  readPrefString,
  savePrefs,
} from '../src/core/prefs';

describe('prefs：界面偏好读取与校验', () => {
  it('数值偏好：读取、范围校验与非法值回退', () => {
    const prefs = { a: 12, b: 999, c: 'x', d: Number.NaN };
    expect(readPrefNumber(prefs, 'a', 64)).toBe(12);
    expect(readPrefNumber(prefs, 'b', 64, 1, 1000)).toBe(999);
    expect(readPrefNumber(prefs, 'b', 64, 1, 100)).toBe(64); // 超范围回退
    expect(readPrefNumber(prefs, 'c', 64)).toBe(64); // 类型错误回退
    expect(readPrefNumber(prefs, 'd', 64)).toBe(64); // NaN 回退
    expect(readPrefNumber(prefs, 'missing', 8)).toBe(8);
  });

  it('字符串偏好：白名单校验（工具 id / 模式枚举）', () => {
    const prefs = { tool: 'brush-square', bad: 'unknown', mode: 'add' };
    expect(readPrefString(prefs, 'tool', 'brush-circle', ['brush-circle', 'brush-square'])).toBe(
      'brush-square',
    );
    expect(readPrefString(prefs, 'bad', 'brush-circle', ['brush-circle', 'brush-square'])).toBe(
      'brush-circle',
    );
    expect(readPrefString(prefs, 'empty', 'default', [])).toBe('default');
  });

  it('布尔偏好：仅接受布尔值', () => {
    const prefs = { t: true, f: false, s: 'true' };
    expect(readPrefBool(prefs, 't', false)).toBe(true);
    expect(readPrefBool(prefs, 'f', true)).toBe(false);
    expect(readPrefBool(prefs, 's', true)).toBe(true); // 字符串 'true' 不接受
    expect(readPrefBool(prefs, 'missing', false)).toBe(false);
  });

  it('区间偏好：仅接受两个有限数字，非法结构回退', () => {
    const prefs = { r: [10, 80], bad1: [10], bad2: ['a', 2], bad3: 'x' };
    expect(readPrefRange(prefs, 'r', [0, 100])).toEqual([10, 80]);
    expect(readPrefRange(prefs, 'bad1', [0, 100])).toEqual([0, 100]);
    expect(readPrefRange(prefs, 'bad2', [0, 100])).toEqual([0, 100]);
    expect(readPrefRange(prefs, 'bad3', [0, 100])).toEqual([0, 100]);
  });

  it('无 localStorage 环境（如单元测试）下 load/save 安全降级', () => {
    // node 环境下没有 localStorage：loadPrefs 返回空对象，savePrefs 不抛错
    expect(loadPrefs()).toEqual({});
    expect(() => savePrefs({ a: 1 })).not.toThrow();
  });
});
