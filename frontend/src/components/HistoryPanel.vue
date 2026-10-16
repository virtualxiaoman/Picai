<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useEditorStore } from '../stores/editor';
import type { HistoryNode } from '../core/HistoryManager';

interface GraphNode {
  id: number;
  node: HistoryNode;
  x: number;
  y: number;
  label: string;
  time: string;
  thumb: string | null;
  isCurrent: boolean;
  isBranch: boolean;
}

interface GraphData {
  nodes: GraphNode[];
  edges: string[];
  width: number;
  height: number;
}

const NODE_W = 92;
const NODE_H = 112;
const GAP_X = 38;
const GAP_Y = 16;

const store = useEditorStore();
const thumbUrls = new Map<number, string>();
const previewNode = ref<HistoryNode | null>(null);
const previewUrl = ref('');
const previewVisible = ref(false);

function thumbUrl(node: HistoryNode): string | null {
  if (!node.thumbBlob) return null;
  let url = thumbUrls.get(node.id);
  if (!url) {
    url = URL.createObjectURL(node.thumbBlob);
    thumbUrls.set(node.id, url);
  }
  return url;
}

/** 水平版本图布局：从左到右按深度排列，叶子节点占行，父节点居中于子节点 */
const graph = computed<GraphData>(() => {
  void store.historyVersion;
  const history = store.getHistory();
  if (!history || !store.hasImage) return { nodes: [], edges: [], width: 0, height: 0 };
  let nextRow = 0;
  const rowOf = new Map<number, number>();
  const colOf = new Map<number, number>();
  const place = (node: HistoryNode, col: number): number => {
    colOf.set(node.id, col);
    const children = history.children(node.id);
    if (children.length === 0) {
      const row = nextRow++;
      rowOf.set(node.id, row);
      return row;
    }
    const rows = children.map((child) => place(child, col + 1));
    const row = (rows[0] + rows[rows.length - 1]) / 2;
    rowOf.set(node.id, row);
    return row;
  };
  const root = history.allNodes().find((n) => n.parentId == null);
  if (!root) return { nodes: [], edges: [], width: 0, height: 0 };
  place(root, 0);

  const nodes: GraphNode[] = [];
  const edges: string[] = [];
  let maxCol = 0;
  const rowCount = Math.max(1, nextRow);
  for (const node of history.allNodes()) {
    const col = colOf.get(node.id) ?? 0;
    const row = rowOf.get(node.id) ?? 0;
    maxCol = Math.max(maxCol, col);
    const x = col * (NODE_W + GAP_X);
    const y = row * (NODE_H + GAP_Y);
    nodes.push({
      id: node.id,
      node,
      x,
      y,
      label: node.label,
      time: new Date(node.time).toLocaleTimeString('zh-CN', { hour12: false }),
      thumb: thumbUrl(node),
      isCurrent: node.id === store.currentHistoryId,
      isBranch: node.childIds.length > 1,
    });
    for (const childId of node.childIds) {
      const childRow = rowOf.get(childId);
      if (childRow == null) continue;
      const x1 = x + NODE_W;
      const y1 = y + NODE_H / 2;
      const x2 = (col + 1) * (NODE_W + GAP_X);
      const y2 = childRow * (NODE_H + GAP_Y) + NODE_H / 2;
      edges.push(
        `M ${x1} ${y1} C ${x1 + GAP_X / 2} ${y1}, ${x2 - GAP_X / 2} ${y2}, ${x2} ${y2}`,
      );
    }
  }
  return {
    nodes,
    edges,
    width: (maxCol + 1) * NODE_W + maxCol * GAP_X,
    height: rowCount * NODE_H + (rowCount - 1) * GAP_Y,
  };
});

function openPreview(node: HistoryNode): void {
  if (!node.imageBlob) {
    ElMessage.warning('该历史节点没有图像快照');
    return;
  }
  closePreviewUrl();
  previewUrl.value = URL.createObjectURL(node.imageBlob);
  previewNode.value = node;
  previewVisible.value = true;
}

function closePreviewUrl(): void {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = '';
  }
}

/** 对话框完全关闭后清理 */
function closePreview(): void {
  closePreviewUrl();
  previewNode.value = null;
}

function restoreFromPreview(): void {
  if (previewNode.value) void store.jumpToHistory(previewNode.value.id);
  previewVisible.value = false;
}

onBeforeUnmount(() => {
  closePreviewUrl();
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
});
</script>

<template>
  <div class="history-panel">
    <p class="history-hint">
      水平版本图（从左到右）：同一父节点分出的多条线即为分支；点击节点查看大图并恢复该版本。
    </p>
    <div v-if="graph.nodes.length > 0" class="history-scroll">
      <div class="history-graph" :style="{ width: `${graph.width}px`, height: `${graph.height}px` }">
        <svg class="history-edges" :width="graph.width" :height="graph.height">
          <path v-for="(edge, i) in graph.edges" :key="i" :d="edge" />
        </svg>
        <div
          v-for="item in graph.nodes"
          :key="item.id"
          class="history-card"
          :class="{ current: item.isCurrent }"
          :style="{ left: `${item.x}px`, top: `${item.y}px`, width: `${NODE_W}px` }"
          :title="`${item.label} ${item.time}`"
          @click="openPreview(item.node)"
        >
          <img v-if="item.thumb" class="history-thumb" :src="item.thumb" alt="" />
          <div v-else class="history-thumb placeholder" />
          <div class="history-label">
            {{ item.label }}
            <span v-if="item.isBranch" class="history-branch" title="此节点有多个后续分支">⑂</span>
          </div>
          <div class="history-time">{{ item.time }}</div>
        </div>
      </div>
    </div>
    <p v-else class="history-hint">暂无历史节点</p>
    <p class="history-hint">
      未保存改动：{{ store.dirty ? '有（记得点击「保存项目」）' : '无' }}
      <template v-if="store.savedAt">
        · 上次保存 {{ new Date(store.savedAt).toLocaleTimeString('zh-CN', { hour12: false }) }}
      </template>
    </p>

    <el-dialog
      v-model="previewVisible"
      :title="previewNode ? `历史版本：${previewNode.label}` : ''"
      width="fit-content"
      class="history-preview-dialog"
      append-to-body
      @closed="closePreview"
    >
      <div class="history-preview">
        <img v-if="previewUrl" :src="previewUrl" alt="历史版本预览" />
        <p v-if="previewNode" class="history-preview-meta">
          {{ new Date(previewNode.time).toLocaleString('zh-CN') }} ·
          {{ previewNode.id === store.currentHistoryId ? '当前版本' : '非当前版本' }}
        </p>
      </div>
      <template #footer>
        <el-button @click="previewVisible = false">关闭</el-button>
        <el-button
          type="primary"
          :disabled="!previewNode || previewNode.id === store.currentHistoryId || store.busy"
          @click="restoreFromPreview"
        >
          恢复此版本
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.history-panel {
  display: flex;
  flex-direction: column;
}

.history-hint {
  margin: 4px 0 8px;
  font-size: 12px;
  color: #8a8a94;
  line-height: 1.5;
}

.history-scroll {
  overflow: auto;
  max-height: 58vh;
  border: 1px solid #35353b;
  border-radius: 8px;
  background: #1b1b1f;
}

.history-graph {
  position: relative;
}

.history-edges {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
}

.history-edges path {
  fill: none;
  stroke: #55555f;
  stroke-width: 2;
}

.history-card {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 4px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  text-align: center;
}

.history-card:hover {
  background: #2e2e35;
}

.history-card.current {
  background: #2b3f63;
  border-color: #3b82f6;
}

.history-thumb {
  width: 72px;
  height: 72px;
  object-fit: contain;
  border-radius: 4px;
  background: #141416;
}

.history-thumb.placeholder {
  background: #26262b;
}

.history-label {
  font-size: 12px;
  color: #e2e2e8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.history-branch {
  color: #d9b45a;
}

.history-time {
  font-size: 10px;
  color: #8a8a94;
}

.history-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.history-preview img {
  max-width: 72vw;
  max-height: 62vh;
  object-fit: contain;
  border-radius: 6px;
  background: #1b1b1f;
}

.history-preview-meta {
  margin: 0;
  font-size: 12px;
  color: #8a8a94;
}
</style>
