<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue';
import { ElMessage } from 'element-plus';
import { useEditorStore } from '../stores/editor';
import { CanvasRenderer, type ToolPreview } from '../core/CanvasRenderer';
import { resolveCombineMode } from '../core/modifiers';

const store = useEditorStore();
const containerRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const renderer = new CanvasRenderer();

type DragMode = 'none' | 'pan' | 'brush' | 'marquee' | 'ai-point' | 'insert';
const drag = ref<DragMode>('none');
const spaceDown = ref(false);
const dropActive = ref(false);
const pointerScreen = ref<{ x: number; y: number } | null>(null);
const marqueeRect = ref<{ x: number; y: number; width: number; height: number } | null>(null);
let panLast = { x: 0, y: 0 };
let marqueeStart = { x: 0, y: 0 };
let insertLast = { x: 0, y: 0 };

const regionViewActive = computed(() => store.showRegions || !!store.regionPreviewId);

const insertScalePercent = computed({
  get: () => Math.round(store.insertScale * 100),
  set: (value: number) => {
    // 输入框被清空时 el-input-number 会传出 null，忽略避免跳到最小值
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    store.setInsertScale(value / 100);
  },
});

const isBrushTool = computed(
  () =>
    store.activeTool === 'brush-circle' ||
    store.activeTool === 'brush-square' ||
    store.activeTool === 'brush-eraser',
);
const isMarqueeTool = computed(
  () => store.activeTool === 'marquee-rect' || store.activeTool === 'marquee-ellipse',
);

const previews = computed<ToolPreview[]>(() => {
  const list: ToolPreview[] = [];
  if (regionViewActive.value) return list; // 区域查看模式下不绘制任何工具预览
  if (store.insertState) {
    const s = store.insertState;
    list.push({
      kind: 'insert',
      bitmap: s.bitmap,
      x: s.rect.x,
      y: s.rect.y,
      width: s.rect.width,
      height: s.rect.height,
    });
  }
  if ((drag.value === 'marquee' || drag.value === 'ai-point') && marqueeRect.value) {
    list.push({
      kind:
        drag.value === 'marquee' && store.activeTool === 'marquee-ellipse' ? 'ellipse' : 'rect',
      ...marqueeRect.value,
    });
  } else if (
    isBrushTool.value &&
    pointerScreen.value &&
    !store.showOriginal &&
    !store.insertState
  ) {
    list.push({
      kind: 'brush',
      shape: store.activeTool === 'brush-square' ? 'square' : 'circle',
      screenX: pointerScreen.value.x,
      screenY: pointerScreen.value.y,
      sizeImage: store.brushSize,
    });
  }
  if (store.activeTool === 'ai-point') {
    if (store.aiBox && drag.value !== 'ai-point') {
      list.push({ kind: 'rect', ...store.aiBox });
    }
    if (store.aiPoints.length > 0) {
      list.push({ kind: 'points', points: store.aiPoints });
    }
  }
  return list;
});

const cursorStyle = computed(() => {
  if (store.colorPickActive) return 'crosshair';
  if (regionViewActive.value) return 'default';
  if (store.insertState) return drag.value === 'insert' ? 'grabbing' : 'move';
  if (drag.value === 'pan') return 'grabbing';
  if (spaceDown.value) return 'grab';
  if (store.hasImage && !store.showOriginal && isBrushTool.value) return 'none';
  if (
    store.hasImage &&
    (isMarqueeTool.value || store.activeTool === 'ai-point' || store.activeTool === 'magic-wand')
  ) {
    return 'crosshair';
  }
  return 'default';
});

// ---------- 渲染调度 ----------
let rafId = 0;
let needsRender = false;

function requestRender(): void {
  if (needsRender) return;
  needsRender = true;
  rafId = requestAnimationFrame(() => {
    needsRender = false;
    doRender();
  });
}

function doRender(): void {
  const canvas = canvasRef.value;
  const container = containerRef.value;
  if (!canvas || !container) return;
  const regionsView = store.showRegions
    ? store.getRegionsViewCanvas()
    : store.regionPreviewId
      ? store.getRegionsViewCanvas(store.regionPreviewId)
      : null;
  const maskManager = store.getMaskManager();
  const maskRenderer = store.getMaskRenderer();
  let overlay: HTMLCanvasElement | null = null;
  let differenceMask: HTMLCanvasElement | null = null;
  if (maskManager && maskRenderer && !store.showOriginal && !regionViewActive.value) {
    if (store.maskDisplayMode === 'difference') {
      differenceMask = maskManager.canvas;
    } else {
      maskRenderer.update(maskManager.canvas, maskManager.version);
      overlay = maskRenderer.canvas;
    }
  }
  // AI 修复：画布按 AI 面板的视图按钮切换（原图 / AI 图 / 差异区域）
  const aiRepairView =
    store.aiRepair && store.aiView === 'ai'
      ? store.aiRepair.aiCanvas
      : store.aiRepair && store.aiView === 'diff'
        ? store.aiRepair.diffCanvas
        : null;
  const image = (regionsView ??
    aiRepairView ??
    (store.showOriginal ? store.originalBitmap : store.getEditedCanvas())) as
    | CanvasImageSource
    | null;
  renderer.render(canvas, container.clientWidth, container.clientHeight, {
    viewport: store.getViewport(),
    dpr: window.devicePixelRatio || 1,
    image,
    overlay,
    differenceMask,
    preview: previews.value,
  });
}

watchEffect(() => {
  // 收集依赖，任一变化即重绘
  void store.imageVersion;
  void store.maskVersion;
  void store.viewScale;
  void store.viewOffsetX;
  void store.viewOffsetY;
  void store.viewWidth;
  void store.viewHeight;
  void store.showOriginal;
  void store.showRegions;
  void store.regionPreviewId;
  void store.maskDisplayMode;
  void store.aiView;
  void store.aiRepair;
  void store.insertState;
  void previews.value;
  requestRender();
});

// ---------- 坐标与交互 ----------
function eventToScreen(event: PointerEvent | WheelEvent): { x: number; y: number } {
  const rect = canvasRef.value!.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function onPointerDown(event: PointerEvent): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    /* 某些环境下不支持捕获，忽略 */
  }
  const screen = eventToScreen(event);

  if (event.button === 1 || (event.button === 0 && spaceDown.value)) {
    drag.value = 'pan';
    panLast = screen;
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;
  if (!store.hasImage || store.busy || store.showOriginal || regionViewActive.value) return;

  const img = store.getViewport().toImage(screen);
  // 取色模式：点击画布采样颜色（色彩靠近的目标色）
  if (store.colorPickActive) {
    store.pickColorAt(img.x, img.y);
    return;
  }
  // 插入模式：拖动调整插入图片的位置
  if (store.insertState) {
    const rect = store.insertState.rect;
    const inside =
      img.x >= rect.x &&
      img.x <= rect.x + rect.width &&
      img.y >= rect.y &&
      img.y <= rect.y + rect.height;
    if (inside) {
      drag.value = 'insert';
      insertLast = img;
    }
    return;
  }
  if (isBrushTool.value) {
    // 橡皮擦只减不增；普通画笔 Ctrl/Shift = 并集、Alt = 减去（与魔棒统一）
    const eraser = store.activeTool === 'brush-eraser';
    const mode = eraser ? 'subtract' : resolveCombineMode(event, store.brushMode);
    const shape = store.activeTool === 'brush-square' ? 'square' : 'circle';
    store.startBrushStroke(shape, mode);
    store.brushStrokeTo(img.x, img.y);
    drag.value = 'brush';
    requestRender();
  } else if (isMarqueeTool.value) {
    marqueeStart = img;
    marqueeRect.value = { x: img.x, y: img.y, width: 0, height: 0 };
    drag.value = 'marquee';
    requestRender();
  } else if (store.activeTool === 'ai-point') {
    marqueeStart = img;
    marqueeRect.value = { x: img.x, y: img.y, width: 0, height: 0 };
    drag.value = 'ai-point';
    requestRender();
  } else if (store.activeTool === 'magic-wand') {
    // Ctrl / Shift = 与现有选区并集，Alt = 减去
    const mode = resolveCombineMode(event, 'new');
    void store.magicWandAt(img.x, img.y, mode);
  }
}

function onPointerMove(event: PointerEvent): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const screen = eventToScreen(event);
  pointerScreen.value = screen;
  const img = store.getViewport().toImage(screen);
  const inside =
    img.x >= 0 && img.y >= 0 && img.x < store.imageWidth && img.y < store.imageHeight;
  store.setCursor(Math.floor(img.x), Math.floor(img.y), inside);

  if (drag.value === 'pan') {
    store.panBy(screen.x - panLast.x, screen.y - panLast.y);
    panLast = screen;
  } else if (drag.value === 'brush') {
    store.brushStrokeTo(img.x, img.y);
    requestRender();
  } else if (drag.value === 'marquee') {
    let dx = img.x - marqueeStart.x;
    let dy = img.y - marqueeStart.y;
    if (event.shiftKey) {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx) * s;
      dy = Math.sign(dy) * s;
    }
    marqueeRect.value = {
      x: Math.min(marqueeStart.x, marqueeStart.x + dx),
      y: Math.min(marqueeStart.y, marqueeStart.y + dy),
      width: Math.abs(dx),
      height: Math.abs(dy),
    };
  } else if (drag.value === 'ai-point') {
    const dx = img.x - marqueeStart.x;
    const dy = img.y - marqueeStart.y;
    marqueeRect.value = {
      x: Math.min(marqueeStart.x, marqueeStart.x + dx),
      y: Math.min(marqueeStart.y, marqueeStart.y + dy),
      width: Math.abs(dx),
      height: Math.abs(dy),
    };
  } else if (drag.value === 'insert') {
    store.moveInsertBy(img.x - insertLast.x, img.y - insertLast.y);
    insertLast = img;
  }
}

function onPointerUp(event: PointerEvent): void {
  const canvas = canvasRef.value;
  try {
    canvas?.releasePointerCapture(event.pointerId);
  } catch {
    /* 未捕获时忽略 */
  }
  if (drag.value === 'brush') {
    store.endBrushStroke();
  } else if (drag.value === 'marquee' && marqueeRect.value) {
    const rect = marqueeRect.value;
    if (rect.width >= 1 && rect.height >= 1) {
      const mode = resolveCombineMode(event, store.marqueeMode);
      store.commitMarquee(
        store.activeTool === 'marquee-ellipse' ? 'ellipse' : 'rect',
        rect,
        mode,
      );
    } else if (rect.width > 0 && rect.height > 0) {
      ElMessage.warning('选区太小（小于 1 像素），已忽略');
    }
  } else if (drag.value === 'ai-point' && marqueeRect.value) {
    const rect = marqueeRect.value;
    if (rect.width >= 4 && rect.height >= 4) {
      store.setAiBox(rect);
    } else {
      const screen = eventToScreen(event);
      const img = store.getViewport().toImage(screen);
      store.addAiPoint(img.x, img.y, event.altKey ? 0 : 1);
    }
  }
  drag.value = 'none';
  marqueeRect.value = null;
  requestRender();
}

function onPointerLeave(): void {
  if (drag.value === 'none') {
    pointerScreen.value = null;
    store.setCursor(0, 0, false);
    requestRender();
  }
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  dropActive.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  if (['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    void store.importImage(file, file.name);
  } else {
    ElMessage.warning('仅支持 PNG / JPEG / WebP 图片');
  }
}

function onWheel(event: WheelEvent): void {
  if (!store.hasImage) return;
  event.preventDefault();
  const screen = eventToScreen(event);
  const factor = Math.exp(-event.deltaY * 0.0016);
  store.zoomAtScreen(screen.x, screen.y, factor);
}

// ---------- 快捷键与生命周期 ----------
function isEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  );
}

function onKeyDown(event: KeyboardEvent): void {
  if (isEditingTarget(event.target)) return;
  if (event.key === 'Escape') {
    if (store.insertState) {
      store.cancelInsert();
      return;
    }
    if (store.colorPickActive) {
      store.cancelColorPick();
      return;
    }
  }
  if (event.code === 'Space' && !event.repeat) {
    spaceDown.value = true;
    event.preventDefault();
  } else if (event.key === '[') {
    const step = Math.max(1, Math.round(store.brushSize * 0.15));
    store.brushSize = Math.max(1, store.brushSize - step);
  } else if (event.key === ']') {
    const step = Math.max(1, Math.round(store.brushSize * 0.15));
    store.brushSize = Math.min(1000, store.brushSize + step);
  }
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.code === 'Space') spaceDown.value = false;
}

function onWindowBlur(): void {
  spaceDown.value = false;
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  const container = containerRef.value;
  if (container) {
    resizeObserver = new ResizeObserver(() => {
      store.setViewSize(container.clientWidth, container.clientHeight);
    });
    resizeObserver.observe(container);
    store.setViewSize(container.clientWidth, container.clientHeight);
  }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onWindowBlur);
  canvasRef.value?.addEventListener('wheel', onWheel, { passive: false });
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('blur', onWindowBlur);
  canvasRef.value?.removeEventListener('wheel', onWheel);
  cancelAnimationFrame(rafId);
});
</script>

<template>
  <div
    ref="containerRef"
    class="image-viewport"
    :style="{ cursor: cursorStyle }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @pointerleave="onPointerLeave"
    @dragover.prevent="dropActive = true"
    @dragleave="dropActive = false"
    @drop="onDrop"
    @contextmenu.prevent
  >
    <canvas ref="canvasRef" class="viewport-canvas" />

    <div v-if="!store.hasImage" class="empty-hint">
      <p>拖放图片到此处，或粘贴（Ctrl+V）</p>
      <p class="sub">支持 PNG / JPEG / WebP，也可以从图片库选择或新建空白图片</p>
      <el-button type="primary" @click="store.openLibrary()">打开图片库</el-button>
    </div>

    <div v-if="dropActive" class="drop-overlay"><p>松开以导入图片</p></div>

    <div v-if="store.insertState" class="insert-bar">
      <span class="insert-title">插入「{{ store.insertState.sourceName }}」</span>
      <span class="insert-label">缩放</span>
      <el-slider v-model="insertScalePercent" :min="5" :max="400" style="width: 130px" />
      <el-input-number
        v-model="insertScalePercent"
        :min="5"
        :max="400"
        size="small"
        controls-position="right"
        style="width: 96px"
      />
      <span class="insert-percent">%</span>
      <el-button size="small" type="primary" :disabled="store.busy" @click="store.confirmInsert()">
        确认插入
      </el-button>
      <el-button size="small" @click="store.cancelInsert()">取消（Esc）</el-button>
    </div>
  </div>
</template>
