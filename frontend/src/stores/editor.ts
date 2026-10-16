/**
 * 编辑器全局状态：项目/图片、视口、选区、历史、区域与工具参数。
 * 画布/管理器等重对象用 markRaw 持有，组件通过版本号响应式刷新。
 */

import { defineStore } from 'pinia';
import { computed, markRaw, ref, shallowRef } from 'vue';
import { ElMessage } from 'element-plus';

import { Viewport } from '../core/viewport';
import { SelectionManager, type BrushShape } from '../core/SelectionManager';
import { HistoryManager, type HistoryNode } from '../core/HistoryManager';
import { MaskRenderer } from '../core/MaskRenderer';
import { EditOperations } from '../core/EditOperations';
import { buildExportFilename, downloadBlob, encodeCanvas } from '../core/ExportService';
import { canvasToBlob, grayMaskToPngBlob, grayToThumbBlob, makeThumbnail } from '../core/imageUtils';
import { hexToRgb } from '../core/pixelOps';
import {
  projectStorage,
  type ImageRow,
  type NodeRow,
  type ProjectRow,
  type RegionRow,
} from '../core/ProjectStorage';
import {
  cancelTask,
  fetchTaskResult,
  getTask,
  requestNeighborhoodFill,
  requestPointSegment,
  requestRemoveBackground,
  requestTextSegment,
  type TaskState,
} from '../api/client';
import type { CombineMode, ExportFormat, MaskOpKind, PixelOp, ToolId } from '../types';

export const MAX_CANVAS_DIM = 16384;
const MAX_CACHED_SESSIONS = 3;

export interface AiPoint {
  x: number;
  y: number;
  label: number;
}

export interface AiBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 保存的选区区域（可固定，编辑时自动并集） */
export interface Region {
  id: string;
  name: string;
  locked: boolean;
  /** 全分辨率灰度蒙版（0-255） */
  gray: Uint8ClampedArray;
  thumbBlob: Blob | null;
}

/** 项目内的图片（元数据 + 惰性运行时状态） */
export interface ProjectImage {
  id: string;
  name: string;
  width: number;
  height: number;
  createdAt: number;
  originNote: string;
  originalBlob: Blob;
  thumbBlob: Blob | null;
  /** 当前历史节点 id（未载入时来自存储） */
  currentId: number;
  history: HistoryManager | null;
  regions: Region[] | null;
}

/** 插入图片（画布合成）状态 */
export interface InsertState {
  bitmap: ImageBitmap;
  rect: { x: number; y: number; width: number; height: number };
  sourceName: string;
}

interface SessionObjects {
  originalBitmap: ImageBitmap;
  editedCanvas: HTMLCanvasElement;
  editedCtx: CanvasRenderingContext2D;
  maskManager: SelectionManager;
  maskRenderer: MaskRenderer;
  history: HistoryManager;
}

export const useEditorStore = defineStore('editor', () => {
  // ---------- 项目 ----------
  const projects = ref<ProjectRow[]>([]);
  const activeProjectId = ref<string | null>(null);
  // shallowRef：避免 HistoryManager 实例与大尺寸蒙版数组被深度响应式代理
  const projectImages = shallowRef<ProjectImage[]>([]);
  const activeImageId = ref<string | null>(null);
  const libraryVisible = ref(false);
  const libraryMode = ref<'open' | 'insert'>('open');
  const lastImageByProject = new Map<string, string>();

  const activeProjectName = computed(
    () => projects.value.find((p) => p.id === activeProjectId.value)?.name ?? '未命名项目',
  );
  const activeImage = computed(
    () => projectImages.value.find((i) => i.id === activeImageId.value) ?? null,
  );

  // ---------- 图像（当前活动会话） ----------
  const hasImage = ref(false);
  const imageWidth = ref(0);
  const imageHeight = ref(0);
  const originalBitmap = shallowRef<ImageBitmap | null>(null);
  const originalBlob = shallowRef<Blob | null>(null);
  const sourceName = ref('image');
  const imageVersion = ref(0);
  let editedCanvas: HTMLCanvasElement | null = null;
  let editedCtx: CanvasRenderingContext2D | null = null;
  const sessionCache = new Map<string, SessionObjects>();

  // ---------- 视口 ----------
  const viewport = markRaw(new Viewport());
  const viewScale = ref(1);
  const viewOffsetX = ref(0);
  const viewOffsetY = ref(0);
  const viewWidth = ref(0);
  const viewHeight = ref(0);
  let pendingFit = false;

  // ---------- 选区与区域 ----------
  let maskManager: SelectionManager | null = null;
  let maskRenderer: MaskRenderer | null = null;
  const maskVersion = ref(0);
  const hasSelection = ref(false);
  const regions = shallowRef<Region[]>([]);

  // ---------- 历史 ----------
  let history: HistoryManager | null = null;
  const historyVersion = ref(0);
  const currentHistoryId = ref(-1);
  const canUndo = ref(false);
  const canRedo = ref(false);

  // ---------- 持久化与脏标记 ----------
  const dataVersion = ref(0);
  const savedDataVersion = ref(-1);
  const savedAt = ref<number | null>(null);
  const storageUsage = ref<{ usage: number; quota: number } | null>(null);
  const dirty = computed(() => dataVersion.value !== savedDataVersion.value);

  function bumpData(): void {
    dataVersion.value++;
  }

  // ---------- 编辑 ----------
  const editOps = markRaw(new EditOperations());
  const busy = ref(false);
  const busyText = ref('');

  // ---------- AI ----------
  const aiTask = ref<{ id: string; message: string; progress: number } | null>(null);
  const aiPoints = ref<AiPoint[]>([]);
  const aiBox = ref<AiBox | null>(null);
  let pollTimer: number | null = null;

  // ---------- 插入（画布合成） ----------
  const insertState = shallowRef<InsertState | null>(null);
  const insertScale = ref(1);

  // ---------- 工具 ----------
  const activeTool = ref<ToolId>('brush-circle');
  const brushSize = ref(64);
  const brushHardness = ref(90);
  const brushMode = ref<CombineMode>('add');
  const marqueeMode = ref<CombineMode>('new');
  const fillColor = ref('#ff5a1f');
  const showOriginal = ref(false);

  const wandTolerance = ref(32);
  const wandContiguous = ref(true);
  const featherRadius = ref(8);
  const morphRadius = ref(8);
  const gradientColor1 = ref('#000000');
  const gradientColor2 = ref('#ffffff');
  const gradientAngle = ref(90);
  const gradientRange = ref<[number, number]>([0, 100]);
  const inpaintRadius = ref(8);

  // ---------- 状态栏 ----------
  const cursorX = ref(0);
  const cursorY = ref(0);
  const cursorInImage = ref(false);

  function newId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // ---------- 视口操作 ----------
  function syncViewState(): void {
    viewScale.value = viewport.scale;
    viewOffsetX.value = viewport.offsetX;
    viewOffsetY.value = viewport.offsetY;
  }

  function setViewSize(width: number, height: number): void {
    viewport.setViewSize(width, height);
    viewWidth.value = width;
    viewHeight.value = height;
    if (pendingFit && viewport.hasImage) {
      pendingFit = false;
      viewport.fit();
    }
    syncViewState();
  }

  function fitView(): void {
    viewport.fit();
    syncViewState();
  }

  function actualSize(): void {
    viewport.actualSize();
    syncViewState();
  }

  function centerView(): void {
    viewport.center();
    syncViewState();
  }

  function zoomStep(direction: 1 | -1): void {
    viewport.zoomAtCenter(direction > 0 ? 1.25 : 0.8);
    syncViewState();
  }

  function zoomAtScreen(x: number, y: number, factor: number): void {
    viewport.zoomAt({ x, y }, factor);
    syncViewState();
  }

  function panBy(dx: number, dy: number): void {
    viewport.panBy(dx, dy);
    syncViewState();
  }

  function setCursor(x: number, y: number, inside: boolean): void {
    cursorX.value = x;
    cursorY.value = y;
    cursorInImage.value = inside;
  }

  // ---------- 项目与图片 ----------

  function rowToProjectImage(row: ImageRow): ProjectImage {
    return {
      id: row.id,
      name: row.name,
      width: row.width,
      height: row.height,
      createdAt: row.createdAt,
      originNote: row.originNote,
      originalBlob: row.originalBlob,
      thumbBlob: row.thumbBlob,
      currentId: row.currentHistoryId,
      history: null,
      regions: null,
    };
  }

  async function ensureActiveProject(): Promise<string> {
    if (activeProjectId.value) return activeProjectId.value;
    const now = Date.now();
    const row: ProjectRow = { id: newId('p'), name: '未命名项目', createdAt: now, updatedAt: now };
    projects.value.unshift(row);
    activeProjectId.value = row.id;
    bumpData();
    return row.id;
  }

  function clearImageState(): void {
    activeImageId.value = null;
    hasImage.value = false;
    imageWidth.value = 0;
    imageHeight.value = 0;
    originalBitmap.value = null;
    originalBlob.value = null;
    editedCanvas = null;
    editedCtx = null;
    maskManager = null;
    maskRenderer = null;
    history = null;
    regions.value = [];
    hasSelection.value = false;
    currentHistoryId.value = -1;
    canUndo.value = false;
    canRedo.value = false;
    showOriginal.value = false;
    cancelInsert();
    maskVersion.value++;
    imageVersion.value++;
    historyVersion.value++;
  }

  /** 把当前会话对象暂存到缓存并同步图片元数据 */
  function stashActiveSession(): void {
    if (
      !activeImageId.value ||
      !editedCanvas ||
      !editedCtx ||
      !history ||
      !maskManager ||
      !maskRenderer ||
      !originalBitmap.value
    ) {
      return;
    }
    const img = projectImages.value.find((i) => i.id === activeImageId.value);
    if (img) {
      img.history = history;
      img.regions = regions.value;
      img.currentId = history.currentId;
    }
    sessionCache.delete(activeImageId.value);
    sessionCache.set(activeImageId.value, {
      originalBitmap: originalBitmap.value,
      editedCanvas,
      editedCtx,
      maskManager,
      maskRenderer,
      history,
    });
    while (sessionCache.size > MAX_CACHED_SESSIONS) {
      const oldest = sessionCache.keys().next().value as string | undefined;
      if (oldest == null) break;
      sessionCache.delete(oldest);
    }
  }

  function applyImageState(img: ProjectImage): void {
    activeImageId.value = img.id;
    originalBlob.value = img.originalBlob;
    sourceName.value = img.name;
    imageWidth.value = img.width;
    imageHeight.value = img.height;
    currentHistoryId.value = history?.currentId ?? -1;
    updateHistoryFlags();
    maskVersion.value = maskManager?.version ?? 0;
    hasSelection.value = false;
    showOriginal.value = false;
    imageVersion.value++;
    historyVersion.value++;
    hasImage.value = true;
    viewport.setImage(img.width, img.height);
    if (viewWidth.value > 0) viewport.fit();
    else pendingFit = true;
    syncViewState();
    if (activeProjectId.value) lastImageByProject.set(activeProjectId.value, img.id);
  }

  function restoreCachedSession(imageId: string): boolean {
    const cached = sessionCache.get(imageId);
    const img = projectImages.value.find((i) => i.id === imageId);
    if (!cached || !img) return false;
    originalBitmap.value = cached.originalBitmap;
    editedCanvas = cached.editedCanvas;
    editedCtx = cached.editedCtx;
    maskManager = cached.maskManager;
    maskRenderer = cached.maskRenderer;
    history = cached.history;
    regions.value = img.regions ?? [];
    applyImageState(img);
    return true;
  }

  async function decodeGrayBlob(blob: Blob): Promise<Uint8ClampedArray> {
    const bitmap = await createImageBitmap(blob);
    const cv = document.createElement('canvas');
    cv.width = bitmap.width;
    cv.height = bitmap.height;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const gray = new Uint8ClampedArray(cv.width * cv.height);
    for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4];
    return gray;
  }

  async function buildSessionForImage(
    img: ProjectImage,
    hist: HistoryManager,
    regs: Region[],
    currentBlob: Blob,
  ): Promise<void> {
    const originalBmp = await createImageBitmap(img.originalBlob);
    const currentBmp = await createImageBitmap(currentBlob);
    originalBitmap.value = originalBmp;
    editedCanvas = document.createElement('canvas');
    editedCanvas.width = img.width;
    editedCanvas.height = img.height;
    editedCtx = editedCanvas.getContext('2d', { willReadFrequently: true })!;
    editedCtx.drawImage(currentBmp, 0, 0);
    currentBmp.close();
    maskManager = new SelectionManager(img.width, img.height);
    maskRenderer = new MaskRenderer();
    history = hist;
    regions.value = regs;
    applyImageState(img);
  }

  async function switchImageInternal(imageId: string): Promise<void> {
    const target = projectImages.value.find((i) => i.id === imageId);
    if (!target) throw new Error('图片不存在');
    stashActiveSession();
    if (restoreCachedSession(imageId)) return;
    let hist = target.history;
    if (!hist) {
      const nodes = await projectStorage.loadNodes(imageId);
      if (nodes.length === 0) throw new Error(`图片「${target.name}」的历史数据缺失`);
      hist = new HistoryManager();
      hist.restore(nodes, target.currentId);
      target.history = hist;
    }
    let regs = target.regions;
    if (!regs) {
      const rows = await projectStorage.loadRegions(imageId);
      regs = [];
      for (const row of rows) {
        regs.push({
          id: row.id,
          name: row.name,
          locked: row.locked,
          gray: await decodeGrayBlob(row.grayBlob),
          thumbBlob: row.thumbBlob,
        });
      }
      target.regions = regs;
    }
    const currentBlob = hist.getNode(hist.currentId)?.imageBlob ?? target.originalBlob;
    await buildSessionForImage(target, hist, regs, currentBlob);
  }

  async function switchImage(imageId: string): Promise<void> {
    if (busy.value) {
      ElMessage.warning('当前有任务进行中，请稍候');
      return;
    }
    if (imageId === activeImageId.value) {
      libraryVisible.value = false;
      return;
    }
    busy.value = true;
    busyText.value = '载入图片…';
    try {
      await switchImageInternal(imageId);
      libraryVisible.value = false;
    } catch (err) {
      ElMessage.error(`图片载入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  /** 创建图片资产（导入 / 空白 / 跨项目复制共用），并预构建根历史 */
  async function createImageAsset(
    sourceBlob: Blob,
    name: string,
    originNote: string,
    rootLabel?: string,
  ): Promise<ProjectImage> {
    const probe = await createImageBitmap(sourceBlob);
    const width = probe.width;
    const height = probe.height;
    const thumb = await makeThumbnail(probe, width, height);
    probe.close();
    const img: ProjectImage = {
      id: newId('img'),
      name,
      width,
      height,
      createdAt: Date.now(),
      originNote,
      originalBlob: sourceBlob,
      thumbBlob: thumb,
      currentId: -1,
      history: null,
      regions: null,
    };
    const hm = new HistoryManager();
    const root = hm.init(sourceBlob, thumb, rootLabel ?? (originNote ? `导入（${originNote}）` : '原图'));
    img.history = hm;
    img.regions = [];
    img.currentId = root.id;
    projectImages.value = [...projectImages.value, img];
    bumpData();
    return img;
  }

  async function importImage(blob: Blob, name?: string): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    busyText.value = '正在载入图片…';
    try {
      await ensureActiveProject();
      const probe = await createImageBitmap(blob);
      const w = probe.width;
      const h = probe.height;
      probe.close();
      if (w > MAX_CANVAS_DIM || h > MAX_CANVAS_DIM) {
        ElMessage.error(`图片尺寸 ${w}×${h} 超出浏览器画布上限（${MAX_CANVAS_DIM}px）`);
        return;
      }
      const img = await createImageAsset(blob, name ?? 'image', '');
      await switchImageInternal(img.id);
      ElMessage.success(`已导入 ${w}×${h} 到项目「${activeProjectName.value}」（记得保存项目）`);
    } catch (err) {
      ElMessage.error(`图片导入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  async function createBlankImage(width: number, height: number, background: string): Promise<void> {
    if (busy.value) return;
    const w = Math.round(width);
    const h = Math.round(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
      ElMessage.warning('请填写有效的宽高（1-16384）');
      return;
    }
    if (w > MAX_CANVAS_DIM || h > MAX_CANVAS_DIM) {
      ElMessage.warning(`宽高不能超过 ${MAX_CANVAS_DIM}px`);
      return;
    }
    busy.value = true;
    busyText.value = '创建空白图片…';
    try {
      await ensureActiveProject();
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d')!;
      if (background !== 'transparent') {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, w, h);
      }
      const blob = await canvasToBlob(cv, 'image/png');
      const img = await createImageAsset(blob, `空白图 ${w}×${h}`, '空白图片', '空白图');
      await switchImageInternal(img.id);
      libraryVisible.value = false;
    } catch (err) {
      ElMessage.error(`创建空白图片失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  async function copyImageFromOtherProject(
    sourceProjectId: string,
    imageId: string,
  ): Promise<void> {
    if (busy.value) return;
    busy.value = true;
    busyText.value = '复制图片到当前项目…';
    try {
      await ensureActiveProject();
      const rows = await projectStorage.listImages(sourceProjectId);
      const sourceRow = rows.find((i) => i.id === imageId);
      if (!sourceRow) throw new Error('源图片不存在');
      let blob: Blob = sourceRow.originalBlob;
      const nodes = await projectStorage.loadNodes(imageId);
      const current = nodes.find((n) => n.id === sourceRow.currentHistoryId);
      if (current?.imageBlob) blob = current.imageBlob;
      const sourceProject = projects.value.find((p) => p.id === sourceProjectId);
      const origin = `来自项目「${sourceProject?.name ?? '未知'}」`;
      const img = await createImageAsset(blob, sourceRow.name, origin, `导入（${origin}的当前结果）`);
      await switchImageInternal(img.id);
      libraryVisible.value = false;
      ElMessage.success(`已复制「${sourceRow.name}」到当前项目并打开`);
    } catch (err) {
      ElMessage.error(`复制图片失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  async function switchProject(projectId: string): Promise<void> {
    if (busy.value) return;
    if (projectId === activeProjectId.value) {
      libraryVisible.value = false;
      return;
    }
    busy.value = true;
    busyText.value = '切换项目…';
    try {
      stashActiveSession();
      activeProjectId.value = projectId;
      projectImages.value = (await projectStorage.listImages(projectId)).map(rowToProjectImage);
      clearImageState();
      const remembered = lastImageByProject.get(projectId);
      const target =
        projectImages.value.find((i) => i.id === remembered) ?? projectImages.value[0];
      if (target) await switchImageInternal(target.id);
      libraryVisible.value = false;
    } catch (err) {
      ElMessage.error(`切换项目失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  function createProject(name: string): void {
    const now = Date.now();
    const row: ProjectRow = {
      id: newId('p'),
      name: name.trim() || '未命名项目',
      createdAt: now,
      updatedAt: now,
    };
    projects.value.unshift(row);
    bumpData();
    void switchProject(row.id);
  }

  function renameProject(name: string): void {
    const trimmed = name.trim();
    const row = projects.value.find((p) => p.id === activeProjectId.value);
    if (!trimmed || !row) return;
    row.name = trimmed;
    bumpData();
    ElMessage.success(`项目已重命名为「${trimmed}」（保存项目后持久化）`);
  }

  function openLibrary(mode: 'open' | 'insert' = 'open'): void {
    libraryMode.value = mode;
    libraryVisible.value = true;
  }

  // ---------- 选区分层操作 ----------

  function pushMaskVersion(): void {
    maskVersion.value = maskManager?.version ?? 0;
  }

  function refreshSelectionState(): void {
    hasSelection.value = maskManager ? !maskManager.isEmpty() : false;
  }

  function selectAll(): void {
    maskManager?.selectAll();
    pushMaskVersion();
    refreshSelectionState();
  }

  function invertSelection(): void {
    maskManager?.invert();
    pushMaskVersion();
    refreshSelectionState();
  }

  function clearSelection(): void {
    maskManager?.clearAll();
    pushMaskVersion();
    refreshSelectionState();
  }

  function endBrushStroke(): void {
    maskManager?.endStroke();
    pushMaskVersion();
    refreshSelectionState();
  }

  function commitMarquee(
    shape: 'rect' | 'ellipse',
    rect: { x: number; y: number; width: number; height: number },
    mode: CombineMode,
  ): void {
    maskManager?.marquee(shape, rect, mode);
    pushMaskVersion();
    refreshSelectionState();
  }

  // ---------- 区域（固定/解锁） ----------

  function syncRegionsToActiveImage(): void {
    const img = activeImage.value;
    if (img) img.regions = regions.value;
  }

  async function saveCurrentRegion(name: string): Promise<void> {
    if (!maskManager || !hasSelection.value) {
      ElMessage.warning('当前没有选区，无法保存区域');
      return;
    }
    const img = activeImage.value;
    if (!img) return;
    const trimmed = name.trim() || `区域 ${regions.value.length + 1}`;
    busy.value = true;
    busyText.value = '保存区域…';
    try {
      const gray = maskManager.getGrayMask();
      const thumb = await grayToThumbBlob(gray, img.width, img.height);
      regions.value = [
        ...regions.value,
        { id: newId('rg'), name: trimmed, locked: false, gray, thumbBlob: thumb },
      ];
      syncRegionsToActiveImage();
      bumpData();
      ElMessage.success(`已保存区域「${trimmed}」`);
    } catch (err) {
      ElMessage.error(`区域保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  /** 把已保存区域合并进当前选区（默认并集） */
  function applyRegion(regionId: string, mode: 'add' | 'intersect' = 'add'): void {
    const region = regions.value.find((r) => r.id === regionId);
    if (!region || !maskManager) return;
    maskManager.combineGray(region.gray, mode);
    pushMaskVersion();
    refreshSelectionState();
    ElMessage.success(`区域「${region.name}」已${mode === 'add' ? '并集' : '交集'}到当前选区`);
  }

  function toggleRegionLock(regionId: string): void {
    const region = regions.value.find((r) => r.id === regionId);
    if (!region) return;
    region.locked = !region.locked;
    regions.value = [...regions.value]; // shallowRef 下显式触发更新
    syncRegionsToActiveImage();
    bumpData();
  }

  function deleteRegion(regionId: string): void {
    regions.value = regions.value.filter((r) => r.id !== regionId);
    syncRegionsToActiveImage();
    bumpData();
  }

  /** 编辑操作使用的有效蒙版：当前选区 ∪ 所有固定区域 */
  function effectiveGrayMask(): Uint8ClampedArray {
    if (!maskManager) return new Uint8ClampedArray(0);
    const gray = maskManager.getGrayMask();
    for (const region of regions.value) {
      if (!region.locked) continue;
      const r = region.gray;
      for (let i = 0; i < gray.length && i < r.length; i++) {
        if (r[i] > gray[i]) gray[i] = r[i];
      }
    }
    return gray;
  }

  // ---------- 编辑操作 ----------

  async function applyEdit(op: PixelOp, label: string): Promise<void> {
    if (!editedCtx || !editedCanvas || !maskManager || !history || busy.value) return;
    if (!hasSelection.value && !regions.value.some((r) => r.locked)) {
      ElMessage.warning('当前没有选区，请先使用选择工具创建选区');
      return;
    }
    busy.value = true;
    busyText.value = `${label}处理中…`;
    try {
      const w = imageWidth.value;
      const h = imageHeight.value;
      const imgData = editedCtx.getImageData(0, 0, w, h);
      const gray = effectiveGrayMask();
      const out = await editOps.apply(imgData.data, gray, op, w, h);
      editedCtx.putImageData(new ImageData(out, w, h), 0, 0);
      imageVersion.value++;

      const snap = await canvasToBlob(editedCanvas, 'image/png');
      const thumb = await makeThumbnail(editedCanvas, w, h);
      history.addEdit({ type: op.type, params: { ...op } }, snap, thumb);
      const img = activeImage.value;
      if (img) {
        img.currentId = history.currentId;
        if (thumb) img.thumbBlob = thumb;
      }
      historyVersion.value++;
      currentHistoryId.value = history.currentId;
      updateHistoryFlags();
      bumpData();
    } catch (err) {
      ElMessage.error(`${label}失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  // ---------- 历史 ----------

  function updateHistoryFlags(): void {
    if (!history) return;
    canUndo.value = history.canUndo();
    canRedo.value = history.canRedo();
  }

  async function loadNode(node: HistoryNode): Promise<void> {
    if (!editedCtx || !editedCanvas) return;
    busy.value = true;
    busyText.value = '恢复历史版本…';
    try {
      if (node.imageBlob) {
        const bmp = await createImageBitmap(node.imageBlob);
        editedCtx.clearRect(0, 0, imageWidth.value, imageHeight.value);
        editedCtx.drawImage(bmp, 0, 0);
        bmp.close();
      }
      const img = activeImage.value;
      if (img && history) {
        img.currentId = history.currentId;
        const cur = history.getNode(history.currentId);
        if (cur?.thumbBlob) img.thumbBlob = cur.thumbBlob;
      }
      imageVersion.value++;
      currentHistoryId.value = history?.currentId ?? -1;
      historyVersion.value++;
      updateHistoryFlags();
      bumpData();
    } catch (err) {
      ElMessage.error(`历史版本恢复失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  async function undo(): Promise<void> {
    if (!history?.canUndo() || busy.value) return;
    const node = history.undo();
    if (node) await loadNode(node);
  }

  async function redo(childId?: number): Promise<void> {
    if (!history || busy.value) return;
    const node = history.redo(childId);
    if (node) await loadNode(node);
  }

  async function jumpToHistory(id: number): Promise<void> {
    if (!history || busy.value || id === history.currentId) return;
    const node = history.jumpTo(id);
    if (node) await loadNode(node);
  }

  // ---------- 导出 ----------

  async function exportImage(
    format: ExportFormat,
    background: string,
    quality: number,
  ): Promise<void> {
    if (!editedCanvas) return;
    busy.value = true;
    busyText.value = '导出中…';
    try {
      const blob = await encodeCanvas(editedCanvas, { format, background, quality });
      const filename = buildExportFilename(sourceName.value, format);
      downloadBlob(blob, filename);
      ElMessage.success(`已导出 ${filename}（${imageWidth.value}×${imageHeight.value}）`);
    } catch (err) {
      ElMessage.error(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  // ---------- 工具参数 ----------

  function startBrushStroke(shape: BrushShape, mode: CombineMode): void {
    maskManager?.beginStroke(shape, brushSize.value, brushHardness.value / 100, mode);
  }

  function brushStrokeTo(x: number, y: number): void {
    maskManager?.strokeTo(x, y);
  }

  // ---------- AI 分割 ----------

  function clearAiAnnotations(): void {
    aiPoints.value = [];
    aiBox.value = null;
  }

  function addAiPoint(x: number, y: number, label: number): void {
    aiPoints.value.push({ x, y, label });
  }

  function setAiBox(box: AiBox | null): void {
    aiBox.value = box;
  }

  async function applyMaskResult(taskId: string): Promise<void> {
    if (!maskManager) return;
    const blob = await fetchTaskResult(taskId);
    const gray = await decodeGrayBlob(blob);
    maskManager.setFromGray(gray);
    pushMaskVersion();
    refreshSelectionState();
  }

  function pollTask(taskId: string, label: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const tick = async (): Promise<void> => {
        try {
          const state = await getTask(taskId);
          aiTask.value = { id: taskId, message: state.message, progress: state.progress };
          busyText.value = `${label}：${state.message}`;
          if (state.status === 'succeeded') {
            resolve();
          } else if (state.status === 'failed') {
            reject(new Error(state.error || '任务失败'));
          } else if (state.status === 'cancelled') {
            reject(new Error('任务已取消'));
          } else {
            pollTimer = window.setTimeout(() => void tick(), 800);
          }
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      void tick();
    });
  }

  async function runTaskFlow(
    start: () => Promise<TaskState>,
    label: string,
    applyResult: (taskId: string) => Promise<void>,
    successMessage?: string,
  ): Promise<boolean> {
    if (busy.value) return false;
    busy.value = true;
    busyText.value = `${label}：准备中…`;
    try {
      const task = await start();
      aiTask.value = { id: task.id, message: task.message, progress: task.progress };
      busyText.value = `${label}：${task.message}`;
      await pollTask(task.id, label);
      await applyResult(task.id);
      ElMessage.success(successMessage ?? `${label}完成，可继续用画笔修改选区`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === '任务已取消') ElMessage.info('任务已取消');
      else ElMessage.error(`${label}失败：${msg}`);
      return false;
    } finally {
      if (pollTimer != null) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
      }
      aiTask.value = null;
      busy.value = false;
      busyText.value = '';
    }
  }

  async function runAiTask(
    start: (image: Blob) => Promise<TaskState>,
    label: string,
  ): Promise<boolean> {
    if (!editedCanvas) return false;
    const canvas = editedCanvas;
    return runTaskFlow(
      async () => start(await canvasToBlob(canvas, 'image/png')),
      label,
      applyMaskResult,
    );
  }

  async function removeBackground(): Promise<void> {
    await runAiTask((image) => requestRemoveBackground(image), '自动抠图');
  }

  async function textSegment(prompt: string): Promise<void> {
    const text = prompt.trim();
    if (!text) {
      ElMessage.warning('请输入对象描述（如 person、sky、cat、car）');
      return;
    }
    await runAiTask((image) => requestTextSegment(image, text), `对象分割「${text}」`);
  }

  async function runPointSegment(): Promise<void> {
    if (aiPoints.value.length === 0 && !aiBox.value) {
      ElMessage.warning('请先在画布上点击目标或拖动框选');
      return;
    }
    const points: [number, number][] = aiPoints.value.map((p) => [p.x, p.y]);
    const labels = aiPoints.value.map((p) => p.label);
    const box: [number, number, number, number] | null = aiBox.value
      ? [
          aiBox.value.x,
          aiBox.value.y,
          aiBox.value.x + aiBox.value.width,
          aiBox.value.y + aiBox.value.height,
        ]
      : null;
    const ok = await runAiTask((image) => requestPointSegment(image, points, labels, box), '点选分割');
    if (ok) clearAiAnnotations();
  }

  async function cancelAiTask(): Promise<void> {
    if (!aiTask.value) return;
    try {
      await cancelTask(aiTask.value.id);
    } catch {
      /* 任务可能已结束 */
    }
  }

  // ---------- 阶段三：魔棒 / 蒙版后处理 / 渐变 / 邻域填充 ----------

  async function magicWandAt(x: number, y: number, mode: CombineMode): Promise<void> {
    if (!editedCtx || !maskManager || busy.value) return;
    busy.value = true;
    busyText.value = '颜色选择中…';
    try {
      const w = imageWidth.value;
      const h = imageHeight.value;
      const px = Math.min(w - 1, Math.max(0, Math.floor(x)));
      const py = Math.min(h - 1, Math.max(0, Math.floor(y)));
      const sample = editedCtx.getImageData(px, py, 1, 1).data;
      const imgData = editedCtx.getImageData(0, 0, w, h);
      const gray = await editOps.magicWand(imgData.data, w, h, {
        refColor: [sample[0], sample[1], sample[2]],
        tolerance: wandTolerance.value,
        contiguous: wandContiguous.value,
        seedX: px,
        seedY: py,
      });
      if (!gray.some((v) => v > 0)) {
        ElMessage.warning('未选中任何区域：该位置颜色与参考色差异超出容差，可调大容差');
      }
      maskManager.combineGray(gray, mode);
      pushMaskVersion();
      refreshSelectionState();
    } catch (err) {
      ElMessage.error(`颜色选择失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  async function maskPostOp(op: MaskOpKind, radius: number, label: string): Promise<void> {
    if (!maskManager || busy.value) return;
    if (!hasSelection.value) {
      ElMessage.warning('当前没有选区');
      return;
    }
    busy.value = true;
    busyText.value = `${label}中…`;
    try {
      const w = imageWidth.value;
      const h = imageHeight.value;
      const gray = maskManager.getGrayMask();
      const out = await editOps.maskOp(op, gray, w, h, radius);
      maskManager.setFromGray(out);
      pushMaskVersion();
      refreshSelectionState();
    } catch (err) {
      ElMessage.error(`${label}失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  async function featherMask(): Promise<void> {
    await maskPostOp('feather', featherRadius.value, '羽化');
  }

  async function growMask(): Promise<void> {
    await maskPostOp('dilate', morphRadius.value, '膨胀');
  }

  async function shrinkMask(): Promise<void> {
    await maskPostOp('erode', morphRadius.value, '收缩');
  }

  async function smoothMaskEdge(): Promise<void> {
    await maskPostOp('feather', 2, '边缘平滑');
  }

  async function gradientFill(): Promise<void> {
    const [r1, g1, b1] = hexToRgb(gradientColor1.value);
    const [r2, g2, b2] = hexToRgb(gradientColor2.value);
    const [start, end] = gradientRange.value;
    await applyEdit(
      {
        type: 'gradient',
        angleDeg: gradientAngle.value,
        start: start / 100,
        end: end / 100,
        color1: [r1, g1, b1],
        color2: [r2, g2, b2],
      },
      '渐变替换',
    );
  }

  async function neighborhoodFill(): Promise<void> {
    if (!editedCanvas || !editedCtx || !maskManager || !history || busy.value) return;
    if (!hasSelection.value) {
      ElMessage.warning('当前没有选区');
      return;
    }
    const w = imageWidth.value;
    const h = imageHeight.value;
    const canvas = editedCanvas;
    await runTaskFlow(
      async () => {
        const imageBlob = await canvasToBlob(canvas, 'image/png');
        const maskBlob = await grayMaskToPngBlob(effectiveGrayMask(), w, h);
        return requestNeighborhoodFill(imageBlob, maskBlob, inpaintRadius.value);
      },
      '邻域渐变填充',
      async (taskId) => {
        const blob = await fetchTaskResult(taskId);
        const bmp = await createImageBitmap(blob);
        editedCtx!.clearRect(0, 0, w, h);
        editedCtx!.drawImage(bmp, 0, 0);
        bmp.close();
        imageVersion.value++;
        const snap = await canvasToBlob(canvas, 'image/png');
        const thumb = await makeThumbnail(canvas, w, h);
        history!.addEdit(
          { type: 'neighborhood_fill', params: { radius: inpaintRadius.value } },
          snap,
          thumb,
        );
        const img = activeImage.value;
        if (img) {
          img.currentId = history!.currentId;
          if (thumb) img.thumbBlob = thumb;
        }
        historyVersion.value++;
        currentHistoryId.value = history!.currentId;
        updateHistoryFlags();
        bumpData();
      },
      '邻域渐变填充完成（基于邻域颜色估算扩散，不等同于语义内容修复）',
    );
  }

  // ---------- 插入图片（画布合成） ----------

  /** 取得某张图片的“当前结果”内容（活跃缓存 / 内存历史 / 存储） */
  async function currentResultBlobFor(projectId: string, imageId: string): Promise<Blob> {
    if (projectId === activeProjectId.value) {
      const img = projectImages.value.find((i) => i.id === imageId);
      if (img?.history) {
        return img.history.getNode(img.history.currentId)?.imageBlob ?? img.originalBlob;
      }
    }
    const rows = await projectStorage.listImages(projectId);
    const row = rows.find((i) => i.id === imageId);
    if (!row) throw new Error('图片不存在');
    const nodes = await projectStorage.loadNodes(imageId);
    const current = nodes.find((n) => n.id === row.currentHistoryId);
    return current?.imageBlob ?? row.originalBlob;
  }

  const insertBaseScale = ref(1);

  async function startInsertFromImage(projectId: string, imageId: string): Promise<void> {
    if (busy.value || !hasImage.value) {
      ElMessage.warning('请先打开一张图片（或新建空白图片）再插入');
      return;
    }
    busy.value = true;
    busyText.value = '准备插入图片…';
    try {
      const rows = projectId === activeProjectId.value ? [] : await projectStorage.listImages(projectId);
      const name =
        projectImages.value.find((i) => i.id === imageId)?.name ??
        rows.find((i) => i.id === imageId)?.name ??
        '插入图片';
      const blob = await currentResultBlobFor(projectId, imageId);
      const bitmap = await createImageBitmap(blob);
      const w = imageWidth.value;
      const h = imageHeight.value;
      const base = Math.min((w * 0.8) / bitmap.width, (h * 0.8) / bitmap.height);
      const rw = bitmap.width * base;
      const rh = bitmap.height * base;
      insertBaseScale.value = base;
      insertState.value = {
        bitmap,
        rect: { x: (w - rw) / 2, y: (h - rh) / 2, width: rw, height: rh },
        sourceName: name,
      };
      insertScale.value = 1;
      libraryVisible.value = false;
      ElMessage.info('拖动调整位置，「缩放」调节大小，确认后合入画布');
    } catch (err) {
      ElMessage.error(`准备插入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  function moveInsertBy(dxImage: number, dyImage: number): void {
    const state = insertState.value;
    if (!state) return;
    state.rect.x += dxImage;
    state.rect.y += dyImage;
    insertState.value = { ...state };
    imageVersion.value++;
  }

  function setInsertScale(factor: number): void {
    const state = insertState.value;
    if (!state) return;
    const clamped = Math.min(4, Math.max(0.05, factor));
    const newW = state.bitmap.width * insertBaseScale.value * clamped;
    const newH = state.bitmap.height * insertBaseScale.value * clamped;
    const cx = state.rect.x + state.rect.width / 2;
    const cy = state.rect.y + state.rect.height / 2;
    state.rect = { x: cx - newW / 2, y: cy - newH / 2, width: newW, height: newH };
    insertScale.value = clamped;
    imageVersion.value++;
  }

  function cancelInsert(): void {
    const state = insertState.value;
    if (state) {
      state.bitmap.close();
      insertState.value = null;
    }
    insertScale.value = 1;
    imageVersion.value++;
  }

  async function confirmInsert(): Promise<void> {
    const state = insertState.value;
    if (!state || !editedCtx || !editedCanvas || !history || busy.value) return;
    busy.value = true;
    busyText.value = '合入插入的图片…';
    try {
      const w = imageWidth.value;
      const h = imageHeight.value;
      editedCtx.drawImage(state.bitmap, state.rect.x, state.rect.y, state.rect.width, state.rect.height);
      imageVersion.value++;
      const snap = await canvasToBlob(editedCanvas, 'image/png');
      const thumb = await makeThumbnail(editedCanvas, w, h);
      history.addEdit(
        {
          type: 'insert_image',
          params: {
            source: state.sourceName,
            x: Math.round(state.rect.x),
            y: Math.round(state.rect.y),
            width: Math.round(state.rect.width),
            height: Math.round(state.rect.height),
          },
        },
        snap,
        thumb,
      );
      const img = activeImage.value;
      if (img) {
        img.currentId = history.currentId;
        if (thumb) img.thumbBlob = thumb;
      }
      historyVersion.value++;
      currentHistoryId.value = history.currentId;
      updateHistoryFlags();
      bumpData();
      cancelInsert();
      ElMessage.success(`已插入「${state.sourceName}」`);
    } catch (err) {
      ElMessage.error(`插入失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  // ---------- 保存与恢复 ----------

  async function saveProject(): Promise<void> {
    if (!activeProjectId.value || busy.value) return;
    busy.value = true;
    busyText.value = '保存项目中…';
    try {
      stashActiveSession();
      const now = Date.now();
      const activeRow = projects.value.find((p) => p.id === activeProjectId.value);
      if (!activeRow) throw new Error('项目不存在');
      activeRow.updatedAt = now;
      // 注意：projects 是深层响应式数组，其元素是 Vue Proxy，
      // 直接写入 IndexedDB 会报 "could not be cloned"，必须先转为纯对象
      const projectRow: ProjectRow = { ...activeRow };
      const imageRows: ImageRow[] = [];
      const nodeRows: NodeRow[] = [];
      const regionRows: RegionRow[] = [];
      for (const img of projectImages.value) {
        imageRows.push({
          id: img.id,
          projectId: projectRow.id,
          name: img.name,
          width: img.width,
          height: img.height,
          originalBlob: img.originalBlob,
          thumbBlob: img.thumbBlob,
          currentHistoryId: img.history ? img.history.currentId : img.currentId,
          originNote: img.originNote,
          createdAt: img.createdAt,
        });
        if (img.history) {
          for (const node of img.history.allNodes()) {
            nodeRows.push({
              dbKey: `${img.id}:${node.id}`,
              imageId: img.id,
              id: node.id,
              parentId: node.parentId,
              childIds: [...node.childIds],
              op: node.op,
              time: node.time,
              label: node.label,
              imageBlob: node.imageBlob,
              thumbBlob: node.thumbBlob,
            });
          }
        }
        if (img.regions) {
          let order = 0;
          for (const region of img.regions) {
            regionRows.push({
              id: region.id,
              imageId: img.id,
              name: region.name,
              locked: region.locked,
              order: order++,
              grayBlob: await grayMaskToPngBlob(region.gray, img.width, img.height),
              thumbBlob: region.thumbBlob,
            });
          }
        }
      }
      await projectStorage.saveAll({
        project: projectRow,
        images: imageRows,
        nodes: nodeRows,
        regions: regionRows,
        activeImageId: activeImageId.value,
      });
      savedDataVersion.value = dataVersion.value;
      savedAt.value = now;
      await refreshStorageEstimate();
      ElMessage.success(
        `项目「${projectRow.name}」已保存（${imageRows.length} 张图片 · ${nodeRows.length} 个历史节点）`,
      );
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        message = '浏览器存储空间不足：请导出图片后清理空间，或清理浏览器磁盘空间后重试';
      }
      ElMessage.error(`项目保存失败：${message}`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  async function tryRestoreProject(): Promise<boolean> {
    if (hasImage.value || busy.value) return false;
    busy.value = true;
    busyText.value = '检查上次保存的项目…';
    try {
      projects.value = await projectStorage.listProjects();
      const appState = await projectStorage.loadAppState();
      if (!appState?.projectId) return false;
      if (!projects.value.some((p) => p.id === appState.projectId)) return false;
      activeProjectId.value = appState.projectId;
      projectImages.value = (await projectStorage.listImages(appState.projectId)).map(
        rowToProjectImage,
      );
      if (projectImages.value.length === 0) return false;
      const target =
        projectImages.value.find((i) => i.id === appState.imageId) ?? projectImages.value[0];
      await switchImageInternal(target.id);
      savedDataVersion.value = dataVersion.value;
      savedAt.value = projects.value.find((p) => p.id === activeProjectId.value)?.updatedAt ?? null;
      void refreshStorageEstimate();
      ElMessage.success(
        `已恢复项目「${activeProjectName.value}」的图片「${target.name}」（${projectImages.value.length} 张图片）`,
      );
      return true;
    } catch (err) {
      ElMessage.error(
        `项目恢复失败：${err instanceof Error ? err.message : String(err)}（存储数据已保留，可继续导入图片）`,
      );
      return false;
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  async function refreshStorageEstimate(): Promise<void> {
    storageUsage.value = await projectStorage.usage();
  }

  // ---------- 只读访问器 ----------

  return {
    // 项目
    projects,
    activeProjectId,
    activeProjectName,
    projectImages,
    activeImageId,
    activeImage,
    libraryVisible,
    libraryMode,
    openLibrary,
    // 图像
    hasImage,
    imageWidth,
    imageHeight,
    originalBitmap,
    originalBlob,
    sourceName,
    imageVersion,
    // 视口
    viewScale,
    viewOffsetX,
    viewOffsetY,
    viewWidth,
    viewHeight,
    // 选区/区域
    maskVersion,
    hasSelection,
    regions,
    saveCurrentRegion,
    applyRegion,
    toggleRegionLock,
    deleteRegion,
    // 历史
    historyVersion,
    currentHistoryId,
    canUndo,
    canRedo,
    // 持久化
    dirty,
    savedAt,
    storageUsage,
    saveProject,
    tryRestoreProject,
    refreshStorageEstimate,
    // 编辑
    busy,
    busyText,
    // AI
    aiTask,
    aiPoints,
    aiBox,
    clearAiAnnotations,
    addAiPoint,
    setAiBox,
    removeBackground,
    textSegment,
    runPointSegment,
    cancelAiTask,
    // 插入
    insertState,
    insertScale,
    startInsertFromImage,
    moveInsertBy,
    setInsertScale,
    confirmInsert,
    cancelInsert,
    // 工具
    activeTool,
    brushSize,
    brushHardness,
    brushMode,
    marqueeMode,
    fillColor,
    showOriginal,
    // 阶段三参数
    wandTolerance,
    wandContiguous,
    featherRadius,
    morphRadius,
    gradientColor1,
    gradientColor2,
    gradientAngle,
    gradientRange,
    inpaintRadius,
    magicWandAt,
    featherMask,
    growMask,
    shrinkMask,
    smoothMaskEdge,
    gradientFill,
    neighborhoodFill,
    // 状态栏
    cursorX,
    cursorY,
    cursorInImage,
    // 动作
    setViewSize,
    fitView,
    actualSize,
    centerView,
    zoomStep,
    zoomAtScreen,
    panBy,
    setCursor,
    importImage,
    switchImage,
    switchProject,
    createProject,
    renameProject,
    createBlankImage,
    copyImageFromOtherProject,
    selectAll,
    invertSelection,
    clearSelection,
    startBrushStroke,
    brushStrokeTo,
    endBrushStroke,
    commitMarquee,
    applyEdit,
    undo,
    redo,
    jumpToHistory,
    exportImage,
    // 内部对象访问器
    getEditedCanvas: () => editedCanvas,
    getMaskManager: () => maskManager,
    getMaskRenderer: () => maskRenderer,
    getViewport: () => viewport,
    getHistory: () => history,
  };
});
