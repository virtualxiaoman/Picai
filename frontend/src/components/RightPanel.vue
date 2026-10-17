<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useEditorStore, type Region } from '../stores/editor';
import { hexToRgb } from '../core/pixelOps';
import ParamSlider from './ParamSlider.vue';
import type { CombineMode, ToolId } from '../types';

const store = useEditorStore();
const textPrompt = ref('');

// ---------- 折叠分组状态（localStorage 记忆展开/收起） ----------
const SECTION_KEY = 'picai.panel.sections';
const defaultSections: Record<string, boolean> = {
  selection: true,
  regions: true,
  tool: true,
  maskAdjust: false,
  fill: false,
  colorShift: false,
  gradient: false,
  inpaint: false,
};

function loadSections(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      return { ...defaultSections, ...parsed };
    }
  } catch {
    /* 忽略损坏的本地数据 */
  }
  return { ...defaultSections };
}

const sections = reactive(loadSections());
function toggleSection(key: string): void {
  sections[key] = !sections[key];
}
watch(
  sections,
  () => {
    try {
      localStorage.setItem(SECTION_KEY, JSON.stringify(sections));
    } catch {
      /* 存储不可用时忽略 */
    }
  },
  { deep: true },
);

/** 当前工具名称（工具参数分组标题） */
const toolLabel = computed(() => {
  const map: Record<ToolId, string> = {
    'brush-circle': '圆形画笔',
    'brush-square': '方形画笔',
    'marquee-rect': '矩形选区',
    'marquee-ellipse': '椭圆选区',
    'ai-remove-bg': '自动抠图（BiRefNet）',
    'ai-object': '自动对象选择（SAM 3）',
    'ai-point': '点选 / 框选分割（SAM 3 Tracker）',
    'magic-wand': '颜色选择（魔棒）',
  };
  return map[store.activeTool] ?? '工具参数';
});

/** 当前工具的操作说明（悬浮在区块标题左侧显示） */
const toolHintText = computed(() => {
  const map: Record<ToolId, string> = {
    'brush-circle':
      '拖动涂抹形成连续笔迹；按住 Ctrl（或 Shift）临时增加、Alt 临时减去；[ ] 调整尺寸',
    'brush-square':
      '拖动涂抹形成连续笔迹；按住 Ctrl（或 Shift）临时增加、Alt 临时减去；[ ] 调整尺寸',
    'marquee-rect':
      '拖动创建选区；Ctrl（或 Shift）增加、Alt 减去、Shift+Alt 交集；Shift 约束正方形/正圆',
    'marquee-ellipse':
      '拖动创建选区；Ctrl（或 Shift）增加、Alt 减去、Shift+Alt 交集；Shift 约束正圆/正方形',
    'ai-remove-bg':
      '生成前景蒙版为新选区；点击「选区」区中的「反选」可得到背景选区；AI 结果可继续用画笔修改。首次运行需加载模型。',
    'ai-object':
      '基于 SAM 3 文本概念分割，分割所有匹配对象为新选区。首次运行需加载约 3.4GB 本地模型，耗时较长。',
    'ai-point':
      '左键点击目标添加正样本点（绿色）；Alt+点击添加排除点（红色）；拖动创建框选。可多次点击微调。',
    'magic-wand':
      '点击图片选取参考颜色；按住 Ctrl（或 Shift）点击加选（并集）、Alt 点击减选。例如先反选出背景后，按 Ctrl 点击补选缺失部分即可自动合并。容差越大选中范围越广。',
  };
  return map[store.activeTool] ?? '';
});

// 切换工具时自动展开工具参数区
watch(
  () => store.activeTool,
  () => {
    sections.tool = true;
  },
);

const regionUrls = new Map<string, string>();

function regionThumbUrl(region: Region): string | null {
  if (region.thumbUrl) return region.thumbUrl; // 磁盘存储：直接使用服务端 URL
  if (!region.thumbBlob) return null;
  let url = regionUrls.get(region.id);
  if (!url) {
    url = URL.createObjectURL(region.thumbBlob);
    regionUrls.set(region.id, url);
  }
  return url;
}

/** 按住区域缩略图：在画布区域单独预览该区域（松开恢复） */
function startRegionPreview(region: Region, event: PointerEvent): void {
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  store.pressRegionPreview(region.id);
}

function endRegionPreview(): void {
  store.pressRegionPreview(null);
}

async function saveRegion(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      '输入区域名称（保存后可与选区并集/交集，并可固定）',
      '保存当前选区为区域',
      {
        inputPlaceholder: `区域 ${store.regions.length + 1}`,
        confirmButtonText: '保存',
        cancelButtonText: '取消',
      },
    );
    await store.saveCurrentRegion(value ?? '');
  } catch {
    /* 取消 */
  }
}

onBeforeUnmount(() => {
  for (const url of regionUrls.values()) URL.revokeObjectURL(url);
  regionUrls.clear();
});

const isBrush = computed(() => store.activeTool.startsWith('brush'));
const isMarquee = computed(() => store.activeTool.startsWith('marquee'));
const isAiRemoveBg = computed(() => store.activeTool === 'ai-remove-bg');
const isAiObject = computed(() => store.activeTool === 'ai-object');
const isAiPoint = computed(() => store.activeTool === 'ai-point');
const isWand = computed(() => store.activeTool === 'magic-wand');

// 色彩靠近
const shiftTarget = computed<[number, number, number] | null>(() => {
  // 响应式依赖由 computeShiftTargetColor 内部读取的状态提供（选区/区域/取色/手动色）
  return store.computeShiftTargetColor();
});
function rgbCss(rgb: [number, number, number] | null): string {
  return rgb ? `rgb(${rgb.map((v) => Math.round(v)).join(', ')})` : '';
}
const pickedCss = computed(() => rgbCss(store.shiftPickedColor));
const targetCss = computed(() => rgbCss(shiftTarget.value));
const canShift = computed(() => {
  if (!store.hasImage || store.busy || !shiftTarget.value) return false;
  if (store.shiftApplyToRegionId) return true;
  return store.hasSelection;
});
const shiftModeHint = computed(() => {
  switch (store.shiftMigrateMode) {
    case 'hue':
      return '仅色相迁移：保留原明度与饱和度，只把色相朝目标色转动；灰色与低饱和像素基本不受影响。';
    case 'match':
      return '分布匹配：颜色均值与色彩分布范围同时向目标对齐（目标取区域时效果最佳；目标为取色点/手动色时，强度拉满相当于靠向纯色）。';
    default:
      return '均值偏移（默认）：区域整体色彩朝目标移动，每个像素加同一偏移，明暗与纹理完全保留。';
  }
});
const canRunPoint = computed(
  () => store.hasImage && !store.busy && (store.aiPoints.length > 0 || !!store.aiBox),
);

async function runTextSegment(): Promise<void> {
  await store.textSegment(textPrompt.value);
}

const brushModeOptions: { label: string; value: CombineMode }[] = [
  { label: '增加', value: 'add' },
  { label: '减去', value: 'subtract' },
  { label: '交集', value: 'intersect' },
];

const marqueeModeOptions: { label: string; value: CombineMode }[] = [
  { label: '新建', value: 'new' },
  { label: '增加', value: 'add' },
  { label: '减去', value: 'subtract' },
  { label: '交集', value: 'intersect' },
];

/** 渐变范围起点输入（保证不超过终点） */
function setGradientRangeStart(value: number | null | undefined): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  const v = Math.min(100, Math.max(0, Math.round(value)));
  const end = store.gradientRange[1];
  store.gradientRange = [Math.min(v, end), end];
}

/** 渐变范围终点输入（保证不小于起点） */
function setGradientRangeEnd(value: number | null | undefined): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  const v = Math.min(100, Math.max(0, Math.round(value)));
  const start = store.gradientRange[0];
  store.gradientRange = [start, Math.max(v, start)];
}

const predefineColors = ['#ffffff', '#000000', '#ff5a1f', '#3b82f6', '#22c55e', '#ef4444'];

async function applySolid(): Promise<void> {
  const [r, g, b] = hexToRgb(store.fillColor);
  await store.applyEdit({ type: 'solid', color: [r, g, b] }, '纯色替换');
}

async function applyTransparent(): Promise<void> {
  await store.applyEdit({ type: 'transparent' }, '透明化');
}
</script>

<template>
  <div class="right-panel">
    <!-- 选区 -->
    <section class="panel-section">
      <el-tooltip
        content="Ctrl+Z / Ctrl+Y：按发生顺序撤销 / 重做操作——选区变化（画笔、魔棒并集、区域合并、蒙版后处理、AI 蒙版）、图片编辑（透明化/替换/渐变/填充/插入）、区域保存/删除/固定等。工具栏的撤销/重做按钮用于图片版本树导航；手动切换版本后操作撤销历史会重置。"
        placement="left"
        popper-class="panel-hint-tooltip"
        :show-after="250"
      >
        <button class="section-header" :class="{ open: sections.selection }" @click="toggleSection('selection')">
          <span class="section-title">选区</span>
          <span class="section-caret">▾</span>
        </button>
      </el-tooltip>
      <div v-if="sections.selection" class="section-body">
        <div class="row">
          <el-button size="small" :disabled="!store.hasImage || store.busy" @click="store.selectAll()">
            全选
          </el-button>
          <el-button
            size="small"
            :disabled="!store.hasImage || store.busy"
            @click="store.invertSelection()"
          >
            反选
          </el-button>
          <el-button
            size="small"
            :disabled="!store.hasImage || store.busy || !store.hasSelection"
            @click="store.clearSelection()"
          >
            清空
          </el-button>
        </div>
        <div class="field" style="margin-top: 10px">
          <label>选区显示</label>
          <el-radio-group v-model="store.maskDisplayMode" size="small">
            <el-radio-button value="fill">半透明填色</el-radio-button>
            <el-radio-button value="difference">差分反相</el-radio-button>
          </el-radio-group>
        </div>
        <p class="hint">
          {{ store.hasSelection ? '当前已有选区' : '暂无选区：用画笔或几何工具创建' }}；底色与覆盖色相近看不清时，切换到「差分反相」
        </p>
      </div>
    </section>

    <!-- 区域 -->
    <section class="panel-section">
      <el-tooltip
        content="区域默认不保存，需手动保存；「固定」的区域会在透明化/替换/渐变/邻域填充等编辑操作时自动并集；「并集/交集」可将区域合并进当前选区（默认并集语义）。"
        placement="left"
        popper-class="panel-hint-tooltip"
        :show-after="250"
      >
        <button class="section-header" :class="{ open: sections.regions }" @click="toggleSection('regions')">
          <span class="section-title">区域（{{ store.regions.length }}）</span>
          <span class="section-caret">▾</span>
        </button>
      </el-tooltip>
      <div v-if="sections.regions" class="section-body">
        <el-button size="small" :disabled="!store.hasSelection || store.busy" @click="saveRegion">
          保存当前选区为区域
        </el-button>
        <div v-if="store.regions.length > 0" class="region-list">
          <div v-for="region in store.regions" :key="region.id" class="region-row">
            <img
              v-if="regionThumbUrl(region)"
              :src="regionThumbUrl(region)!"
              class="region-thumb"
              alt=""
              title="按住预览该区域"
              @pointerdown="startRegionPreview(region, $event)"
              @pointerup="endRegionPreview()"
              @pointercancel="endRegionPreview()"
              @lostpointercapture="endRegionPreview()"
            />
            <div v-else class="region-thumb placeholder" />
            <div class="region-info">
              <el-tooltip :content="region.name" placement="top" :show-after="300">
                <span class="region-name">
                  <span
                    class="region-color-dot"
                    :style="{ background: store.regionColorOf(region.id) }"
                    title="区域配色（按住工具栏「显示区域」可见）"
                  />
                  <span class="region-name-text">{{ region.name }}</span>
                </span>
              </el-tooltip>
              <span class="region-lock-state">{{ region.locked ? '已固定' : '未固定' }}</span>
            </div>
            <div class="region-actions">
              <div class="region-action-row">
                <el-button
                  size="small"
                  text
                  :type="region.locked ? 'warning' : 'default'"
                  :disabled="store.busy"
                  @click="store.toggleRegionLock(region.id)"
                >
                  {{ region.locked ? '解锁' : '固定' }}
                </el-button>
                <el-button
                  size="small"
                  text
                  type="danger"
                  :disabled="store.busy"
                  @click="store.deleteRegion(region.id)"
                >
                  删除
                </el-button>
              </div>
              <div class="region-action-row">
                <el-button
                  size="small"
                  text
                  :disabled="store.busy"
                  @click="store.applyRegion(region.id, 'add')"
                >
                  并集
                </el-button>
                <el-button
                  size="small"
                  text
                  :disabled="store.busy"
                  @click="store.applyRegion(region.id, 'intersect')"
                >
                  交集
                </el-button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 工具参数（随当前工具切换，切换工具时自动展开） -->
    <section class="panel-section">
      <el-tooltip
        :content="toolHintText"
        placement="left"
        popper-class="panel-hint-tooltip"
        :show-after="250"
      >
        <button class="section-header" :class="{ open: sections.tool }" @click="toggleSection('tool')">
          <span class="section-title">工具参数 · {{ toolLabel }}</span>
          <span class="section-caret">▾</span>
        </button>
      </el-tooltip>
      <div v-if="sections.tool" class="section-body">
        <template v-if="isBrush">
          <ParamSlider v-model="store.brushSize" label="尺寸（图像像素）" unit="px" :min="1" :max="1000" />
          <ParamSlider v-model="store.brushHardness" label="硬度" unit="%" :min="0" :max="100" :show-range="false" />
          <div class="field">
            <label>模式</label>
            <el-radio-group v-model="store.brushMode" size="small">
              <el-radio-button v-for="opt in brushModeOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </el-radio-button>
            </el-radio-group>
          </div>
        </template>

        <template v-else-if="isMarquee">
          <div class="field">
            <label>模式</label>
            <el-radio-group v-model="store.marqueeMode" size="small">
              <el-radio-button v-for="opt in marqueeModeOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </el-radio-button>
            </el-radio-group>
          </div>
        </template>

        <template v-else-if="isAiRemoveBg">
          <el-button
            type="primary"
            size="small"
            :disabled="!store.hasImage || store.busy"
            :loading="store.busy"
            @click="store.removeBackground()"
          >
            移除背景（生成前景选区）
          </el-button>
        </template>

        <template v-else-if="isAiObject">
          <div class="field">
            <label>对象描述</label>
            <el-input
              v-model="textPrompt"
              size="small"
              placeholder="如 person、sky、cat、car"
              @keyup.enter="runTextSegment"
            />
          </div>
          <el-button
            type="primary"
            size="small"
            :disabled="!store.hasImage || store.busy || !textPrompt.trim()"
            :loading="store.busy"
            @click="runTextSegment"
          >
            按描述分割
          </el-button>
        </template>

        <template v-else-if="isAiPoint">
          <div class="row">
            <el-button
              type="primary"
              size="small"
              :disabled="!canRunPoint"
              :loading="store.busy"
              @click="store.runPointSegment()"
            >
              执行分割
            </el-button>
            <el-button
              size="small"
              :disabled="store.busy || (store.aiPoints.length === 0 && !store.aiBox)"
              @click="store.clearAiAnnotations()"
            >
              清除标注
            </el-button>
          </div>
          <p class="hint">
            <template v-if="store.aiPoints.length || store.aiBox">
              已标注 {{ store.aiPoints.length }} 个点<template v-if="store.aiBox">，1 个框</template>
            </template>
            <template v-else>尚未标注</template>
          </p>
        </template>

        <template v-else-if="isWand">
          <ParamSlider v-model="store.wandTolerance" label="颜色容差" :min="0" :max="255" />
          <div class="field">
            <label>选择模式</label>
            <el-radio-group v-model="store.wandContiguous" size="small">
              <el-radio-button :value="true">连续区域</el-radio-button>
              <el-radio-button :value="false">非连续（全图）</el-radio-button>
            </el-radio-group>
          </div>
        </template>
      </div>
    </section>

    <!-- 蒙版调整 -->
    <section class="panel-section">
      <el-tooltip
        content="只修改选区蒙版，不影响图像像素"
        placement="left"
        popper-class="panel-hint-tooltip"
        :show-after="250"
      >
        <button class="section-header" :class="{ open: sections.maskAdjust }" @click="toggleSection('maskAdjust')">
          <span class="section-title">蒙版调整</span>
          <span class="section-caret">▾</span>
        </button>
      </el-tooltip>
      <div v-if="sections.maskAdjust" class="section-body">
        <ParamSlider v-model="store.featherRadius" label="羽化半径" unit="px" :min="1" :max="100" />
        <div class="row">
          <el-button
            size="small"
            :disabled="!store.hasSelection || store.busy"
            @click="store.featherMask()"
          >
            羽化边缘
          </el-button>
          <el-button
            size="small"
            :disabled="!store.hasSelection || store.busy"
            @click="store.smoothMaskEdge()"
          >
            边缘平滑
          </el-button>
        </div>
        <div style="margin-top: 10px">
          <ParamSlider v-model="store.morphRadius" label="膨胀 / 收缩半径" unit="px" :min="1" :max="100" />
        </div>
        <div class="row">
          <el-button
            size="small"
            :disabled="!store.hasSelection || store.busy"
            @click="store.growMask()"
          >
            膨胀选区
          </el-button>
          <el-button
            size="small"
            :disabled="!store.hasSelection || store.busy"
            @click="store.shrinkMask()"
          >
            收缩选区
          </el-button>
        </div>
      </div>
    </section>

    <!-- 填充与替换 -->
    <section class="panel-section">
      <el-tooltip
        content="操作按蒙版软边缘权重计算，未选中像素保持原样；可 Ctrl+Z 撤销"
        placement="left"
        popper-class="panel-hint-tooltip"
        :show-after="250"
      >
        <button class="section-header" :class="{ open: sections.fill }" @click="toggleSection('fill')">
          <span class="section-title">填充与替换</span>
          <span class="section-caret">▾</span>
        </button>
      </el-tooltip>
      <div v-if="sections.fill" class="section-body">
        <div class="field">
          <label>替换颜色</label>
          <el-color-picker v-model="store.fillColor" :predefine="predefineColors" />
        </div>
        <div class="row">
          <el-button
            type="primary"
            size="small"
            :disabled="!store.hasSelection || store.busy"
            :loading="store.busy"
            @click="applySolid"
          >
            纯色替换
          </el-button>
          <el-button
            size="small"
            :disabled="!store.hasSelection || store.busy"
            @click="applyTransparent"
          >
            透明化
          </el-button>
        </div>
      </div>
    </section>

    <!-- 色彩靠近 -->
    <section class="panel-section">
      <el-tooltip
        content="流程提示：想先选区域1再选区域2为目标？把区域1「保存为区域」后在此将其设为应用对象，再选区域2作为目标。强度 100% 时区域均值到达目标色（分布匹配模式下同时对齐色彩分布范围）。"
        placement="left"
        popper-class="panel-hint-tooltip"
        :show-after="250"
      >
        <button class="section-header" :class="{ open: sections.colorShift }" @click="toggleSection('colorShift')">
          <span class="section-title">色彩靠近（向目标色迁移）</span>
          <span class="section-caret">▾</span>
        </button>
      </el-tooltip>
      <div v-if="sections.colorShift" class="section-body">
        <div class="field">
          <label>应用对象（被改变的区域）</label>
          <el-select v-model="store.shiftApplyToRegionId" size="small" style="width: 100%">
            <el-option :value="null" label="当前选区" />
            <el-option
              v-for="region in store.regions"
              :key="region.id"
              :value="region.id"
              :label="`区域：${region.name}`"
            />
          </el-select>
        </div>
        <div class="field">
          <label>目标颜色来源</label>
          <el-radio-group v-model="store.shiftTargetSource" size="small">
            <el-radio-button value="selection">选区/区域</el-radio-button>
            <el-radio-button value="pick">取色点</el-radio-button>
            <el-radio-button value="manual">手动</el-radio-button>
          </el-radio-group>
        </div>
        <template v-if="store.shiftTargetSource === 'selection'">
          <div class="field">
            <label>目标区域</label>
            <el-select v-model="store.shiftTargetRegionId" size="small" style="width: 100%">
              <el-option :value="null" label="当前选区" />
              <el-option
                v-for="region in store.regions"
                :key="region.id"
                :value="region.id"
                :label="`区域：${region.name}`"
              />
            </el-select>
          </div>
          <div class="field">
            <label>计算方式</label>
            <el-radio-group v-model="store.shiftTargetMode" size="small">
              <el-radio-button value="mean">均值</el-radio-button>
              <el-radio-button value="mode">众数</el-radio-button>
            </el-radio-group>
          </div>
        </template>
        <div v-else-if="store.shiftTargetSource === 'pick'" class="field">
          <label>取色点</label>
          <div style="display: flex; align-items: center; gap: 8px">
            <el-button
              size="small"
              :type="store.colorPickActive ? 'primary' : 'default'"
              :disabled="!store.hasImage || store.busy"
              @click="store.toggleColorPick()"
            >
              {{ store.colorPickActive ? '请在画布上点击…（Esc 取消）' : '在画布上取色' }}
            </el-button>
            <span class="shift-swatch" :style="{ background: pickedCss || '#2a2a2e' }" />
            <span class="hint-inline" style="margin-left: 0">{{ pickedCss || '未取色' }}</span>
          </div>
        </div>
        <div v-else class="field">
          <label>手动目标色</label>
          <el-color-picker v-model="store.shiftManualColor" />
        </div>
        <div class="field">
          <label>目标色（计算/指定结果）</label>
          <div style="display: flex; align-items: center; gap: 8px">
            <span class="shift-swatch" :style="{ background: targetCss || '#2a2a2e' }" />
            <span class="hint-inline" style="margin-left: 0">
              {{ targetCss || '请先提供目标（选择目标区域 / 取色 / 手动颜色）' }}
            </span>
          </div>
        </div>
        <div class="field">
          <label>迁移模式</label>
          <el-radio-group v-model="store.shiftMigrateMode" size="small">
            <el-radio-button value="offset">均值偏移</el-radio-button>
            <el-radio-button value="hue">仅色相</el-radio-button>
            <el-radio-button value="match">分布匹配</el-radio-button>
          </el-radio-group>
        </div>
        <p class="hint" style="margin-top: 0">{{ shiftModeHint }}</p>
        <ParamSlider v-model="store.shiftStrength" label="靠近强度" unit="%" :min="0" :max="100" :show-range="false" />
        <el-button
          type="primary"
          size="small"
          :disabled="!canShift"
          :loading="store.busy"
          @click="store.applyColorShift()"
        >
          向目标色靠近
        </el-button>
      </div>
    </section>

    <!-- 渐变替换 -->
    <section class="panel-section">
      <el-tooltip
        content="按蒙版软边缘权重混合，仅作用于当前选区"
        placement="left"
        popper-class="panel-hint-tooltip"
        :show-after="250"
      >
        <button class="section-header" :class="{ open: sections.gradient }" @click="toggleSection('gradient')">
          <span class="section-title">渐变替换</span>
          <span class="section-caret">▾</span>
        </button>
      </el-tooltip>
      <div v-if="sections.gradient" class="section-body">
        <div class="field">
          <label>起始颜色 → 结束颜色</label>
          <div style="display: flex; align-items: center; gap: 8px">
            <el-color-picker v-model="store.gradientColor1" />
            <span style="color: #8a8a94">→</span>
            <el-color-picker v-model="store.gradientColor2" />
          </div>
        </div>
        <ParamSlider v-model="store.gradientAngle" label="方向角度" unit="°" :min="0" :max="360" />
        <div class="param-slider">
          <div class="param-head">
            <span class="param-label">渐变范围</span>
            <span class="param-input-wrap">
              <el-input-number
                :model-value="store.gradientRange[0]"
                :min="0"
                :max="100"
                size="small"
                controls-position="right"
                style="width: 84px"
                @update:model-value="setGradientRangeStart"
              />
              <span class="param-unit">%</span>
              <span style="color: #8a8a94">~</span>
              <el-input-number
                :model-value="store.gradientRange[1]"
                :min="0"
                :max="100"
                size="small"
                controls-position="right"
                style="width: 84px"
                @update:model-value="setGradientRangeEnd"
              />
              <span class="param-unit">%</span>
            </span>
          </div>
          <el-slider v-model="store.gradientRange" range :min="0" :max="100" size="small" />
        </div>
        <el-button
          type="primary"
          size="small"
          :disabled="!store.hasSelection || store.busy"
          :loading="store.busy"
          @click="store.gradientFill()"
        >
          应用渐变替换
        </el-button>
      </div>
    </section>

    <!-- 邻域渐变填充 -->
    <section class="panel-section">
      <el-tooltip
        content="从未选中区域边界采样颜色并向选区扩散。注意：这是邻域颜色估算，不等同于完整的语义内容修复（后端 OpenCV 实现）。"
        placement="left"
        popper-class="panel-hint-tooltip"
        :show-after="250"
      >
        <button class="section-header" :class="{ open: sections.inpaint }" @click="toggleSection('inpaint')">
          <span class="section-title">邻域渐变填充</span>
          <span class="section-caret">▾</span>
        </button>
      </el-tooltip>
      <div v-if="sections.inpaint" class="section-body">
        <ParamSlider v-model="store.inpaintRadius" label="采样半径" unit="px" :min="1" :max="50" />
        <el-button
          type="primary"
          size="small"
          :disabled="!store.hasSelection || store.busy"
          :loading="store.busy"
          @click="store.neighborhoodFill()"
        >
          执行邻域填充
        </el-button>
      </div>
    </section>
  </div>
</template>
