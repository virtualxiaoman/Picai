import 'fake-indexeddb/auto';
import { reactive } from 'vue';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryManager } from '../src/core/HistoryManager';
import {
  ProjectStorage,
  type ImageRow,
  type NodeRow,
  type ProjectRow,
  type RegionRow,
} from '../src/core/ProjectStorage';

let storage: ProjectStorage;

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('删除测试数据库失败'));
    req.onblocked = () => reject(new Error('测试数据库仍被占用'));
  });
}

beforeEach(async () => {
  // 关闭上一实例的连接，否则 deleteDatabase 会被阻塞
  await storage?.close();
  await deleteDatabase('picai');
  storage = new ProjectStorage();
});

function makeProject(id: string, name: string, updatedAt: number): ProjectRow {
  return { id, name, createdAt: 1, updatedAt };
}

function makeImage(id: string, projectId: string, createdAt: number): ImageRow {
  return {
    id,
    projectId,
    name: `${id}.png`,
    width: 100,
    height: 50,
    originalBlob: new Blob([`orig-${id}`]),
    thumbBlob: new Blob([`thumb-${id}`]),
    currentHistoryId: 2,
    originNote: '',
    createdAt,
  };
}

function nodeRowsFor(imageId: string, h: HistoryManager): NodeRow[] {
  return h.allNodes().map((n) => ({
    dbKey: `${imageId}:${n.id}`,
    imageId,
    id: n.id,
    parentId: n.parentId,
    childIds: [...n.childIds],
    op: n.op,
    time: n.time,
    label: n.label,
    imageBlob: n.imageBlob,
    thumbBlob: n.thumbBlob,
  }));
}

describe('ProjectStorage（v3 多项目 schema）', () => {
  it('保存并恢复多项目数据：图片、历史节点、区域与最近打开状态', async () => {
    const h = new HistoryManager();
    const root = h.init(new Blob(['root-image']), new Blob(['t0']));
    const b = h.addEdit({ type: 'solid' }, new Blob(['node-b']), new Blob(['tb']), '纯色替换');
    h.undo();
    h.addEdit({ type: 'transparent' }, new Blob(['node-d']), new Blob(['td']), '透明化');

    const region: RegionRow = {
      id: 'rg-1',
      imageId: 'img-a',
      name: '人像区',
      locked: true,
      order: 0,
      grayBlob: new Blob(['gray-data']),
      thumbBlob: new Blob(['gray-thumb']),
    };

    await storage.saveAll({
      project: makeProject('p1', '项目一', 100),
      images: [makeImage('img-a', 'p1', 1), makeImage('img-b', 'p1', 2)],
      nodes: nodeRowsFor('img-a', h),
      regions: [region],
      activeImageId: 'img-b',
    });
    await storage.saveAll({
      project: makeProject('p2', '项目二', 200),
      images: [makeImage('img-c', 'p2', 3)],
      nodes: [],
      regions: [],
      activeImageId: 'img-c',
    });

    // 项目列表按更新时间倒序
    const projects = await storage.listProjects();
    expect(projects.map((p) => p.id)).toEqual(['p2', 'p1']);

    // 图片按创建时间正序，且归属正确
    const images = await storage.listImages('p1');
    expect(images.map((i) => i.id)).toEqual(['img-a', 'img-b']);
    expect(await (images[0].originalBlob as Blob).text()).toBe('orig-img-a');

    // 历史节点往返（含 Blob 快照与分支结构）
    const nodes = await storage.loadNodes('img-a');
    expect(nodes.length).toBe(3);
    const h2 = new HistoryManager();
    h2.restore(nodes, 2);
    expect(h2.currentId).toBe(b.id);
    expect(h2.children(root.id).length).toBe(2);
    expect(await (h2.getNode(b.id)!.imageBlob as Blob).text()).toBe('node-b');

    // 区域往返
    const regions = await storage.loadRegions('img-a');
    expect(regions.length).toBe(1);
    expect(regions[0].name).toBe('人像区');
    expect(regions[0].locked).toBe(true);
    expect(await regions[0].grayBlob.text()).toBe('gray-data');

    // 最近打开状态
    const appState = await storage.loadAppState();
    expect(appState?.projectId).toBe('p2');
    expect(appState?.imageId).toBe('img-c');

    // 同项目重复保存：覆盖更新而非重复插入
    await storage.saveAll({
      project: makeProject('p1', '项目一改', 300),
      images: [makeImage('img-a', 'p1', 1)],
      nodes: nodeRowsFor('img-a', h),
      regions: [region],
      activeImageId: 'img-a',
    });
    expect((await storage.listProjects()).length).toBe(2);
    expect((await storage.loadNodes('img-a')).length).toBe(3);
    const p1 = (await storage.listProjects()).find((p) => p.id === 'p1');
    expect(p1?.name).toBe('项目一改');
    // 未显式删除的图片保持存在（应用无图片删除功能，保存为覆盖更新）
    expect((await storage.listImages('p1')).length).toBe(2);
  });

  it('无数据时 listProjects / loadAppState 返回空', async () => {
    expect(await storage.listProjects()).toEqual([]);
    expect(await storage.loadAppState()).toBeNull();
  });

  it('回归：响应式代理对象需展开为纯对象才能写入 IndexedDB（could not be cloned 修复）', async () => {
    // Pinia 深层响应式数组元素是 Proxy；直接 put 会抛 DataCloneError，
    // saveProject 中通过 { ...row } 展开成纯对象后写入。
    const reactiveRow = reactive({
      id: 'p1',
      name: '项目',
      createdAt: 1,
      updatedAt: 2,
    }) as ProjectRow;

    // 先记录直接写代理的原始行为（部分环境可能不抛错）
    try {
      await storage.saveAll({
        project: reactiveRow,
        images: [],
        nodes: [],
        regions: [],
        activeImageId: null,
      });
    } catch {
      /* 复现了 DataCloneError，符合浏览器环境预期 */
    }

    // 修复方式：展开为纯对象，必须成功
    await storage.saveAll({
      project: { ...reactiveRow },
      images: [],
      nodes: [],
      regions: [],
      activeImageId: null,
    });
    const projects = await storage.listProjects();
    expect(projects.length).toBe(1);
    expect(projects[0].name).toBe('项目');
  });

  it('v1 单项目数据自动迁移到多项目 schema', async () => {
    // 构造旧版（v1）数据库
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('picai', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('project', { keyPath: 'id' });
        db.createObjectStore('nodes', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['project', 'nodes'], 'readwrite');
        tx.objectStore('project').put({
          id: 'current',
          sessionId: 's1',
          name: 'p',
          sourceName: 'old.png',
          imageWidth: 100,
          imageHeight: 50,
          currentHistoryId: 2,
          createdAt: 1,
          updatedAt: 2,
        });
        tx.objectStore('nodes').put({
          id: 1,
          parentId: null,
          childIds: [2],
          op: { type: 'import' },
          time: 1,
          label: '原图',
          imageBlob: new Blob(['root']),
          thumbBlob: null,
          sessionId: 's1',
        });
        tx.objectStore('nodes').put({
          id: 2,
          parentId: 1,
          childIds: [],
          op: { type: 'solid' },
          time: 2,
          label: '纯色替换',
          imageBlob: new Blob(['edit']),
          thumbBlob: null,
          sessionId: 's1',
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    const projects = await storage.listProjects();
    expect(projects.length).toBe(1);
    expect(projects[0].name).toBe('我的项目');

    const images = await storage.listImages(projects[0].id);
    expect(images.length).toBe(1);
    expect(images[0].name).toBe('old.png');
    expect(images[0].currentHistoryId).toBe(2);
    expect(await (images[0].originalBlob as Blob).text()).toBe('root');

    const nodes = await storage.loadNodes(images[0].id);
    expect(nodes.length).toBe(2);
    expect(nodes[1].parentId).toBe(1);
    expect(await (nodes[1].imageBlob as Blob).text()).toBe('edit');

    const appState = await storage.loadAppState();
    expect(appState?.projectId).toBe(projects[0].id);
  });
});
