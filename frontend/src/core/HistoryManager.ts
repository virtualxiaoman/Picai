/**
 * 多分支历史树（有根树结构，当前节点为活动指针）。
 * 撤销 = 指针上移；新编辑 = 在当前节点下创建新子节点（自然形成分支）；
 * 重做 = 从当前节点向下移动，可在多个子节点中选择。
 * 与界面完全解耦；持久化（IndexedDB）在阶段四接入。
 */

export interface HistoryOp {
  type: string;
  params?: Record<string, unknown>;
}

export interface HistoryNode {
  id: number;
  parentId: number | null;
  childIds: number[];
  op: HistoryOp;
  time: number;
  /** 全分辨率结果图快照（PNG Blob）；根节点为原图。磁盘存储加载的节点此字段为 null（见 snapshotUrl） */
  imageBlob: Blob | null;
  /** 历史面板缩略图（本地新建的节点携带；磁盘加载的见 thumbUrl） */
  thumbBlob: Blob | null;
  /** 磁盘存储：快照文件 URL（撤销/预览时按需拉取并缓存回 imageBlob） */
  snapshotUrl?: string | null;
  /** 磁盘存储：缩略图 URL（可直接用于 <img> 展示） */
  thumbUrl?: string | null;
  label: string;
  /**
   * 该历史版本上的区域 id 集合（区域对象按图片共享存储，节点只记成员关系）。
   * 撤销/恢复历史版本时，区域列表随版本切换；旧数据可能为 undefined（按空处理）。
   */
  regionIds?: string[];
}

export class HistoryManager {
  private nodes = new Map<number, HistoryNode>();
  private nextId = 1;
  currentId = -1;

  /** 创建根节点（原图，不可修改） */
  init(imageBlob: Blob, thumbBlob: Blob | null, label = '原图'): HistoryNode {
    const node: HistoryNode = {
      id: this.nextId++,
      parentId: null,
      childIds: [],
      op: { type: 'import' },
      time: Date.now(),
      imageBlob,
      thumbBlob,
      label,
      regionIds: [],
    };
    this.nodes.set(node.id, node);
    this.currentId = node.id;
    return node;
  }

  /** 从持久化数据恢复整棵树（IndexedDB 载入） */
  restore(nodes: HistoryNode[], currentId: number): void {
    this.nodes.clear();
    let maxId = 0;
    for (const node of nodes) {
      this.nodes.set(node.id, {
        ...node,
        childIds: [...node.childIds],
      });
      maxId = Math.max(maxId, node.id);
    }
    this.nextId = maxId + 1;
    this.currentId = this.nodes.has(currentId) ? currentId : (nodes[nodes.length - 1]?.id ?? -1);
  }

  get current(): HistoryNode | undefined {
    return this.nodes.get(this.currentId);
  }

  getNode(id: number): HistoryNode | undefined {
    return this.nodes.get(id);
  }

  get count(): number {
    return this.nodes.size;
  }

  /** 在当前节点下新增编辑结果节点（撤销后再编辑即形成分支） */
  addEdit(op: HistoryOp, imageBlob: Blob | null, thumbBlob: Blob | null, label?: string): HistoryNode {
    const parent = this.nodes.get(this.currentId);
    if (!parent) throw new Error('历史未初始化');
    const node: HistoryNode = {
      id: this.nextId++,
      parentId: parent.id,
      childIds: [],
      op,
      time: Date.now(),
      imageBlob,
      thumbBlob,
      label: label ?? defaultLabel(op),
      // 新版本继承父版本的区域集合（之后各自独立演化）
      regionIds: [...(parent.regionIds ?? [])],
    };
    this.nodes.set(node.id, node);
    parent.childIds.push(node.id);
    this.currentId = node.id;
    return node;
  }

  canUndo(): boolean {
    return this.current?.parentId != null;
  }

  canRedo(): boolean {
    return (this.current?.childIds.length ?? 0) > 0;
  }

  /** 撤销：指针移动到父节点 */
  undo(): HistoryNode | null {
    const parentId = this.current?.parentId;
    if (parentId == null) return null;
    this.currentId = parentId;
    return this.nodes.get(parentId) ?? null;
  }

  /**
   * 重做：默认移动到最后一个子节点；存在多个分支时可指定 childId。
   */
  redo(childId?: number): HistoryNode | null {
    const cur = this.current;
    if (!cur || cur.childIds.length === 0) return null;
    let target: number;
    if (childId != null) {
      if (!cur.childIds.includes(childId)) return null;
      target = childId;
    } else {
      target = cur.childIds[cur.childIds.length - 1];
    }
    this.currentId = target;
    return this.nodes.get(target) ?? null;
  }

  /** 直接跳转到任意历史节点 */
  jumpTo(id: number): HistoryNode | null {
    const node = this.nodes.get(id);
    if (!node) return null;
    this.currentId = id;
    return node;
  }

  children(id: number): HistoryNode[] {
    const node = this.nodes.get(id);
    if (!node) return [];
    return node.childIds.map((cid) => this.nodes.get(cid)!).filter(Boolean);
  }

  /** 根到指定节点的路径（含两端） */
  pathTo(id: number): HistoryNode[] {
    const path: HistoryNode[] = [];
    let cur = this.nodes.get(id);
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId != null ? this.nodes.get(cur.parentId) : undefined;
    }
    return path;
  }

  allNodes(): HistoryNode[] {
    return [...this.nodes.values()];
  }
}

function defaultLabel(op: HistoryOp): string {
  const map: Record<string, string> = {
    transparent: '透明化',
    solid: '纯色替换',
    gradient: '渐变替换',
    neighborhood_fill: '邻域渐变填充',
    insert_image: '插入图片',
    color_shift: '色彩靠近',
    flatten_wrinkles: '抚平褶皱',
    ai_repair: 'AI 修复',
    import: '原图',
  };
  return map[op.type] ?? op.type;
}
