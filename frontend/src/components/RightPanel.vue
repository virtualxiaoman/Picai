<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useEditorStore, type Region } from '../stores/editor';
import { hexToRgb } from '../core/pixelOps';
import type { CombineMode } from '../types';

const store = useEditorStore();
const textPrompt = ref('');

const regionUrls = new Map<string, string>();

function regionThumbUrl(region: Region): string | null {
  if (!region.thumbBlob) return null;
  let url = regionUrls.get(region.id);
  if (!url) {
    url = URL.createObjectURL(region.thumbBlob);
    regionUrls.set(region.id, url);
  }
  return url;
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
    <section class="panel-section">
      <h4>选区</h4>
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
      <p class="hint">
        {{ store.hasSelection ? '当前已有选区（青色覆盖层）' : '暂无选区：用画笔或几何工具创建' }}
      </p>
    </section>

    <section class="panel-section">
      <h4>区域（固定 / 解锁）</h4>
      <el-button
        size="small"
        :disabled="!store.hasSelection || store.busy"
        @click="saveRegion"
      >
        保存当前选区为区域
      </el-button>
      <div v-if="store.regions.length > 0" class="region-list">
        <div v-for="region in store.regions" :key="region.id" class="region-row">
          <img
            v-if="regionThumbUrl(region)"
            :src="regionThumbUrl(region)!"
            class="region-thumb"
            alt=""
          />
          <div v-else class="region-thumb placeholder" />
          <div class="region-meta">
            <span class="region-name">{{ region.name }}</span>
            <span class="region-lock-state">
              {{ region.locked ? '已固定：编辑时自动并集' : '未固定' }}
            </span>
          </div>
          <div class="region-actions">
            <el-button
              size="small"
              text
              :type="region.locked ? 'warning' : 'default'"
              :disabled="store.busy"
              @click="store.toggleRegionLock(region.id)"
            >
              {{ region.locked ? '解锁' : '固定' }}
            </el-button>
            <el-button size="small" text :disabled="store.busy" @click="store.applyRegion(region.id, 'add')">
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
        </div>
      </div>
      <p class="hint">
        区域默认不保存，需手动保存；「固定」的区域会在透明化/替换/渐变/邻域填充等编辑操作时自动并集；「并集/交集」可将区域合并进当前选区（默认并集语义）。
      </p>
    </section>

    <section v-if="isBrush" class="panel-section">
      <h4>画笔参数</h4>
      <div class="field">
        <label>尺寸（图像像素）：{{ store.brushSize }} px</label>
        <el-slider v-model="store.brushSize" :min="1" :max="1000" size="small" />
      </div>
      <div class="field">
        <label>硬度：{{ store.brushHardness }}%</label>
        <el-slider v-model="store.brushHardness" :min="0" :max="100" size="small" />
      </div>
      <div class="field">
        <label>模式</label>
        <el-radio-group v-model="store.brushMode" size="small">
          <el-radio-button v-for="opt in brushModeOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </el-radio-button>
        </el-radio-group>
      </div>
      <p class="hint">拖动涂抹形成连续笔迹；按住 Alt 临时减去、Shift 临时增加；[ ] 调整尺寸</p>
    </section>

    <section v-if="isMarquee" class="panel-section">
      <h4>几何选区</h4>
      <div class="field">
        <label>模式</label>
        <el-radio-group v-model="store.marqueeMode" size="small">
          <el-radio-button v-for="opt in marqueeModeOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </el-radio-button>
        </el-radio-group>
      </div>
      <p class="hint">拖动创建选区；Shift 增加、Alt 减去、Shift+Alt 交集；Shift 约束正方形/正圆</p>
    </section>

    <section v-if="isAiRemoveBg" class="panel-section">
      <h4>自动抠图（BiRefNet）</h4>
      <el-button
        type="primary"
        size="small"
        :disabled="!store.hasImage || store.busy"
        :loading="store.busy"
        @click="store.removeBackground()"
      >
        移除背景（生成前景选区）
      </el-button>
      <p class="hint">
        生成前景蒙版为新选区；点击上方「反选」可得到背景选区；AI 结果可继续用画笔修改。首次运行需加载模型。
      </p>
    </section>

    <section v-if="isAiObject" class="panel-section">
      <h4>自动对象选择（SAM 3）</h4>
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
      <p class="hint">
        基于 SAM 3 文本概念分割，分割所有匹配对象为新选区。首次运行需加载约 3.4GB 本地模型，耗时较长。
      </p>
    </section>

    <section v-if="isAiPoint" class="panel-section">
      <h4>点选 / 框选分割（SAM 3 Tracker）</h4>
      <p class="hint">
        左键点击目标添加正样本点（绿色）；Alt+点击添加排除点（红色）；拖动创建框选。可多次点击微调。
      </p>
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
    </section>

    <section v-if="isWand" class="panel-section">
      <h4>颜色选择（魔棒）</h4>
      <div class="field">
        <label>颜色容差：{{ store.wandTolerance }}</label>
        <el-slider v-model="store.wandTolerance" :min="1" :max="255" size="small" />
      </div>
      <div class="field">
        <label>选择模式</label>
        <el-radio-group v-model="store.wandContiguous" size="small">
          <el-radio-button :value="true">连续区域</el-radio-button>
          <el-radio-button :value="false">非连续（全图）</el-radio-button>
        </el-radio-group>
      </div>
      <p class="hint">点击图片选取参考颜色；Shift 点击加选、Alt 点击减选。容差越大选中范围越广。</p>
    </section>

    <section class="panel-section">
      <h4>蒙版调整</h4>
      <div class="field">
        <label>羽化半径：{{ store.featherRadius }} px</label>
        <el-slider v-model="store.featherRadius" :min="1" :max="100" size="small" />
      </div>
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
      <div class="field" style="margin-top: 10px">
        <label>膨胀 / 收缩半径：{{ store.morphRadius }} px</label>
        <el-slider v-model="store.morphRadius" :min="1" :max="100" size="small" />
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
      <p class="hint">只修改选区蒙版，不影响图像像素</p>
    </section>

    <section class="panel-section">
      <h4>填充与替换</h4>
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
      <p class="hint">操作按蒙版软边缘权重计算，未选中像素保持原样；可 Ctrl+Z 撤销</p>
    </section>

    <section class="panel-section">
      <h4>渐变替换</h4>
      <div class="field">
        <label>起始颜色 → 结束颜色</label>
        <div style="display: flex; align-items: center; gap: 8px">
          <el-color-picker v-model="store.gradientColor1" />
          <span style="color: #8a8a94">→</span>
          <el-color-picker v-model="store.gradientColor2" />
        </div>
      </div>
      <div class="field">
        <label>方向角度：{{ store.gradientAngle }}°</label>
        <el-slider v-model="store.gradientAngle" :min="0" :max="360" size="small" />
      </div>
      <div class="field">
        <label>渐变范围：{{ store.gradientRange[0] }}% ~ {{ store.gradientRange[1] }}%</label>
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
      <p class="hint">按蒙版软边缘权重混合，仅作用于当前选区</p>
    </section>

    <section class="panel-section">
      <h4>邻域渐变填充</h4>
      <div class="field">
        <label>采样半径：{{ store.inpaintRadius }} px</label>
        <el-slider v-model="store.inpaintRadius" :min="1" :max="50" size="small" />
      </div>
      <el-button
        type="primary"
        size="small"
        :disabled="!store.hasSelection || store.busy"
        :loading="store.busy"
        @click="store.neighborhoodFill()"
      >
        执行邻域填充
      </el-button>
      <p class="hint">
        从未选中区域边界采样颜色并向选区扩散。注意：这是邻域颜色估算，不等同于完整的语义内容修复（后端
        OpenCV 实现）。
      </p>
    </section>
  </div>
</template>
