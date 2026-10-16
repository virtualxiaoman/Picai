<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  Clock,
  Collection,
  Download,
  Files,
  FolderOpened,
  FullScreen,
  Grid,
  Hide,
  Picture,
  RefreshLeft,
  RefreshRight,
  ScaleToOriginal,
  View,
} from '@element-plus/icons-vue';
import { useEditorStore } from '../stores/editor';
import ExportDialog from './ExportDialog.vue';
import HistoryPanel from './HistoryPanel.vue';
import ImageLibraryDialog from './ImageLibraryDialog.vue';

const store = useEditorStore();
const exportVisible = ref(false);
const historyVisible = ref(false);

const zoomPercent = computed(() => Math.round(store.viewScale * 100));

/** 当前节点在根到当前路径中的位置 / 总节点数，如 3/7 */
const historyPosition = computed(() => {
  void store.historyVersion;
  const history = store.getHistory();
  if (!history || !store.hasImage) return '历史';
  return `${history.pathTo(store.currentHistoryId).length}/${history.count}`;
});

/** 按住式临时查看：按下显示、松开（含拖出/失焦）恢复 */
function startHold(kind: 'original' | 'regions', event: PointerEvent): void {
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  if (kind === 'original') store.pressOriginal(true);
  else store.pressRegions(true);
}

function endHold(kind: 'original' | 'regions'): void {
  if (kind === 'original') store.pressOriginal(false);
  else store.pressRegions(false);
}
</script>

<template>
  <header class="top-toolbar">
    <div class="group">
      <el-tooltip content="图片库（Ctrl+O）：当前项目图片 / 导入 / 新建空白 / 其他项目" placement="bottom">
        <el-button :icon="FolderOpened" circle plain @click="store.openLibrary()" />
      </el-tooltip>
      <el-tooltip content="插入图片到当前画布（拖动定位、缩放后合入）" placement="bottom">
        <el-button
          :icon="Picture"
          circle
          plain
          :disabled="!store.hasImage"
          @click="store.openLibrary('insert')"
        />
      </el-tooltip>
      <el-tooltip content="当前项目：点击管理项目（重命名 / 切换 / 新建）" placement="bottom">
        <el-button class="project-btn" plain @click="store.openLibrary()">
          <el-icon><Collection /></el-icon>
          <span class="project-name">{{ store.activeProjectName }}</span>
        </el-button>
      </el-tooltip>
      <el-tooltip
        :content="
          store.dirty
            ? '保存项目（有未保存改动，Ctrl+S）：原图、结果与全部历史分支'
            : '保存项目（Ctrl+S）：原图、结果与全部历史分支'
        "
        placement="bottom"
      >
        <el-button
          :icon="Files"
          circle
          :type="store.dirty ? 'danger' : 'success'"
          :disabled="!store.hasImage || store.busy"
          @click="store.saveProject()"
        />
      </el-tooltip>
    </div>

    <div class="divider" />

    <div class="group">
      <el-tooltip content="撤销 (Ctrl+Z)" placement="bottom">
        <el-button
          :icon="RefreshLeft"
          circle
          plain
          :disabled="!store.canUndo || store.busy"
          @click="store.undo()"
        />
      </el-tooltip>
      <el-tooltip content="历史版本图（含分支）：点击节点可看大图并恢复" placement="bottom">
        <el-button
          circle
          plain
          :disabled="!store.hasImage"
          class="history-btn"
          @click="historyVisible = true"
        >
          <el-icon><Clock /></el-icon>
          <span class="history-pos">{{ historyPosition }}</span>
        </el-button>
      </el-tooltip>
      <el-tooltip content="重做 (Ctrl+Shift+Z)" placement="bottom">
        <el-button
          :icon="RefreshRight"
          circle
          plain
          :disabled="!store.canRedo || store.busy"
          @click="store.redo()"
        />
      </el-tooltip>
    </div>

    <div class="divider" />

    <div class="group">
      <el-tooltip content="按住查看原图，松开恢复编辑结果（不改变编辑状态、不产生历史节点）" placement="bottom">
        <el-button
          :icon="store.showOriginal ? Hide : View"
          circle
          plain
          :type="store.showOriginal ? 'primary' : 'default'"
          :disabled="!store.hasImage"
          @pointerdown="startHold('original', $event)"
          @pointerup="endHold('original')"
          @pointercancel="endHold('original')"
          @lostpointercapture="endHold('original')"
        />
      </el-tooltip>
      <el-tooltip
        content="按住显示所有区域（不同区域用不同颜色，固定的更实），松开恢复编辑视图"
        placement="bottom"
      >
        <el-button
          :icon="Grid"
          circle
          plain
          :type="store.showRegions ? 'primary' : 'default'"
          :disabled="!store.hasImage || store.regions.length === 0"
          @pointerdown="startHold('regions', $event)"
          @pointerup="endHold('regions')"
          @pointercancel="endHold('regions')"
          @lostpointercapture="endHold('regions')"
        />
      </el-tooltip>
      <el-tooltip content="适应窗口 (Ctrl+0)" placement="bottom">
        <el-button
          :icon="FullScreen"
          circle
          plain
          :disabled="!store.hasImage"
          @click="store.fitView()"
        />
      </el-tooltip>
      <el-tooltip content="100% 实际像素 (Ctrl+1)" placement="bottom">
        <el-button
          :icon="ScaleToOriginal"
          circle
          plain
          :disabled="!store.hasImage"
          @click="store.actualSize()"
        />
      </el-tooltip>
      <span class="zoom-label">{{ zoomPercent }}%</span>
    </div>

    <div class="spacer" />

    <div class="group">
      <el-button
        :icon="Download"
        plain
        :disabled="!store.hasImage || store.busy"
        @click="exportVisible = true"
      >
        导出图片
      </el-button>
    </div>

    <ExportDialog v-model="exportVisible" />
    <ImageLibraryDialog />

    <el-dialog
      v-model="historyVisible"
      title="历史版本图"
      width="820px"
      top="5vh"
      append-to-body
    >
      <HistoryPanel />
    </el-dialog>
  </header>
</template>

<style scoped>
.history-btn {
  width: auto;
  padding: 0 8px;
  min-width: 52px;
}

.history-pos {
  margin-left: 4px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.project-btn {
  width: auto;
  padding: 0 10px;
  max-width: 220px;
}

.project-name {
  margin-left: 6px;
  font-size: 13px;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
