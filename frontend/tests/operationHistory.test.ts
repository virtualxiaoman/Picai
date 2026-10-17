import { describe, expect, it } from 'vitest';
import { OperationHistory } from '../src/core/OperationHistory';

function mask(value: number, size = 4): Uint8ClampedArray {
  return new Uint8ClampedArray(size).fill(value);
}

describe('OperationHistory：统一操作撤销/重做（Ctrl+Z/Y）', () => {
  it('提交→撤销→重做，游标语义正确', () => {
    const h = new OperationHistory();
    expect(h.canUndo()).toBe(false);
    expect(h.undo()).toBeUndefined();

    h.push({ kind: 'selection', label: '选区1', before: null, after: mask(1) });
    h.push({ kind: 'selection', label: '并集区域2', before: mask(1), after: mask(2) });
    expect(h.canUndo()).toBe(true);
    expect(h.canRedo()).toBe(false);

    const undone = h.undo();
    expect(undone?.label).toBe('并集区域2');
    expect(undone?.before).toEqual(mask(1)); // 撤销后选区1 保留
    expect(h.undo()?.label).toBe('选区1');
    expect(h.canUndo()).toBe(false);
    expect(h.undo()).toBeUndefined();

    expect(h.redo()?.label).toBe('选区1');
    expect(h.redo()?.label).toBe('并集区域2');
    expect(h.redo()).toBeUndefined();
  });

  it('撤销后执行新操作会截断重做分支', () => {
    const h = new OperationHistory();
    h.push({ kind: 'selection', label: 'a', before: null, after: mask(1) });
    h.push({ kind: 'edit', label: '纯色替换', nodeId: 2 });
    h.undo();
    h.push({ kind: 'region_save', label: '保存区域', regionId: 'rg-1' });
    expect(h.canRedo()).toBe(false);
    expect(h.undo()?.label).toBe('保存区域');
    expect(h.redo()?.label).toBe('保存区域');
  });

  it('超内存预算时裁剪最早的操作（蒙版快照占字节）', () => {
    // 每个选区条目记录前后两份快照：a=4 字节，b/c 各 8 字节；预算 16 → 只能保留 b、c
    const h = new OperationHistory(16, 200);
    h.push({ kind: 'selection', label: 'a', before: null, after: mask(1) });
    h.push({ kind: 'selection', label: 'b', before: mask(1), after: mask(2) });
    h.push({ kind: 'selection', label: 'c', before: mask(2), after: mask(3) });
    expect(h.depth.undo).toBe(2);
    expect(h.undo()?.label).toBe('c');
    expect(h.undo()?.label).toBe('b');
    expect(h.undo()).toBeUndefined();
  });

  it('编辑/区域类操作无快照，不占用内存预算', () => {
    const h = new OperationHistory(4, 10);
    h.push({ kind: 'selection', label: 'a', before: null, after: mask(1) });
    h.push({ kind: 'edit', label: '透明化', nodeId: 2 });
    h.push({ kind: 'region_lock', label: '固定区域', regionId: 'rg-1', lockedBefore: false });
    expect(h.depth.undo).toBe(3);
  });

  it('list 返回操作标签与类型（供操作历史面板展示，不含快照）', () => {
    const h = new OperationHistory();
    h.push({ kind: 'selection', label: '魔棒选区', before: null, after: mask(1) });
    h.push({ kind: 'edit', label: '透明化', nodeId: 2 });
    h.push({ kind: 'region_save', label: '保存区域「人像」', regionId: 'rg-1' });
    expect(h.list()).toEqual([
      { label: '魔棒选区', kind: 'selection' },
      { label: '透明化', kind: 'edit' },
      { label: '保存区域「人像」', kind: 'region_save' },
    ]);
  });

  it('reset 清空全部历史（切换图片或手动切换版本后）', () => {
    const h = new OperationHistory();
    h.push({ kind: 'selection', label: 'a', before: null, after: mask(1) });
    h.reset();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });
});
