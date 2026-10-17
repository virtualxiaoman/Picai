/**
 * 统一操作历史（Ctrl+Z / Ctrl+Y 专用，独立于图片版本树）。
 *
 * 记录所有用户操作，按发生顺序撤销/重做：
 * - selection：选区变化（前后蒙版快照）
 * - edit：图片编辑（记录版本树节点 id，撤销=版本指针移动到父节点）
 * - region_save / region_delete / region_lock：区域管理
 *
 * 图片版本树本身用于长时导航（工具栏撤销/重做/历史面板），
 * 手动切换版本后本操作栈会重置（时间线已改变）。
 */

export type OperationKind = 'selection' | 'edit' | 'region_save' | 'region_delete' | 'region_lock';

export interface OperationEntry {
  kind: OperationKind;
  label: string;
  /** selection：操作前/后的蒙版快照（null = 空选区） */
  before?: Uint8ClampedArray | null;
  after?: Uint8ClampedArray | null;
  /** edit：本次编辑创建的历史节点 id */
  nodeId?: number;
  /** region_*：目标区域 id */
  regionId?: string;
  /** region_lock：切换前的锁定状态 */
  lockedBefore?: boolean;
  /** 估算占用字节（用于内存预算裁剪） */
  bytes: number;
}

export class OperationHistory {
  private entries: OperationEntry[] = [];
  /** 当前操作下标；-1 表示尚未执行任何操作 */
  private cursor = -1;
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor(maxBytes = 192 * 1024 * 1024, maxEntries = 200) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  reset(): void {
    this.entries = [];
    this.cursor = -1;
    this.bytes = 0;
  }

  canUndo(): boolean {
    return this.cursor >= 0;
  }

  canRedo(): boolean {
    return this.cursor < this.entries.length - 1;
  }

  get depth(): { undo: number; redo: number } {
    return {
      undo: this.cursor + 1,
      redo: this.entries.length - 1 - this.cursor,
    };
  }

  /** 供操作历史面板展示的轻量列表（不含蒙版快照） */
  list(): Array<{ label: string; kind: OperationKind }> {
    return this.entries.map((entry) => ({ label: entry.label, kind: entry.kind }));
  }

  /** 记录一次已完成的操作（会截断此前的重做分支） */
  push(entry: Omit<OperationEntry, 'bytes'>): void {
    const bytes = (entry.before?.length ?? 0) + (entry.after?.length ?? 0);
    while (this.entries.length > this.cursor + 1) {
      const dropped = this.entries.pop()!;
      this.bytes -= dropped.bytes;
    }
    this.entries.push({ ...entry, bytes });
    this.bytes += bytes;
    this.cursor++;
    // 超出内存预算或条数上限时丢弃最早的操作
    while (
      (this.bytes > this.maxBytes || this.entries.length > this.maxEntries) &&
      this.entries.length > 1
    ) {
      const dropped = this.entries.shift()!;
      this.bytes -= dropped.bytes;
      this.cursor--;
    }
  }

  /** 撤销：返回被撤销的操作（游标前移） */
  undo(): OperationEntry | undefined {
    if (this.cursor < 0) return undefined;
    return this.entries[this.cursor--];
  }

  /** 重做：返回被重做的操作（游标后移） */
  redo(): OperationEntry | undefined {
    if (this.cursor >= this.entries.length - 1) return undefined;
    return this.entries[++this.cursor];
  }
}
