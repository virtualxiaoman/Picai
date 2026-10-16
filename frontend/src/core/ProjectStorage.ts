/**
 * 项目持久化（磁盘文件存储，经后端 /api/storage）。
 *
 * 目录结构（项目根/data/history/）：
 *   app_state.json                    最近打开的项目/图片（服务端随保存自动维护）
 *   <项目名>/                          每个项目一个文件夹（重命名时后端自动改文件夹名）
 *       project.json                   项目清单（图片 / 历史节点 / 区域元数据 + Blob 文件名）
 *       blobs/                         原图、历史快照、缩略图、区域蒙版（二进制）
 *
 * Blob 采用确定性命名（见 blobName），保存时只上传"服务端还没有的"文件；
 * 清单全量提交，服务端按清单自动清理未引用的 Blob。
 * 历史快照较大，加载时按需（撤销/预览时）再拉取，缩略图直接用 URL 展示。
 */

import type { HistoryNode, HistoryOp } from './HistoryManager';

export interface ProjectRow {
  id: string;
  folder: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  imageCount: number;
}

export interface ImageRow {
  id: string;
  projectId: string;
  name: string;
  width: number;
  height: number;
  currentHistoryId: number;
  originNote: string;
  createdAt: number;
  originalUrl: string;
  thumbUrl: string | null;
}

export interface ManifestNode {
  id: number;
  parentId: number | null;
  childIds: number[];
  op: HistoryOp;
  time: number;
  label: string;
  regionIds: string[];
  snapshot: string;
  thumb: string | null;
}

export interface ManifestRegion {
  id: string;
  name: string;
  locked: boolean;
  order: number;
  gray: string;
  thumb: string | null;
}

export interface ManifestImage {
  id: string;
  name: string;
  width: number;
  height: number;
  currentHistoryId: number;
  originNote: string;
  createdAt: number;
  original: string;
  thumb: string | null;
  nodes: ManifestNode[];
  regions: ManifestRegion[];
}

export interface ProjectManifest {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  activeImageId: string | null;
  images: ManifestImage[];
}

export interface RegionRow {
  id: string;
  name: string;
  locked: boolean;
  order: number;
  grayUrl: string;
  thumbUrl: string | null;
  grayBlob: Blob;
}

export interface OpenedProject {
  project: ProjectRow;
  images: ImageRow[];
  nodesOf(imageId: string): HistoryNode[];
  regionsOf(imageId: string): Promise<RegionRow[]>;
  /** 清单已引用的全部 Blob 文件名（保存时据此判断哪些需要上传） */
  blobNames: Set<string>;
}

export interface StoredAppState {
  projectId: string | null;
  folder: string | null;
  imageId: string | null;
}

/** 确定性 Blob 文件名 */
export const blobName = {
  original: (imageId: string) => `${imageId}.original`,
  imageThumb: (imageId: string) => `${imageId}.thumb`,
  snapshot: (imageId: string, nodeId: number) => `${imageId}.n${nodeId}.snapshot`,
  nodeThumb: (imageId: string, nodeId: number) => `${imageId}.n${nodeId}.thumb`,
  regionGray: (regionId: string) => `${regionId}.gray`,
  regionThumb: (regionId: string) => `${regionId}.thumb`,
};

async function toJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { detail?: string };
      if (data.detail) detail = data.detail;
    } catch {
      /* 非 JSON 响应 */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export class ProjectStorage {
  async listProjects(): Promise<ProjectRow[]> {
    const data = await toJson<{ projects: ProjectRow[] }>(
      await fetch('/api/storage/projects'),
    );
    return data.projects;
  }

  blobUrl(folder: string, name: string): string {
    return `/api/storage/projects/${encodeURIComponent(folder)}/blobs/${encodeURIComponent(name)}`;
  }

  async fetchBlob(url: string): Promise<Blob> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`读取文件失败：HTTP ${res.status}`);
    return res.blob();
  }

  /** 打开项目：返回图片行、按需的历史节点（含快照 URL）与区域（灰度按需拉取） */
  async openProject(folder: string): Promise<OpenedProject> {
    const data = await toJson<{ manifest: ProjectManifest }>(
      await fetch(`/api/storage/projects/${encodeURIComponent(folder)}`),
    );
    const manifest = data.manifest;
    const project: ProjectRow = {
      id: manifest.id,
      folder,
      name: manifest.name,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      imageCount: manifest.images.length,
    };
    const images: ImageRow[] = manifest.images.map((m) => ({
      id: m.id,
      projectId: manifest.id,
      name: m.name,
      width: m.width,
      height: m.height,
      currentHistoryId: m.currentHistoryId,
      originNote: m.originNote,
      createdAt: m.createdAt,
      originalUrl: this.blobUrl(folder, m.original),
      thumbUrl: m.thumb ? this.blobUrl(folder, m.thumb) : null,
    }));
    const nodesByImage = new Map<string, HistoryNode[]>();
    const regionsByImage = new Map<string, ManifestRegion[]>();
    const blobNames = new Set<string>();
    for (const m of manifest.images) {
      nodesByImage.set(
        m.id,
        m.nodes.map((n) => ({
          id: n.id,
          parentId: n.parentId,
          childIds: [...n.childIds],
          op: n.op,
          time: n.time,
          label: n.label,
          regionIds: Array.isArray(n.regionIds) ? [...n.regionIds] : undefined,
          imageBlob: null,
          thumbBlob: null,
          snapshotUrl: this.blobUrl(folder, n.snapshot),
          thumbUrl: n.thumb ? this.blobUrl(folder, n.thumb) : null,
        })),
      );
      regionsByImage.set(m.id, m.regions ?? []);
      blobNames.add(m.original);
      if (m.thumb) blobNames.add(m.thumb);
      for (const n of m.nodes) {
        blobNames.add(n.snapshot);
        if (n.thumb) blobNames.add(n.thumb);
      }
      for (const r of m.regions ?? []) {
        blobNames.add(r.gray);
        if (r.thumb) blobNames.add(r.thumb);
      }
    }
    return {
      project,
      images,
      nodesOf: (imageId: string) => nodesByImage.get(imageId) ?? [],
      regionsOf: async (imageId: string) => {
        const list = regionsByImage.get(imageId) ?? [];
        const rows: RegionRow[] = [];
        for (const r of list) {
          const grayUrl = this.blobUrl(folder, r.gray);
          rows.push({
            id: r.id,
            name: r.name,
            locked: r.locked,
            order: r.order,
            grayUrl,
            thumbUrl: r.thumb ? this.blobUrl(folder, r.thumb) : null,
            grayBlob: await this.fetchBlob(grayUrl),
          });
        }
        return rows.sort((a, b) => a.order - b.order);
      },
      blobNames,
    };
  }

  /** 保存项目清单 + 新增 Blob；folder 为空时服务端按项目名新建文件夹 */
  async saveProject(
    folder: string | null,
    manifest: ProjectManifest,
    files: File[],
  ): Promise<{ folder: string }> {
    const form = new FormData();
    if (folder) form.append('folder', folder);
    form.append('manifest', JSON.stringify(manifest));
    for (const file of files) form.append('files', file, file.name);
    return toJson<{ folder: string }>(
      await fetch('/api/storage/save', { method: 'POST', body: form }),
    );
  }

  /** 仅上传 Blob（迁移时分批上传，不动清单） */
  async uploadBlobs(folder: string, files: File[]): Promise<void> {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    await toJson<{ uploaded: number }>(
      await fetch(`/api/storage/projects/${encodeURIComponent(folder)}/blobs`, {
        method: 'POST',
        body: form,
      }),
    );
  }

  async loadAppState(): Promise<StoredAppState | null> {
    const data = await toJson<{
      state: { projectId?: string | null; folder?: string | null; imageId?: string | null } | null;
    }>(await fetch('/api/storage/app-state'));
    const state = data.state;
    if (!state) return null;
    return {
      projectId: state.projectId ?? null,
      folder: state.folder ?? null,
      imageId: state.imageId ?? null,
    };
  }

  async usage(): Promise<{ bytes: number; files: number; projects: number } | null> {
    try {
      return await toJson<{ bytes: number; files: number; projects: number }>(
        await fetch('/api/storage/usage'),
      );
    } catch {
      return null;
    }
  }
}

export const projectStorage = new ProjectStorage();
