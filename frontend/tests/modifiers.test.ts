import { describe, expect, it } from 'vitest';
import { resolveCombineMode } from '../src/core/modifiers';

const none = { ctrlKey: false, shiftKey: false, altKey: false };

describe('resolveCombineMode：选区修饰键统一规则', () => {
  it('无修饰键时使用工具默认模式', () => {
    expect(resolveCombineMode(none, 'add')).toBe('add');
    expect(resolveCombineMode(none, 'new')).toBe('new');
    expect(resolveCombineMode(none, 'subtract')).toBe('subtract');
  });

  it('Ctrl = 并集（加选）：魔棒默认新建时按住 Ctrl 点击也变并集', () => {
    expect(resolveCombineMode({ ...none, ctrlKey: true }, 'new')).toBe('add');
    expect(resolveCombineMode({ ...none, ctrlKey: true }, 'add')).toBe('add');
  });

  it('Shift = 并集，与 Ctrl 等效', () => {
    expect(resolveCombineMode({ ...none, shiftKey: true }, 'new')).toBe('add');
  });

  it('Alt = 减去，优先级高于 Ctrl / Shift', () => {
    expect(resolveCombineMode({ ...none, altKey: true }, 'add')).toBe('subtract');
    expect(resolveCombineMode({ ...none, altKey: true, ctrlKey: true }, 'add')).toBe('subtract');
  });

  it('Shift + Alt = 交集，优先级最高', () => {
    expect(resolveCombineMode({ ...none, shiftKey: true, altKey: true }, 'new')).toBe('intersect');
    expect(
      resolveCombineMode({ ctrlKey: true, shiftKey: true, altKey: true }, 'new'),
    ).toBe('intersect');
  });

  it('用户场景：先选区再 Ctrl 魔棒点击，两次选择结果做并集语义', () => {
    // 第一次（无修饰）新建选区，第二次（Ctrl）追加 —— 解析结果分别为 new 与 add
    expect(resolveCombineMode(none, 'new')).toBe('new');
    expect(resolveCombineMode({ ...none, ctrlKey: true }, 'new')).toBe('add');
  });
});
