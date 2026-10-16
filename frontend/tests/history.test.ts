import { describe, expect, it } from 'vitest';
import { HistoryManager } from '../src/core/HistoryManager';

const fakeBlob = (): Blob => new Blob(['x']);

describe('HistoryManager：多分支历史树', () => {
  it('A→B→C 撤销回 A 后创建 D→E，C 仍然存在且可访问', () => {
    const h = new HistoryManager();
    const a = h.init(fakeBlob(), null);
    const b = h.addEdit({ type: 'solid' }, fakeBlob(), null);
    const c = h.addEdit({ type: 'transparent' }, fakeBlob(), null);

    // 连续撤销回到 A
    expect(h.undo()!.id).toBe(b.id);
    expect(h.undo()!.id).toBe(a.id);
    expect(h.canUndo()).toBe(false);

    // 从 A 创建新分支 D、E
    const d = h.addEdit({ type: 'solid', params: { tag: 'd' } }, fakeBlob(), null);
    const e = h.addEdit({ type: 'solid', params: { tag: 'e' } }, fakeBlob(), null);
    expect(d.parentId).toBe(a.id);
    expect(e.parentId).toBe(d.id);

    // C 未被删除
    expect(h.getNode(c.id)).toBeTruthy();
    expect(
      h
        .children(a.id)
        .map((n) => n.id)
        .sort(),
    ).toEqual([b.id, d.id].sort());

    // 可跳转回 C
    expect(h.jumpTo(c.id)!.id).toBe(c.id);
    expect(h.currentId).toBe(c.id);
    expect(h.pathTo(c.id).map((n) => n.id)).toEqual([a.id, b.id, c.id]);
  });

  it('重做默认进入最后一个子节点，也可显式选择分支', () => {
    const h = new HistoryManager();
    const a = h.init(fakeBlob(), null);
    const b1 = h.addEdit({ type: 'solid', params: { tag: 'b1' } }, fakeBlob(), null);
    h.undo();
    const b2 = h.addEdit({ type: 'solid', params: { tag: 'b2' } }, fakeBlob(), null);
    expect(h.children(a.id).map((n) => n.id)).toEqual([b1.id, b2.id]);

    // 回到根后重做：默认最后一个子节点 b2
    h.jumpTo(a.id);
    expect(h.redo()!.id).toBe(b2.id);
    // 显式选择 b1
    h.jumpTo(a.id);
    expect(h.redo(b1.id)!.id).toBe(b1.id);
    // 非子节点不可重做
    h.jumpTo(a.id);
    expect(h.redo(9999)).toBeNull();
  });

  it('canUndo / canRedo 边界', () => {
    const h = new HistoryManager();
    const a = h.init(fakeBlob(), null);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    h.addEdit({ type: 'solid' }, fakeBlob(), null);
    expect(h.canUndo()).toBe(true);
    h.undo();
    expect(h.currentId).toBe(a.id);
    expect(h.canRedo()).toBe(true);
  });

  it('节点记录操作类型、参数、时间与父子关系', () => {
    const h = new HistoryManager();
    h.init(fakeBlob(), null);
    const before = Date.now();
    const node = h.addEdit({ type: 'solid', params: { color: [1, 2, 3] } }, fakeBlob(), null);
    expect(node.op.type).toBe('solid');
    expect(node.op.params).toEqual({ color: [1, 2, 3] });
    expect(node.time).toBeGreaterThanOrEqual(before);
    expect(node.label).toBe('纯色替换');
    expect(node.parentId).toBe(h.pathTo(node.id)[0].id);
  });

  it('每次 addEdit 生成唯一 ID 并成为当前节点', () => {
    const h = new HistoryManager();
    h.init(fakeBlob(), null);
    const n1 = h.addEdit({ type: 'solid' }, fakeBlob(), null);
    const n2 = h.addEdit({ type: 'transparent' }, fakeBlob(), null);
    expect(n1.id).not.toBe(n2.id);
    expect(h.currentId).toBe(n2.id);
    expect(h.count).toBe(3);
  });

  it('区域随历史版本记录：根节点为空、子节点继承父集合且相互独立', () => {
    const h = new HistoryManager();
    const root = h.init(fakeBlob(), null);
    expect(root.regionIds).toEqual([]);
    root.regionIds = ['r1'];
    const child = h.addEdit({ type: 'solid' }, fakeBlob(), null);
    expect(child.regionIds).toEqual(['r1']); // 继承
    child.regionIds!.push('r2');
    expect(root.regionIds).toEqual(['r1']); // 副本，互不影响
    const grand = h.addEdit({ type: 'transparent' }, fakeBlob(), null);
    expect(grand.regionIds).toEqual(['r1', 'r2']);
  });
});
