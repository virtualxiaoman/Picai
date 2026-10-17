/**
 * 编辑器全局状态：项目/图片、视口、选区、历史、区域与工具参数。
 * 画布/管理器等重对象用 markRaw 持有，组件通过版本号响应式刷新。
 */

import { defineStore } from 'pinia';
import { computed, markRaw, ref, shallowRef, watch } from 'vue';
import { ElMessage } from 'element-plus';

import { Viewport } from '../core/viewport';
import { SelectionManager, type BrushShape } from '../core/SelectionManager';
import { HistoryManager, type HistoryNode } from '../core/HistoryManager';
import { OperationHistory, type OperationEntry, type OperationKind } from '../core/OperationHistory';
import { MaskRenderer } from '../core/MaskRenderer';
import { EditOperations } from '../core/EditOperations';
import { buildExportFilename, downloadBlob, encodeCanvas } from '../core/ExportService';
import { canvasToBlob, grayMaskToPngBlob, grayToThumbBlob, makeThumbnail } from '../core/imageUtils';
import { grayToRgba, hexToRgb, maskedMeanColor, maskedModeColor, rgbToLab } from '../core/pixelOps';
import {
  blobName,
  projectStorage,
  type ImageRow,
  type ManifestImage,
  type ManifestNode,
  type ManifestRegion,
  type OpenedProject,
  type ProjectManifest,
  type ProjectRow,
} from '../core/ProjectStorage';
import { LegacyIndexedDbStorage } from '../core/legacyIndexedDb';
import {
  loadPrefs,
  readPrefBool,
  readPrefNumber,
  readPrefRange,
  readPrefString,
  savePrefs,
} from '../core/prefs';
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
import type {
  ColorShiftMode,
  CombineMode,
  ExportFormat,
  MaskOpKind,
  PixelOp,
  ToolId,
} from '../types';

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
  /** 磁盘存储：区域缩略图 URL（可直接用于 <img> 展示） */
  thumbUrl?: string | null;
}

/** 项目内的图片（元数据 + 惰性运行时状态） */
export interface ProjectImage {
  id: string;
  name: string;
  width: number;
  height: number;
  createdAt: number;
  originNote: string;
  /** 原图数据：本地新导入时携带 Blob；磁盘加载的图片按需从 originalUrl 拉取 */
  originalBlob: Blob | null;
  originalUrl: string | null;
  thumbBlob: Blob | null;
  thumbUrl: string | null;
  /** 当前历史节点 id（未载入时来自存储） */
  currentId: number;
  history: HistoryManager | null;
  /**
   * 该图片的全部区域对象（注册表，共享引用）。
   * 每个历史节点通过 regionIds 记录自己包含哪些区域，撤销/跳转版本时区域列表随版本切换；
   * 区域对象本身不被修改（锁定状态除外），因此多版本共享不增加存储与内存开销。
   */
  regionRegistry: Region[] | null;
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
  /** 当前项目在磁盘上的打开态（清单缓存：节点/区域按需取用） */
  let openedProject: OpenedProject | null = null;
  /** 服务端已存在的 Blob 文件名（保存时只上传缺的部分） */
  let serverBlobNames = new Set<string>();

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
  /** 统一操作历史（Ctrl+Z/Y 专用；与图片版本树导航相互独立） */
  const operationHistory = markRaw(new OperationHistory());
  /** 与操作栈当前游标对应的蒙版状态（null = 空选区）；用于记录选区操作的前后快照 */
  let lastMaskState: Uint8ClampedArray | null = null;
  /** 操作历史面板展示用（轻量列表，不含蒙版快照） */
  const operationsView = ref<Array<{ label: string; kind: OperationKind }>>([]);
  const operationCursor = ref(-1);

  function syncOperationHistory(): void {
    operationsView.value = operationHistory.list();
    operationCursor.value = operationHistory.depth.undo - 1;
  }

  function pushOperation(entry: Omit<OperationEntry, 'bytes'>): void {
    operationHistory.push(entry);
    syncOperationHistory();
  }

  function resetOperationHistory(): void {
    operationHistory.reset();
    lastMaskState = null;
    syncOperationHistory();
  }

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

  // ---------- 工具（参数默认值跨项目记忆，存于 localStorage 偏好） ----------
  const prefs = loadPrefs();
  const combineModes = ['new', 'add', 'subtract', 'intersect'];
  const toolIds: ToolId[] = [
    'brush-circle',
    'brush-square',
    'marquee-rect',
    'marquee-ellipse',
    'ai-remove-bg',
    'ai-object',
    'ai-point',
    'magic-wand',
  ];

  const activeTool = ref<ToolId>(
    readPrefString(prefs, 'activeTool', 'brush-circle', toolIds) as ToolId,
  );
  const brushSize = ref(readPrefNumber(prefs, 'brushSize', 64, 1, 1000));
  const brushHardness = ref(readPrefNumber(prefs, 'brushHardness', 90, 0, 100));
  const brushMode = ref<CombineMode>(
    readPrefString(prefs, 'brushMode', 'add', combineModes) as CombineMode,
  );
  const marqueeMode = ref<CombineMode>(
    readPrefString(prefs, 'marqueeMode', 'new', combineModes) as CombineMode,
  );
  const fillColor = ref(readPrefString(prefs, 'fillColor', '#ff5a1f'));
  const showOriginal = ref(false);

  const wandTolerance = ref(readPrefNumber(prefs, 'wandTolerance', 32, 0, 255));
  const wandContiguous = ref(readPrefBool(prefs, 'wandContiguous', true));
  const featherRadius = ref(readPrefNumber(prefs, 'featherRadius', 8, 1, 100));
  const morphRadius = ref(readPrefNumber(prefs, 'morphRadius', 8, 1, 100));
  const gradientColor1 = ref(readPrefString(prefs, 'gradientColor1', '#000000'));
  const gradientColor2 = ref(readPrefString(prefs, 'gradientColor2', '#ffffff'));
  const gradientAngle = ref(readPrefNumber(prefs, 'gradientAngle', 90, 0, 360));
  const gradientRange = ref<[number, number]>(readPrefRange(prefs, 'gradientRange', [0, 100]));
  const inpaintRadius = ref(readPrefNumber(prefs, 'inpaintRadius', 8, 1, 50));

  // 导出选项（跨项目记忆）
  const exportFormat = ref<ExportFormat>(
    readPrefString(prefs, 'exportFormat', 'png', ['png', 'jpeg', 'webp']) as ExportFormat,
  );
  const exportQuality = ref(readPrefNumber(prefs, 'exportQuality', 92, 50, 100));
  const exportBackground = ref(readPrefString(prefs, 'exportBackground', '#ffffff'));

  // 选区显示模式（跨项目记忆）：半透明填色 / 差分（反相，底色相近时也清晰可辨）
  const maskDisplayMode = ref<'fill' | 'difference'>(
    readPrefString(prefs, 'maskDisplayMode', 'fill', ['fill', 'difference']) as
      | 'fill'
      | 'difference',
  );

  // 色彩靠近（向目标色迁移；参数默认值跨项目记忆，区域 id / 取色点不记忆）
  /** 应用对象（被改变的区域）：null = 当前选区，否则为已保存区域 id */
  const shiftApplyToRegionId = ref<string | null>(null);
  const shiftTargetSource = ref<'selection' | 'pick' | 'manual'>(
    readPrefString(prefs, 'shiftTargetSource', 'selection', ['selection', 'pick', 'manual']) as
      | 'selection'
      | 'pick'
      | 'manual',
  );
  /** 目标区域：null = 当前选区，否则为已保存区域 id */
  const shiftTargetRegionId = ref<string | null>(null);
  const shiftTargetMode = ref<'mean' | 'mode'>(
    readPrefString(prefs, 'shiftTargetMode', 'mean', ['mean', 'mode']) as 'mean' | 'mode',
  );
  const shiftMigrateMode = ref<ColorShiftMode>(
    readPrefString(prefs, 'shiftMigrateMode', 'offset', ['offset', 'hue', 'match']) as ColorShiftMode,
  );
  const shiftPickedColor = ref<[number, number, number] | null>(null);
  const shiftManualColor = ref(readPrefString(prefs, 'shiftManualColor', '#3b82f6'));
  const shiftStrength = ref(readPrefNumber(prefs, 'shiftStrength', 80, 0, 100));

  // ---------- 偏好保存（防抖 300ms，参数变化时写 localStorage） ----------
  let prefSaveTimer: number | null = null;
  function schedulePrefsSave(): void {
    if (prefSaveTimer != null) window.clearTimeout(prefSaveTimer);
    prefSaveTimer = window.setTimeout(() => {
      prefSaveTimer = null;
      savePrefs({
        activeTool: activeTool.value,
        brushSize: brushSize.value,
        brushHardness: brushHardness.value,
        brushMode: brushMode.value,
        marqueeMode: marqueeMode.value,
        fillColor: fillColor.value,
        wandTolerance: wandTolerance.value,
        wandContiguous: wandContiguous.value,
        featherRadius: featherRadius.value,
        morphRadius: morphRadius.value,
        gradientColor1: gradientColor1.value,
        gradientColor2: gradientColor2.value,
        gradientAngle: gradientAngle.value,
        gradientRange: [...gradientRange.value],
        inpaintRadius: inpaintRadius.value,
        shiftTargetSource: shiftTargetSource.value,
        shiftTargetMode: shiftTargetMode.value,
        shiftMigrateMode: shiftMigrateMode.value,
        shiftManualColor: shiftManualColor.value,
        shiftStrength: shiftStrength.value,
        exportFormat: exportFormat.value,
        exportQuality: exportQuality.value,
        exportBackground: exportBackground.value,
        maskDisplayMode: maskDisplayMode.value,
      });
    }, 300);
  }

  watch(
    [
      activeTool,
      brushSize,
      brushHardness,
      brushMode,
      marqueeMode,
      fillColor,
      wandTolerance,
      wandContiguous,
      featherRadius,
      morphRadius,
      gradientColor1,
      gradientColor2,
      gradientAngle,
      gradientRange,
      inpaintRadius,
      shiftTargetSource,
      shiftTargetMode,
      shiftMigrateMode,
      shiftManualColor,
      shiftStrength,
      exportFormat,
      exportQuality,
      exportBackground,
      maskDisplayMode,
    ],
    () => schedulePrefsSave(),
  );
  const colorPickActive = ref(false);
  let shiftPixelCache: { version: number; data: Uint8ClampedArray } | null = null;
  let shiftGrayCache: { version: number; data: Uint8ClampedArray } | null = null;

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
      originalBlob: null,
      originalUrl: row.originalUrl,
      thumbBlob: null,
      thumbUrl: row.thumbUrl,
      currentId: row.currentHistoryId,
      history: null,
      regionRegistry: null,
    };
  }

  /** 取某历史版本上包含的区域（按注册表映射 regionIds） */
  function regionsForNode(node: HistoryNode): Region[] {
    const registry = activeImage.value?.regionRegistry ?? [];
    const byId = new Map(registry.map((r) => [r.id, r] as const));
    const list: Region[] = [];
    for (const id of node.regionIds ?? []) {
      const region = byId.get(id);
      if (region) list.push(region);
    }
    return list;
  }

  async function ensureActiveProject(): Promise<string> {
    if (activeProjectId.value) return activeProjectId.value;
    const now = Date.now();
    const row: ProjectRow = {
      id: newId('p'),
      folder: '',
      name: '未命名项目',
      createdAt: now,
      updatedAt: now,
      imageCount: 0,
    };
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
    resetOperationHistory();
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
    resetOperationHistory(); // 操作撤销历史随图片切换重置
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
    applyImageState(img);
    const cachedNode = history.current;
    regions.value = cachedNode ? regionsForNode(cachedNode) : [];
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
    currentBlob: Blob,
  ): Promise<void> {
    if (!img.originalBlob) {
      if (!img.originalUrl) throw new Error(`图片「${img.name}」的原图数据缺失`);
      img.originalBlob = await projectStorage.fetchBlob(img.originalUrl);
    }
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
    applyImageState(img);
    const builtNode = hist.current;
    regions.value = builtNode ? regionsForNode(builtNode) : [];
  }

  async function switchImageInternal(imageId: string): Promise<void> {
    const target = projectImages.value.find((i) => i.id === imageId);
    if (!target) throw new Error('图片不存在');
    stashActiveSession();
    if (restoreCachedSession(imageId)) return;
    let hist = target.history;
    if (!hist) {
      const nodes = openedProject?.nodesOf(imageId) ?? [];
      if (nodes.length === 0) throw new Error(`图片「${target.name}」的历史数据缺失`);
      hist = new HistoryManager();
      hist.restore(nodes, target.currentId);
      target.history = hist;
    }
    let registry = target.regionRegistry;
    if (!registry) {
      const rows = openedProject ? await openedProject.regionsOf(imageId) : [];
      registry = [];
      for (const row of rows) {
        registry.push({
          id: row.id,
          name: row.name,
          locked: row.locked,
          gray: await decodeGrayBlob(row.grayBlob),
          thumbBlob: null,
          thumbUrl: row.thumbUrl,
        });
      }
      target.regionRegistry = registry;
      // 旧数据兼容：没有 regionIds 的节点视为空集，当前节点继承该图片的全部区域
      const currentNode = hist.getNode(hist.currentId);
      const currentLegacy = !!currentNode && currentNode.regionIds === undefined;
      for (const node of hist.allNodes()) {
        if (!Array.isArray(node.regionIds)) node.regionIds = [];
      }
      if (currentLegacy && currentNode) {
        currentNode.regionIds = registry.map((r) => r.id);
      }
    }
    // 当前版本快照：磁盘节点按需拉取；再回落到原图
    const currentNode = hist.getNode(hist.currentId);
    let currentBlob = currentNode?.imageBlob ?? null;
    if (!currentBlob && currentNode?.snapshotUrl) {
      currentBlob = await projectStorage.fetchBlob(currentNode.snapshotUrl);
      currentNode.imageBlob = currentBlob;
    }
    if (!currentBlob) {
      if (!target.originalBlob) {
        if (!target.originalUrl) throw new Error(`图片「${target.name}」的数据缺失`);
        target.originalBlob = await projectStorage.fetchBlob(target.originalUrl);
      }
      currentBlob = target.originalBlob;
    }
    await buildSessionForImage(target, hist, currentBlob);
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
      originalUrl: null,
      thumbBlob: thumb,
      thumbUrl: null,
      currentId: -1,
      history: null,
      regionRegistry: null,
    };
    const hm = new HistoryManager();
    const root = hm.init(sourceBlob, thumb, rootLabel ?? (originNote ? `导入（${originNote}）` : '原图'));
    img.history = hm;
    img.regionRegistry = [];
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
      const sourceFolder = projects.value.find((p) => p.id === sourceProjectId)?.folder;
      if (!sourceFolder) throw new Error('源项目不存在');
      const opened = await projectStorage.openProject(sourceFolder);
      const sourceRow = opened.images.find((i) => i.id === imageId);
      if (!sourceRow) throw new Error('源图片不存在');
      let blob: Blob = await projectStorage.fetchBlob(sourceRow.originalUrl);
      const current = opened.nodesOf(imageId).find((n) => n.id === sourceRow.currentHistoryId);
      if (current?.snapshotUrl) blob = await projectStorage.fetchBlob(current.snapshotUrl);
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
    // 切换项目会丢弃旧项目的内存状态：有未保存改动时先自动保存，失败则中止切换
    if (hasImage.value && dirty.value) {
      const previousName = activeProjectName.value;
      await saveProject();
      if (dirty.value) {
        ElMessage.error('当前项目自动保存失败，已取消切换（请检查浏览器存储空间后重试）');
        return;
      }
      ElMessage.info(`已自动保存「${previousName}」再切换`);
    }
    busy.value = true;
    busyText.value = '切换项目…';
    try {
      stashActiveSession();
      const row = projects.value.find((p) => p.id === projectId);
      if (!row) throw new Error('项目不存在');
      activeProjectId.value = projectId;
      projectImages.value = [];
      openedProject = null;
      serverBlobNames = new Set();
      if (row.folder) {
        const opened = await projectStorage.openProject(row.folder);
        openedProject = opened;
        serverBlobNames = new Set(opened.blobNames);
        row.folder = opened.project.folder;
        projectImages.value = opened.images.map(rowToProjectImage);
      }
      clearImageState();
      const remembered = lastImageByProject.get(projectId);
      const target =
        projectImages.value.find((i) => i.id === remembered) ?? projectImages.value[0];
      if (target) await switchImageInternal(target.id);
      libraryVisible.value = false;
    } catch (err) {
      ElMessage.error(
        `切换项目失败：${err instanceof Error ? err.message : String(err)}（请确认后端已启动）`,
      );
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  function createProject(name: string): void {
    const now = Date.now();
    const row: ProjectRow = {
      id: newId('p'),
      folder: '',
      name: name.trim() || '未命名项目',
      createdAt: now,
      updatedAt: now,
      imageCount: 0,
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

  /** 选区操作完成后记录到统一操作历史 */
  function recordSelectionOp(label: string): void {
    if (!maskManager) return;
    const after = maskManager.getGrayMask();
    pushOperation({ kind: 'selection', label, before: lastMaskState, after });
    lastMaskState = after;
  }

  /** 图片编辑操作完成后记录（撤销时移动版本树指针到父版本） */
  function recordEditOp(label: string, node: HistoryNode): void {
    pushOperation({ kind: 'edit', label, nodeId: node.id });
  }

  /** Ctrl+Z：撤销上一个操作（选区变化 / 图片编辑 / 区域管理） */
  async function undoOperation(): Promise<void> {
    if (busy.value || !history || !maskManager) return;
    const entry = operationHistory.undo();
    if (!entry) return;
    await applyOperation(entry, false);
    syncOperationHistory();
  }

  /** Ctrl+Y / Ctrl+Shift+Z：重做上一个被撤销的操作 */
  async function redoOperation(): Promise<void> {
    if (busy.value || !history || !maskManager) return;
    const entry = operationHistory.redo();
    if (!entry) return;
    await applyOperation(entry, true);
    syncOperationHistory();
  }

  /** 操作历史面板：跳转到任意步骤（-1 = 初始状态），内部逐步应用撤销/重做 */
  async function jumpToOperation(targetIndex: number): Promise<void> {
    if (busy.value || !history || !maskManager) return;
    let cursor = operationHistory.depth.undo - 1;
    while (cursor > targetIndex) {
      const entry = operationHistory.undo();
      if (!entry) break;
      await applyOperation(entry, false);
      cursor--;
    }
    while (cursor < targetIndex) {
      const entry = operationHistory.redo();
      if (!entry) break;
      await applyOperation(entry, true);
      cursor++;
    }
    syncOperationHistory();
  }

  /** 应用/撤销一条操作记录（redo=false 表示撤销） */
  async function applyOperation(entry: OperationEntry, redo: boolean): Promise<void> {
    if (entry.kind === 'selection') {
      if (!maskManager) return;
      const state = (redo ? entry.after : entry.before) ?? null;
      if (state) maskManager.setFromGray(state);
      else maskManager.clearAll();
      lastMaskState = state;
      pushMaskVersion();
      refreshSelectionState();
      return;
    }
    if (entry.kind === 'edit') {
      if (!history || entry.nodeId == null) return;
      const node = history.getNode(entry.nodeId);
      if (!node) return;
      if (!redo) {
        // 撤销：当前应停在该节点上，指针回到父版本
        if (history.currentId !== node.id || node.parentId == null) return;
        history.jumpTo(node.parentId);
        const parent = history.current;
        if (parent) await loadNode(parent);
      } else {
        // 重做：指针回到该节点
        if (history.currentId !== node.parentId) return;
        history.jumpTo(node.id);
        await loadNode(node);
      }
      return;
    }
    // 区域管理操作（仅元数据，不影响图片与蒙版）
    const currentNode = history?.current;
    if (!currentNode) return;
    if (entry.kind === 'region_save' || entry.kind === 'region_delete') {
      const addBack = entry.kind === 'region_save' ? redo : !redo;
      const has = (currentNode.regionIds ?? []).includes(entry.regionId!);
      if (addBack && !has) {
        currentNode.regionIds = [...(currentNode.regionIds ?? []), entry.regionId!];
      } else if (!addBack && has) {
        currentNode.regionIds = (currentNode.regionIds ?? []).filter((id) => id !== entry.regionId);
      }
      regions.value = regionsForNode(currentNode);
    } else if (entry.kind === 'region_lock') {
      const region = regions.value.find((r) => r.id === entry.regionId);
      if (!region) return;
      region.locked = redo ? !entry.lockedBefore : !!entry.lockedBefore;
      regions.value = [...regions.value];
    }
    bumpData();
  }

  function selectAll(): void {
    maskManager?.selectAll();
    pushMaskVersion();
    refreshSelectionState();
    recordSelectionOp('全选');
  }

  function invertSelection(): void {
    maskManager?.invert();
    pushMaskVersion();
    refreshSelectionState();
    recordSelectionOp('反选');
  }

  function clearSelection(): void {
    maskManager?.clearAll();
    pushMaskVersion();
    refreshSelectionState();
    recordSelectionOp('清空选区');
  }

  function endBrushStroke(): void {
    maskManager?.endStroke();
    pushMaskVersion();
    refreshSelectionState();
    recordSelectionOp('画笔选区');
  }

  function commitMarquee(
    shape: 'rect' | 'ellipse',
    rect: { x: number; y: number; width: number; height: number },
    mode: CombineMode,
  ): void {
    maskManager?.marquee(shape, rect, mode);
    pushMaskVersion();
    refreshSelectionState();
    recordSelectionOp('几何选区');
  }

  // ---------- 临时查看（按住显示，松开恢复；不改变任何编辑状态） ----------

  /** 按住「显示区域」按钮时为 true */
  const showRegions = ref(false);

  /** 按住查看原图（showOriginal 语义改为：按住期间为 true） */
  function pressOriginal(on: boolean): void {
    showOriginal.value = on && hasImage.value;
  }

  function pressRegions(on: boolean): void {
    showRegions.value = on && hasImage.value && regions.value.length > 0;
  }

  /** 按住区域缩略图时，在画布区域单独预览该区域 */
  const regionPreviewId = ref<string | null>(null);

  function pressRegionPreview(regionId: string | null): void {
    regionPreviewId.value =
      regionId && hasImage.value && regions.value.some((r) => r.id === regionId)
        ? regionId
        : null;
  }

  /** 区域配色：参考 Apple 系统色，色相间隔尽量拉开，保证同图内区分度 */
  const REGION_PALETTE = [
    '#FF3B30', // 红
    '#FF9500', // 橙
    '#FFD60A', // 黄
    '#30D158', // 绿
    '#00C7BE', // 青绿
    '#64D2FF', // 天蓝
    '#0A84FF', // 蓝
    '#5E5CE6', // 靛蓝
    '#BF5AF2', // 紫
    '#FF375F', // 玫红
  ];

  /**
   * 区域配色：按图片级注册表的创建顺序分配（同图不同区域颜色不同、跨会话稳定）；
   * 找不到时回退为 id 哈希。
   */
  function regionColorOf(regionId: string): string {
    const registry = activeImage.value?.regionRegistry;
    if (registry) {
      const index = registry.findIndex((r) => r.id === regionId);
      if (index >= 0) return REGION_PALETTE[index % REGION_PALETTE.length];
    }
    let hash = 0;
    for (let i = 0; i < regionId.length; i++) hash = (hash * 31 + regionId.charCodeAt(i)) >>> 0;
    return REGION_PALETTE[hash % REGION_PALETTE.length];
  }

  let regionsViewCache: { key: string; canvas: HTMLCanvasElement } | null = null;

  /**
   * 区域可视化画布（不同区域不同颜色，固定的区域颜色更实；按需构建并缓存）。
   * 传入 onlyRegionId 时只渲染该区域（按住缩略图预览用）。
   */
  function getRegionsViewCanvas(onlyRegionId?: string | null): HTMLCanvasElement | null {
    const list = onlyRegionId
      ? regions.value.filter((r) => r.id === onlyRegionId)
      : regions.value;
    if (!hasImage.value || list.length === 0) return null;
    const w = imageWidth.value;
    const h = imageHeight.value;
    const key = `${activeImageId.value}:${onlyRegionId ?? 'all'}:${list
      .map((r) => `${r.id}${r.locked ? 'L' : ''}`)
      .join(',')}`;
    if (regionsViewCache && regionsViewCache.key === key) return regionsViewCache.canvas;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d')!;
    const layer = document.createElement('canvas');
    layer.width = w;
    layer.height = h;
    const lctx = layer.getContext('2d')!;
    for (const region of list) {
      lctx.globalCompositeOperation = 'source-over';
      lctx.clearRect(0, 0, w, h);
      lctx.putImageData(new ImageData(grayToRgba(region.gray), w, h), 0, 0);
      lctx.globalCompositeOperation = 'source-in';
      lctx.fillStyle = regionColorOf(region.id);
      lctx.fillRect(0, 0, w, h);
      // 单区域预览时更实一些
      octx.globalAlpha = onlyRegionId ? 0.9 : region.locked ? 0.9 : 0.6;
      octx.drawImage(layer, 0, 0);
    }
    octx.globalAlpha = 1;
    regionsViewCache = { key, canvas: out };
    return out;
  }

  // ---------- 区域（固定/解锁；随历史版本保存与切换） ----------

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
      const region: Region = { id: newId('rg'), name: trimmed, locked: false, gray, thumbBlob: thumb };
      // 区域对象进入图片级注册表；当前历史版本记录其 id（撤销/跳转版本时区域列表随版本切换）
      if (!img.regionRegistry) img.regionRegistry = [];
      img.regionRegistry.push(region);
      const node = history?.current;
      if (node) node.regionIds = [...(node.regionIds ?? []), region.id];
      regions.value = node ? regionsForNode(node) : [region];
      pushOperation({ kind: 'region_save', label: `保存区域「${trimmed}」`, regionId: region.id });
      bumpData();
      ElMessage.success(`已保存区域「${trimmed}」（随当前历史版本保存）`);
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
    recordSelectionOp(`合并区域「${region.name}」`);
    ElMessage.success(`区域「${region.name}」已${mode === 'add' ? '并集' : '交集'}到当前选区`);
  }

  function toggleRegionLock(regionId: string): void {
    const region = regions.value.find((r) => r.id === regionId);
    if (!region) return;
    // 锁定状态存于共享区域对象上（跨版本共享同一把"锁"）
    const lockedBefore = region.locked;
    region.locked = !region.locked;
    regions.value = [...regions.value]; // shallowRef 下显式触发更新
    pushOperation({ kind: 'region_lock', label: region.locked ? `固定区域「${region.name}」` : `解锁区域「${region.name}」`, regionId, lockedBefore });
    bumpData();
  }

  function deleteRegion(regionId: string): void {
    // 仅从当前历史版本移除；其他版本（若仍引用该区域）不受影响
    const opNode = history?.current;
    if (opNode) opNode.regionIds = (opNode.regionIds ?? []).filter((id) => id !== regionId);
    regions.value = regions.value.filter((r) => r.id !== regionId);
    pushOperation({ kind: 'region_delete', label: '删除区域', regionId });
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

  async function applyEdit(
    op: PixelOp,
    label: string,
    maskOverride?: Uint8ClampedArray,
  ): Promise<void> {
    if (!editedCtx || !editedCanvas || !maskManager || !history || busy.value) return;
    if (!maskOverride && !hasSelection.value && !regions.value.some((r) => r.locked)) {
      ElMessage.warning('当前没有选区，请先使用选择工具创建选区');
      return;
    }
    busy.value = true;
    busyText.value = `${label}处理中…`;
    try {
      const w = imageWidth.value;
      const h = imageHeight.value;
      const imgData = editedCtx.getImageData(0, 0, w, h);
      // 显式指定蒙版时（如色彩靠近的应用对象）不再附加固定区域；
      // 注意必须拷贝：Worker 会转移（transfer）蒙版缓冲，直接传引用会清空区域数据
      const gray = maskOverride ? new Uint8ClampedArray(maskOverride) : effectiveGrayMask();
      const out = await editOps.apply(imgData.data, gray, op, w, h);
      editedCtx.putImageData(new ImageData(out, w, h), 0, 0);
      imageVersion.value++;

      const snap = await canvasToBlob(editedCanvas, 'image/png');
      const thumb = await makeThumbnail(editedCanvas, w, h);
      const editNode = history.addEdit({ type: op.type, params: { ...op } }, snap, thumb);
      recordEditOp(label, editNode);
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
      // 磁盘存储的快照按需拉取并缓存回内存（撤销/跳转时）
      const snapshot =
        node.imageBlob ?? (node.snapshotUrl ? await projectStorage.fetchBlob(node.snapshotUrl) : null);
      if (snapshot) {
        node.imageBlob = snapshot;
        const bmp = await createImageBitmap(snapshot);
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
      // 区域列表随历史版本切换（每个版本记录自己的区域集合）
      regions.value = regionsForNode(node);
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
    // 手动版本导航后时间线改变：重置操作撤销栈
    resetOperationHistory();
    const node = history.undo();
    if (node) await loadNode(node);
  }

  async function redo(childId?: number): Promise<void> {
    if (!history || busy.value) return;
    resetOperationHistory();
    const node = history.redo(childId);
    if (node) await loadNode(node);
  }

  async function jumpToHistory(id: number): Promise<void> {
    if (!history || busy.value || id === history.currentId) return;
    resetOperationHistory();
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
    recordSelectionOp('AI 蒙版');
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
      recordSelectionOp('魔棒选区');
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
      recordSelectionOp(label);
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
        const fillNode = history!.addEdit(
          { type: 'neighborhood_fill', params: { radius: inpaintRadius.value } },
          snap,
          thumb,
        );
        recordEditOp('邻域渐变填充', fillNode);
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

  // ---------- 色彩靠近（向目标色迁移） ----------

  /** 目标区域的灰度蒙版（当前选区或已保存区域） */
  function getShiftTargetGray(): Uint8ClampedArray | null {
    if (!maskManager) return null;
    if (shiftTargetRegionId.value) {
      const region = regions.value.find((r) => r.id === shiftTargetRegionId.value);
      return region ? region.gray : null;
    }
    if (!hasSelection.value) return null;
    if (!shiftGrayCache || shiftGrayCache.version !== maskVersion.value) {
      shiftGrayCache = { version: maskVersion.value, data: maskManager.getGrayMask() };
    }
    return shiftGrayCache.data;
  }

  /** 确保图像像素缓存为最新 */
  function ensureShiftPixelCache(): Uint8ClampedArray | null {
    if (!editedCtx) return null;
    if (!shiftPixelCache || shiftPixelCache.version !== imageVersion.value) {
      const w = imageWidth.value;
      const h = imageHeight.value;
      shiftPixelCache = {
        version: imageVersion.value,
        data: editedCtx.getImageData(0, 0, w, h).data,
      };
    }
    return shiftPixelCache.data;
  }

  /** 计算当前设置下的目标色（选区/区域的均值或众数、取色点、手动色） */
  function computeShiftTargetColor(): [number, number, number] | null {
    if (shiftTargetSource.value === 'manual') return hexToRgb(shiftManualColor.value);
    if (shiftTargetSource.value === 'pick') return shiftPickedColor.value;
    const gray = getShiftTargetGray();
    const pixels = ensureShiftPixelCache();
    if (!gray || !pixels) return null;
    return shiftTargetMode.value === 'mode'
      ? maskedModeColor(pixels, gray)
      : maskedMeanColor(pixels, gray);
  }

  /** 目标区域在 Lab 空间的颜色标准差（分布匹配用），采样步长 4 降低主线程开销 */
  function computeTargetLabStd(gray: Uint8ClampedArray): [number, number, number] | null {
    const pixels = ensureShiftPixelCache();
    if (!pixels) return null;
    let n = 0;
    let mL = 0;
    let mA = 0;
    let mB = 0;
    let sL = 0;
    let sA = 0;
    let sB = 0;
    for (let i = 0; i < gray.length; i += 4) {
      const m = gray[i];
      if (m === 0) continue;
      const p = i * 4;
      const lab = rgbToLab(pixels[p], pixels[p + 1], pixels[p + 2]);
      mL += lab[0];
      mA += lab[1];
      mB += lab[2];
      sL += lab[0] * lab[0];
      sA += lab[1] * lab[1];
      sB += lab[2] * lab[2];
      n++;
    }
    if (n === 0) return null;
    const mean: [number, number, number] = [mL / n, mA / n, mB / n];
    return [
      Math.sqrt(Math.max(0, sL / n - mean[0] * mean[0])),
      Math.sqrt(Math.max(0, sA / n - mean[1] * mean[1])),
      Math.sqrt(Math.max(0, sB / n - mean[2] * mean[2])),
    ];
  }

  function toggleColorPick(): void {
    if (busy.value || !hasImage.value) return;
    colorPickActive.value = !colorPickActive.value;
    if (colorPickActive.value) {
      ElMessage.info('请在画布上点击要取色的位置（Esc 取消）');
    }
  }

  function cancelColorPick(): void {
    colorPickActive.value = false;
  }

  /** 画布取色：取点击处 5×5 的平均色 */
  function pickColorAt(x: number, y: number): void {
    if (!editedCtx) return;
    const cv = editedCtx.canvas;
    const cx = Math.min(cv.width - 1, Math.max(0, Math.round(x)));
    const cy = Math.min(cv.height - 1, Math.max(0, Math.round(y)));
    const x0 = Math.min(Math.max(0, cx - 2), cv.width - 5);
    const y0 = Math.min(Math.max(0, cy - 2), cv.height - 5);
    const sw = Math.min(5, cv.width);
    const sh = Math.min(5, cv.height);
    const data = editedCtx.getImageData(x0, y0, sw, sh).data;
    let r = 0;
    let g = 0;
    let b = 0;
    const n = data.length / 4;
    for (let i = 0; i < n; i++) {
      r += data[i * 4];
      g += data[i * 4 + 1];
      b += data[i * 4 + 2];
    }
    const rgb: [number, number, number] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    shiftPickedColor.value = rgb;
    shiftTargetSource.value = 'pick';
    colorPickActive.value = false;
    ElMessage.success(`已取色 rgb(${rgb.join(', ')})`);
  }

  /** 执行色彩靠近：应用对象区域整体朝目标色迁移（保留明暗与纹理） */
  async function applyColorShift(): Promise<void> {
    if (!editedCtx || busy.value) return;
    const target = computeShiftTargetColor();
    if (!target) {
      ElMessage.warning('无法确定目标颜色：请先选择目标区域、在画布上取色或设置手动颜色');
      return;
    }
    let maskOverride: Uint8ClampedArray | undefined;
    if (shiftApplyToRegionId.value) {
      const region = regions.value.find((r) => r.id === shiftApplyToRegionId.value);
      if (!region) {
        ElMessage.warning('应用对象区域不存在');
        return;
      }
      maskOverride = region.gray;
    } else if (!hasSelection.value) {
      ElMessage.warning('应用对象为「当前选区」，但当前没有选区');
      return;
    }
    // 分布匹配模式：目标为区域/选区时取目标区域的 Lab 标准差；点色/手动色按零标准差处理
    let targetStd: [number, number, number] | undefined;
    if (shiftMigrateMode.value === 'match' && shiftTargetSource.value === 'selection') {
      const targetGray = getShiftTargetGray();
      if (targetGray) targetStd = computeTargetLabStd(targetGray) ?? undefined;
    }
    await applyEdit(
      {
        type: 'color_shift',
        mode: shiftMigrateMode.value,
        target,
        targetStd,
        strength: shiftStrength.value / 100,
      },
      '色彩靠近',
      maskOverride,
    );
  }

  // ---------- 插入图片（画布合成） ----------

  /** 取得某张图片的“当前结果”内容（活跃缓存 / 内存历史 / 存储） */
  async function currentResultBlobFor(
    projectId: string,
    imageId: string,
  ): Promise<{ blob: Blob; name: string }> {
    if (projectId === activeProjectId.value) {
      const img = projectImages.value.find((i) => i.id === imageId);
      if (img?.history) {
        const node = img.history.getNode(img.history.currentId);
        if (node?.imageBlob) return { blob: node.imageBlob, name: img.name };
      }
    }
    const folder = projects.value.find((p) => p.id === projectId)?.folder;
    if (!folder) throw new Error('图片所在项目不存在');
    const opened = await projectStorage.openProject(folder);
    const row = opened.images.find((i) => i.id === imageId);
    if (!row) throw new Error('图片不存在');
    const current = opened.nodesOf(imageId).find((n) => n.id === row.currentHistoryId);
    const blob = current?.snapshotUrl
      ? await projectStorage.fetchBlob(current.snapshotUrl)
      : await projectStorage.fetchBlob(row.originalUrl);
    return { blob, name: row.name };
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
      const { blob, name } = await currentResultBlobFor(projectId, imageId);
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
      const insertNode = history.addEdit(
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
      recordEditOp('插入图片', insertNode);
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

      // 构建项目清单；只上传「服务端还没有的」Blob（按确定性文件名判断）
      const files: File[] = [];
      const referenced = new Set<string>();
      const needUpload = (name: string, blob: Blob | null | undefined): void => {
        referenced.add(name);
        if (blob && !serverBlobNames.has(name)) files.push(new File([blob], name));
      };

      const images: ManifestImage[] = [];
      let nodeCount = 0;
      for (const img of projectImages.value) {
        const manifestImage: ManifestImage = {
          id: img.id,
          name: img.name,
          width: img.width,
          height: img.height,
          currentHistoryId: img.history ? img.history.currentId : img.currentId,
          originNote: img.originNote,
          createdAt: img.createdAt,
          original: blobName.original(img.id),
          // 磁盘加载的条目只有 thumbUrl（无本地 Blob），引用仍需保留，否则保存时会被当作孤儿清理
          thumb: img.thumbBlob || img.thumbUrl ? blobName.imageThumb(img.id) : null,
          nodes: [],
          regions: [],
        };
        needUpload(manifestImage.original, img.originalBlob);
        if (manifestImage.thumb) needUpload(manifestImage.thumb, img.thumbBlob);
        if (img.history) {
          for (const node of img.history.allNodes()) {
            const manifestNode: ManifestNode = {
              id: node.id,
              parentId: node.parentId,
              childIds: [...node.childIds],
              op: node.op,
              time: node.time,
              label: node.label,
              regionIds: [...(node.regionIds ?? [])],
              snapshot: blobName.snapshot(img.id, node.id),
              thumb: node.thumbBlob || node.thumbUrl ? blobName.nodeThumb(img.id, node.id) : null,
            };
            needUpload(manifestNode.snapshot, node.imageBlob);
            if (manifestNode.thumb) needUpload(manifestNode.thumb, node.thumbBlob);
            manifestImage.nodes.push(manifestNode);
            nodeCount++;
          }
        }
        if (img.regionRegistry) {
          // 只保存仍被某个历史版本引用的区域；区域与版本的归属通过节点 regionIds 记录
          const referencedRegions = new Set<string>();
          if (img.history) {
            for (const node of img.history.allNodes()) {
              for (const id of node.regionIds ?? []) referencedRegions.add(id);
            }
          }
          let order = 0;
          for (const region of img.regionRegistry) {
            if (!referencedRegions.has(region.id)) continue;
            const manifestRegion: ManifestRegion = {
              id: region.id,
              name: region.name,
              locked: region.locked,
              order: order++,
              gray: blobName.regionGray(region.id),
              thumb: region.thumbBlob || region.thumbUrl ? blobName.regionThumb(region.id) : null,
            };
            referenced.add(manifestRegion.gray);
            if (!serverBlobNames.has(manifestRegion.gray)) {
              files.push(
                new File([await grayMaskToPngBlob(region.gray, img.width, img.height)], manifestRegion.gray),
              );
            }
            if (manifestRegion.thumb) needUpload(manifestRegion.thumb, region.thumbBlob);
            manifestImage.regions.push(manifestRegion);
          }
        }
        images.push(manifestImage);
      }

      const manifest: ProjectManifest = {
        id: activeRow.id,
        name: activeRow.name,
        createdAt: activeRow.createdAt,
        updatedAt: now,
        activeImageId: activeImageId.value,
        images,
      };
      const result = await projectStorage.saveProject(activeRow.folder || null, manifest, files);
      activeRow.folder = result.folder;
      serverBlobNames = referenced;
      if (openedProject && openedProject.project.id === activeRow.id) {
        openedProject.project.folder = result.folder;
      }
      savedDataVersion.value = dataVersion.value;
      savedAt.value = now;
      await refreshStorageEstimate();
      ElMessage.success(
        `项目「${activeRow.name}」已保存到 data/history/${result.folder}（${images.length} 张图片 · ${nodeCount} 个历史节点）`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ElMessage.error(`项目保存失败：${message}（请确认后端已启动且磁盘可写）`);
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  /** 把浏览器旧 IndexedDB 里的项目数据一次性迁移到 data/history（服务端已有同名项目则跳过） */
  async function migrateLegacyStorageIfNeeded(): Promise<number> {
    let legacy: LegacyIndexedDbStorage;
    try {
      legacy = new LegacyIndexedDbStorage();
    } catch {
      return 0;
    }
    let legacyProjects: Awaited<ReturnType<LegacyIndexedDbStorage['listProjects']>> = [];
    try {
      legacyProjects = await legacy.listProjects();
    } catch {
      return 0;
    }
    if (legacyProjects.length === 0) return 0;

    const serverProjects = await projectStorage.listProjects();
    const existingNames = new Set(serverProjects.map((p) => p.name));
    const pending = legacyProjects.filter((p) => !existingNames.has(p.name));
    if (pending.length === 0) return 0;

    const legacyState = await legacy.loadAppState();
    // 最近打开的项目放最后迁移，让服务端的 app_state 自然指向它
    pending.sort(
      (a, b) =>
        (a.id === legacyState?.projectId ? 1 : 0) - (b.id === legacyState?.projectId ? 1 : 0),
    );

    let migrated = 0;
    for (const legacyProject of pending) {
      busy.value = true;
      busyText.value = `迁移旧数据「${legacyProject.name}」…`;
      try {
        const rows = await legacy.listImages(legacyProject.id);
        const manifest: ProjectManifest = {
          id: legacyProject.id,
          name: legacyProject.name,
          createdAt: legacyProject.createdAt,
          updatedAt: legacyProject.updatedAt,
          activeImageId:
            legacyProject.id === legacyState?.projectId ? (legacyState?.imageId ?? null) : null,
          images: [],
        };
        const pendingFiles: File[] = [];
        for (const row of rows) {
          const nodes = await legacy.loadNodes(row.id);
          const regions = await legacy.loadRegions(row.id);
          // 旧数据兼容：节点缺少 regionIds 字段时视为空集，当前版本稍后继承全部区域
          const legacyCurrentNode = nodes.find((n) => n.id === row.currentHistoryId);
          const currentLacksRegions =
            !!legacyCurrentNode && !Array.isArray(legacyCurrentNode.regionIds);
          const manifestImage: ManifestImage = {
            id: row.id,
            name: row.name,
            width: row.width,
            height: row.height,
            currentHistoryId: row.currentHistoryId,
            originNote: row.originNote,
            createdAt: row.createdAt,
            original: blobName.original(row.id),
            thumb: row.thumbBlob ? blobName.imageThumb(row.id) : null,
            nodes: [],
            regions: [],
          };
          pendingFiles.push(new File([row.originalBlob], manifestImage.original));
          if (manifestImage.thumb && row.thumbBlob) {
            pendingFiles.push(new File([row.thumbBlob], manifestImage.thumb));
          }
          for (const node of nodes) {
            const manifestNode: ManifestNode = {
              id: node.id,
              parentId: node.parentId,
              childIds: [...node.childIds],
              op: node.op,
              time: node.time,
              label: node.label,
              regionIds: [...(node.regionIds ?? [])],
              snapshot: blobName.snapshot(row.id, node.id),
              thumb: node.thumbBlob ? blobName.nodeThumb(row.id, node.id) : null,
            };
            if (node.imageBlob) pendingFiles.push(new File([node.imageBlob], manifestNode.snapshot));
            if (manifestNode.thumb && node.thumbBlob) {
              pendingFiles.push(new File([node.thumbBlob], manifestNode.thumb));
            }
            manifestImage.nodes.push(manifestNode);
          }
          for (const region of regions) {
            const manifestRegion: ManifestRegion = {
              id: region.id,
              name: region.name,
              locked: region.locked,
              order: region.order,
              gray: blobName.regionGray(region.id),
              thumb: region.thumbBlob ? blobName.regionThumb(region.id) : null,
            };
            pendingFiles.push(new File([region.grayBlob], manifestRegion.gray));
            if (manifestRegion.thumb && region.thumbBlob) {
              pendingFiles.push(new File([region.thumbBlob], manifestRegion.thumb));
            }
            manifestImage.regions.push(manifestRegion);
          }
          if (currentLacksRegions && manifestImage.regions.length > 0) {
            const targetNode = manifestImage.nodes.find((n) => n.id === row.currentHistoryId);
            if (targetNode) targetNode.regionIds = manifestImage.regions.map((r) => r.id);
          }
          manifest.images.push(manifestImage);
        }

        // 1) 先写清单：创建项目文件夹（清单已引用全部文件，服务端清理不会误删）
        const { folder } = await projectStorage.saveProject(null, manifest, []);
        // 2) 分批上传 Blob（每批约 32MB，避免单请求过大）
        const batchLimit = 32 * 1024 * 1024;
        let batch: File[] = [];
        let batchSize = 0;
        const flush = async (): Promise<void> => {
          if (batch.length === 0) return;
          await projectStorage.uploadBlobs(folder, batch);
          batch = [];
          batchSize = 0;
        };
        for (const file of pendingFiles) {
          if (batchSize + file.size > batchLimit) await flush();
          batch.push(file);
          batchSize += file.size;
        }
        await flush();
        // 3) 再保存一次清单：刷新最近打开状态并清理残余
        await projectStorage.saveProject(folder, manifest, []);
        migrated++;
      } catch (err) {
        ElMessage.error(
          `旧项目「${legacyProject.name}」迁移失败：${err instanceof Error ? err.message : String(err)}（浏览器旧数据保留，可重启后重试）`,
        );
      } finally {
        busy.value = false;
        busyText.value = '';
      }
    }
    return migrated;
  }

  /** 应用启动：先尝试迁移旧浏览器存储，再恢复最近打开的项目 */
  async function initializeStorage(): Promise<void> {
    if (hasImage.value || busy.value) return;
    try {
      const migrated = await migrateLegacyStorageIfNeeded();
      if (migrated > 0) {
        ElMessage.success(
          `已把 ${migrated} 个旧项目迁移到项目目录 data/history（浏览器旧数据保留作备份）`,
        );
      }
    } catch {
      /* 后端未启动等情况：跳过迁移，不影响编辑 */
    }
    try {
      const repaired = await repairMissingThumbs();
      if (repaired > 0) ElMessage.success(`已修复 ${repaired} 个历史缩略图`);
    } catch {
      /* 后端未启动等情况：跳过修复 */
    }
    try {
      const relinked = await repairRegionLinks();
      if (relinked > 0) ElMessage.success(`已恢复 ${relinked} 个区域的版本归属`);
    } catch {
      /* 后端未启动等情况：跳过修复 */
    }
    await tryRestoreProject();
  }

  /**
   * 修复清单中缺失的缩略图引用（曾有版本在保存时丢失 thumb 引用，导致文件被清理）。
   * 优先从浏览器旧存储取缩略图，取不到则从快照/原图/蒙版重新生成。
   */
  async function repairMissingThumbs(): Promise<number> {
    const serverProjects = await projectStorage.listProjects();
    if (serverProjects.length === 0) return 0;
    let legacy: LegacyIndexedDbStorage | null = null;
    let legacyProjects: Awaited<ReturnType<LegacyIndexedDbStorage['listProjects']>> = [];
    try {
      legacy = new LegacyIndexedDbStorage();
      legacyProjects = await legacy.listProjects();
    } catch {
      legacy = null;
    }
    let repaired = 0;
    for (const project of serverProjects) {
      if (!project.folder) continue;
      let manifest: ProjectManifest;
      try {
        manifest = await projectStorage.loadManifestRaw(project.folder);
      } catch {
        continue;
      }
      const missing = manifest.images.some(
        (image) =>
          !image.thumb || image.nodes.some((n) => !n.thumb) || image.regions.some((r) => !r.thumb),
      );
      if (!missing) continue;
      busy.value = true;
      busyText.value = `修复「${project.name}」的历史缩略图…`;
      try {
        const files: File[] = [];
        const legacyProject = legacy
          ? legacyProjects.find((p) => p.name === project.name)
          : undefined;
        const legacyImages = legacyProject ? await legacy!.listImages(legacyProject.id) : [];
        for (const image of manifest.images) {
          const legacyRow = legacyImages.find((r) => r.id === image.id);
          // 图片缩略图
          if (!image.thumb) {
            const name = blobName.imageThumb(image.id);
            let blob: Blob | null = legacyRow?.thumbBlob ?? null;
            if (!blob) {
              const original = await projectStorage.fetchBlob(
                projectStorage.blobUrl(project.folder, image.original),
              );
              blob = await makeThumbnail(
                await createImageBitmap(original),
                image.width,
                image.height,
              );
            }
            if (blob) {
              files.push(new File([blob], name));
              image.thumb = name;
              repaired++;
            }
          }
          // 历史节点缩略图
          const legacyNodes = legacyRow ? await legacy!.loadNodes(image.id) : [];
          for (const node of image.nodes) {
            if (node.thumb) continue;
            const name = blobName.nodeThumb(image.id, node.id);
            let blob: Blob | null =
              legacyNodes.find((n) => n.id === node.id)?.thumbBlob ?? null;
            if (!blob) {
              const snapshot = await projectStorage.fetchBlob(
                projectStorage.blobUrl(project.folder, node.snapshot),
              );
              blob = await makeThumbnail(
                await createImageBitmap(snapshot),
                image.width,
                image.height,
              );
            }
            if (blob) {
              files.push(new File([blob], name));
              node.thumb = name;
              repaired++;
            }
          }
          // 区域缩略图
          const legacyRegions = legacyRow ? await legacy!.loadRegions(image.id) : [];
          for (const region of image.regions) {
            if (region.thumb) continue;
            const name = blobName.regionThumb(region.id);
            let blob: Blob | null =
              legacyRegions.find((r) => r.id === region.id)?.thumbBlob ?? null;
            if (!blob) {
              const grayBlob = await projectStorage.fetchBlob(
                projectStorage.blobUrl(project.folder, region.gray),
              );
              blob = await grayToThumbBlob(await decodeGrayBlob(grayBlob), image.width, image.height);
            }
            if (blob) {
              files.push(new File([blob], name));
              region.thumb = name;
              repaired++;
            }
          }
        }
        if (files.length > 0) {
          await projectStorage.saveProject(project.folder, manifest, files);
        }
      } catch (err) {
        ElMessage.warning(
          `「${project.name}」缩略图修复未完成：${err instanceof Error ? err.message : String(err)}（下次启动会重试）`,
        );
      } finally {
        busy.value = false;
        busyText.value = '';
      }
    }
    return repaired;
  }

  /**
   * 修复缺失的区域-版本归属（旧数据迁移时可能丢失）：
   * 若某图片存在区域，但没有任何历史版本记录归属，则把全部区域归到当前版本。
   */
  async function repairRegionLinks(): Promise<number> {
    const serverProjects = await projectStorage.listProjects();
    let fixed = 0;
    for (const project of serverProjects) {
      if (!project.folder) continue;
      let manifest: ProjectManifest;
      try {
        manifest = await projectStorage.loadManifestRaw(project.folder);
      } catch {
        continue;
      }
      let changed = false;
      for (const image of manifest.images) {
        if (image.regions.length === 0) continue;
        const hasAnyLink = image.nodes.some((n) => (n.regionIds ?? []).length > 0);
        if (hasAnyLink) continue;
        const currentNode = image.nodes.find((n) => n.id === image.currentHistoryId);
        if (!currentNode) continue;
        currentNode.regionIds = image.regions.map((region) => region.id);
        fixed += image.regions.length;
        changed = true;
      }
      if (changed) {
        try {
          await projectStorage.saveProject(project.folder, manifest, []);
        } catch (err) {
          ElMessage.warning(
            `「${project.name}」区域归属修复写入失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return fixed;
  }

  async function tryRestoreProject(): Promise<boolean> {
    if (hasImage.value || busy.value) return false;
    busy.value = true;
    busyText.value = '检查磁盘上的项目…';
    try {
      projects.value = await projectStorage.listProjects();
      const appState = await projectStorage.loadAppState();
      if (!appState?.projectId && !appState?.folder) return false;
      const row =
        projects.value.find((p) => p.id === appState.projectId) ??
        projects.value.find((p) => p.folder === appState.folder);
      if (!row) return false;
      activeProjectId.value = row.id;
      openedProject = null;
      serverBlobNames = new Set();
      const opened = await projectStorage.openProject(row.folder);
      openedProject = opened;
      serverBlobNames = new Set(opened.blobNames);
      row.folder = opened.project.folder;
      row.name = opened.project.name;
      projectImages.value = opened.images.map(rowToProjectImage);
      clearImageState();
      if (projectImages.value.length === 0) return false;
      const target =
        projectImages.value.find((i) => i.id === appState.imageId) ?? projectImages.value[0];
      await switchImageInternal(target.id);
      savedDataVersion.value = dataVersion.value;
      savedAt.value = row.updatedAt;
      void refreshStorageEstimate();
      ElMessage.success(
        `已恢复项目「${activeProjectName.value}」的图片「${target.name}」（${projectImages.value.length} 张图片）`,
      );
      return true;
    } catch (err) {
      ElMessage.error(
        `项目恢复失败：${err instanceof Error ? err.message : String(err)}（请确认后端已启动；磁盘数据未受影响）`,
      );
      return false;
    } finally {
      busy.value = false;
      busyText.value = '';
    }
  }

  async function refreshStorageEstimate(): Promise<void> {
    const usageInfo = await projectStorage.usage();
    storageUsage.value = usageInfo ? { usage: usageInfo.bytes, quota: 0 } : null;
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
    initializeStorage,
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
    // 导出选项（跨项目记忆）
    exportFormat,
    exportQuality,
    exportBackground,
    // 选区显示模式（跨项目记忆）
    maskDisplayMode,
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
    // 临时查看（按住显示）
    showRegions,
    pressOriginal,
    pressRegions,
    regionPreviewId,
    pressRegionPreview,
    regionColorOf,
    getRegionsViewCanvas,
    magicWandAt,
    featherMask,
    growMask,
    shrinkMask,
    smoothMaskEdge,
    gradientFill,
    neighborhoodFill,
    // 色彩靠近
    shiftApplyToRegionId,
    shiftTargetSource,
    shiftTargetRegionId,
    shiftTargetMode,
    shiftMigrateMode,
    shiftPickedColor,
    shiftManualColor,
    shiftStrength,
    colorPickActive,
    toggleColorPick,
    cancelColorPick,
    pickColorAt,
    computeShiftTargetColor,
    applyColorShift,
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
    undoOperation,
    redoOperation,
    operationsView,
    operationCursor,
    jumpToOperation,
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
