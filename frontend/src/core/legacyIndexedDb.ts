/**
 * 【旧存储读取器（冻结，仅供数据迁移使用）】
 * 历史数据曾存于浏览器 IndexedDB（数据库 picai，多项目 schema v3）：
 * - projects：项目元数据
 * - images：项目内图片（原图 Blob、当前版本、缩略图）
 * - nodes：每张图片的历史树节点（快照 Blob）
 * - regions：每张图片的保存区域（灰度蒙版 Blob）
 * - app_state：最近打开的项目/图片（用于启动恢复）
 *
 * 所有 Blob 直接以结构化克隆存储，无 Base64 转换。
 * 数据库从 v1（单项目）自动迁移到 v3（多项目）。
 *
 * 现已迁移到后端磁盘存储（data/history，见 ProjectStorage.ts）；
 * 本文件不再写入，仅在应用启动时读取旧数据并迁移到磁盘，之后可整体删除。
 */

import type { HistoryOp, HistoryNode } from './HistoryManager';

const DB_NAME = 'picai';
const DB_VERSION = 3;

const STORE_PROJECTS = 'projects';
const STORE_IMAGES = 'images';
const STORE_NODES = 'nodes';
const STORE_REGIONS = 'regions';
const STORE_APP_STATE = 'app_state';

export interface ProjectRow {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface ImageRow {
  id: string;
  projectId: string;
  name: string;
  width: number;
  height: number;
  originalBlob: Blob;
  thumbBlob: Blob | null;
  currentHistoryId: number;
  originNote: string;
  createdAt: number;
}

export interface NodeRow {
  dbKey: string;
  imageId: string;
  id: number;
  parentId: number | null;
  childIds: number[];
  op: HistoryOp;
  time: number;
  label: string;
  imageBlob: Blob | null;
  thumbBlob: Blob | null;
  /** 该版本上的区域 id 集合（旧数据无此字段） */
  regionIds: string[];
}

export interface RegionRow {
  id: string;
  imageId: string;
  name: string;
  locked: boolean;
  order: number;
  grayBlob: Blob;
  thumbBlob: Blob | null;
}

export interface AppStateRow {
  key: 'active';
  projectId: string | null;
  imageId: string | null;
  updatedAt: number;
}

function ensureStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
    db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(STORE_IMAGES)) {
    db.createObjectStore(STORE_IMAGES, { keyPath: 'id' }).createIndex('projectId', 'projectId');
  }
  if (!db.objectStoreNames.contains(STORE_NODES)) {
    db.createObjectStore(STORE_NODES, { keyPath: 'dbKey' }).createIndex('imageId', 'imageId');
  }
  if (!db.objectStoreNames.contains(STORE_REGIONS)) {
    db.createObjectStore(STORE_REGIONS, { keyPath: 'id' }).createIndex('imageId', 'imageId');
  }
  if (!db.objectStoreNames.contains(STORE_APP_STATE)) {
    db.createObjectStore(STORE_APP_STATE, { keyPath: 'key' });
  }
}

/** 旧版（v1）单项目数据迁移到多项目 schema */
function migrateV1(db: IDBDatabase, tx: IDBTransaction, done: () => void): void {
  const hasOldProject = db.objectStoreNames.contains('project');
  const hasOldNodes = db.objectStoreNames.contains('nodes');
  let oldProject: Record<string, unknown> | null = null;
  let oldNodes: Record<string, unknown>[] = [];
  let pending = (hasOldProject ? 1 : 0) + (hasOldNodes ? 1 : 0);

  const finish = (): void => {
    // 'nodes' 名称被新 schema 复用：先删旧 store 再重建
    if (hasOldProject) db.deleteObjectStore('project');
    if (hasOldNodes) db.deleteObjectStore('nodes');
    ensureStores(db);
    if (oldProject && oldNodes.length > 0) {
      const ts = Date.now();
      const projectId = `p-legacy-${ts}`;
      const imageId = `img-legacy-${ts}`;
      const root = oldNodes.find((n) => n.parentId == null) ?? oldNodes[0];
      tx.objectStore(STORE_PROJECTS).put({
        id: projectId,
        name: '我的项目',
        createdAt: (oldProject.createdAt as number) ?? ts,
        updatedAt: (oldProject.updatedAt as number) ?? ts,
      } satisfies ProjectRow);
      tx.objectStore(STORE_IMAGES).put({
        id: imageId,
        projectId,
        name: (oldProject.sourceName as string) ?? 'image',
        width: (oldProject.imageWidth as number) ?? 0,
        height: (oldProject.imageHeight as number) ?? 0,
        originalBlob: root.imageBlob as Blob,
        thumbBlob: (root.thumbBlob as Blob | null) ?? null,
        currentHistoryId: (oldProject.currentHistoryId as number) ?? (root.id as number),
        originNote: '（由旧版数据迁移）',
        createdAt: (oldProject.createdAt as number) ?? ts,
      } satisfies ImageRow);
      for (const node of oldNodes) {
        tx.objectStore(STORE_NODES).put({
          dbKey: `${imageId}:${node.id}`,
          imageId,
          id: node.id,
          parentId: node.parentId,
          childIds: node.childIds,
          op: node.op,
          time: node.time,
          label: node.label,
          imageBlob: node.imageBlob,
          thumbBlob: node.thumbBlob,
        });
      }
      tx.objectStore(STORE_APP_STATE).put({
        key: 'active',
        projectId,
        imageId,
        updatedAt: ts,
      } satisfies AppStateRow);
    }
    done();
  };

  if (pending === 0) {
    finish();
    return;
  }
  if (hasOldProject) {
    const req = tx.objectStore('project').get('current');
    req.onsuccess = () => {
      oldProject = (req.result as Record<string, unknown> | undefined) ?? null;
      pending--;
      if (pending === 0) finish();
    };
    req.onerror = () => {
      pending--;
      if (pending === 0) finish();
    };
  }
  if (hasOldNodes) {
    const req = tx.objectStore('nodes').getAll();
    req.onsuccess = () => {
      oldNodes = (req.result as Record<string, unknown>[]) ?? [];
      pending--;
      if (pending === 0) finish();
    };
    req.onerror = () => {
      oldNodes = [];
      pending--;
      if (pending === 0) finish();
    };
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction!;
      const oldVersion = event.oldVersion;
      if (oldVersion === 1) {
        migrateV1(db, tx, () => ensureStores(db));
      } else {
        ensureStores(db);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('无法打开 IndexedDB'));
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
  });
}

export class LegacyIndexedDbStorage {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDb();
    return this.dbPromise;
  }

  async listProjects(): Promise<ProjectRow[]> {
    const db = await this.db();
    const rows = await requestToPromise<ProjectRow[]>(
      db.transaction(STORE_PROJECTS).objectStore(STORE_PROJECTS).getAll(),
    );
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listImages(projectId: string): Promise<ImageRow[]> {
    const db = await this.db();
    const rows = await requestToPromise<ImageRow[]>(
      db.transaction(STORE_IMAGES).objectStore(STORE_IMAGES).index('projectId').getAll(projectId),
    );
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 载入某张图片的全部历史节点（含快照 Blob） */
  async loadNodes(imageId: string): Promise<HistoryNode[]> {
    const db = await this.db();
    const rows = await requestToPromise<NodeRow[]>(
      db.transaction(STORE_NODES).objectStore(STORE_NODES).index('imageId').getAll(imageId),
    );
    return rows
      .sort((a, b) => a.id - b.id)
      .map((row) => ({
        id: row.id,
        parentId: row.parentId,
        childIds: [...row.childIds],
        op: row.op,
        time: row.time,
        label: row.label,
        imageBlob: row.imageBlob,
        thumbBlob: row.thumbBlob,
        // 旧数据没有 regionIds 字段，保留 undefined 交由上层做兼容处理
        regionIds: Array.isArray(row.regionIds) ? [...row.regionIds] : undefined,
      }));
  }

  async loadRegions(imageId: string): Promise<RegionRow[]> {
    const db = await this.db();
    const rows = await requestToPromise<RegionRow[]>(
      db.transaction(STORE_REGIONS).objectStore(STORE_REGIONS).index('imageId').getAll(imageId),
    );
    return rows.sort((a, b) => a.order - b.order);
  }

  /** 保存整个项目：项目行、图片行、历史节点、区域与最近打开状态 */
  async saveAll(params: {
    project: ProjectRow;
    images: ImageRow[];
    nodes: NodeRow[];
    regions: RegionRow[];
    activeImageId: string | null;
  }): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        [STORE_PROJECTS, STORE_IMAGES, STORE_NODES, STORE_REGIONS, STORE_APP_STATE],
        'readwrite',
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('项目写入失败'));
      tx.onabort = () => reject(tx.error ?? new Error('项目写入中止'));
      tx.objectStore(STORE_PROJECTS).put(params.project);
      const imageStore = tx.objectStore(STORE_IMAGES);
      for (const image of params.images) imageStore.put(image);
      const nodeStore = tx.objectStore(STORE_NODES);
      for (const node of params.nodes) nodeStore.put(node);
      const regionStore = tx.objectStore(STORE_REGIONS);
      for (const region of params.regions) regionStore.put(region);
      tx.objectStore(STORE_APP_STATE).put({
        key: 'active',
        projectId: params.project.id,
        imageId: params.activeImageId,
        updatedAt: Date.now(),
      } satisfies AppStateRow);
    });
  }

  async loadAppState(): Promise<AppStateRow | null> {
    const db = await this.db();
    const row = await requestToPromise<AppStateRow | undefined>(
      db.transaction(STORE_APP_STATE).objectStore(STORE_APP_STATE).get('active'),
    );
    return row ?? null;
  }

  /** 关闭数据库连接（测试与退出清理用） */
  async close(): Promise<void> {
    if (!this.dbPromise) return;
    try {
      const db = await this.dbPromise;
      db.close();
    } catch {
      /* 打开失败时无需关闭 */
    }
    this.dbPromise = null;
  }

  async usage(): Promise<{ usage: number; quota: number } | null> {
    try {
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
      }
    } catch {
      /* 不支持时静默 */
    }
    return null;
  }
}

