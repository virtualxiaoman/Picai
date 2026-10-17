<script setup lang="ts">
import { useEditorStore } from '../stores/editor';
import type { ToolId } from '../types';

interface ToolDef {
  id: ToolId;
  label: string;
  tooltip: string;
  /** 未实现的阶段（显示为禁用并注明原因） */
  phase?: number;
  svg: string;
}

const store = useEditorStore();

const tools: ToolDef[] = [
  {
    id: 'brush-circle',
    label: '圆形画笔',
    tooltip: '圆形画笔：涂抹增加选区；Ctrl/Shift 加选、Alt 减选',
    svg: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/>',
  },
  {
    id: 'brush-square',
    label: '方形画笔',
    tooltip: '方形画笔：涂抹增加选区；Ctrl/Shift 加选、Alt 减选',
    svg: '<rect x="4.5" y="4.5" width="15" height="15" rx="1" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="10" y="10" width="4" height="4" fill="currentColor"/>',
  },
  {
    id: 'brush-eraser',
    label: '橡皮擦',
    tooltip: '橡皮擦：从选区中擦除（只减不增）；[ ] 调整尺寸',
    svg: '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6.8 17.2L17.2 6.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  },
  {
    id: 'marquee-rect',
    label: '矩形选区',
    tooltip: '矩形选区：拖动创建矩形选区',
    svg: '<rect x="4" y="6.5" width="16" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 2.5"/>',
  },
  {
    id: 'marquee-ellipse',
    label: '椭圆选区',
    tooltip: '椭圆选区：拖动创建椭圆选区',
    svg: '<ellipse cx="12" cy="12" rx="8" ry="6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 2.5"/>',
  },
  {
    id: 'ai-remove-bg',
    label: '自动抠图',
    tooltip: '自动抠图（BiRefNet）：一键生成前景蒙版，可反选为背景',
    svg: '<path d="M12 3.6l1.7 5.1 5.1 1.7-5.1 1.7-1.7 5.1-1.7-5.1-5.1-1.7 5.1-1.7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="18.4" cy="17.2" r="1.7" fill="currentColor"/>',
  },
  {
    id: 'ai-object',
    label: '自动对象选择',
    tooltip: '自动对象选择（SAM 3）：输入对象描述自动分割',
    svg: '<circle cx="10.5" cy="10.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15 15l4.6 4.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M18.6 3.4l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" fill="currentColor"/>',
  },
  {
    id: 'ai-point',
    label: '点选 / 框选',
    tooltip: '点选 / 框选交互式分割（SAM 3 Tracker）',
    svg: '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  },
  {
    id: 'magic-wand',
    label: '颜色选择',
    tooltip: '颜色选择 / 魔棒：按颜色相似度选择区域（连续或非连续）',
    svg: '<path d="M5 19.5L14.5 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M13.2 8.8l2-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M17.6 3.2l.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9z" fill="currentColor"/>',
  },
];

function selectTool(tool: ToolDef): void {
  if (tool.phase) return;
  store.activeTool = tool.id;
}
</script>

<template>
  <div class="left-toolbar">
    <el-tooltip
      v-for="tool in tools"
      :key="tool.id"
      :content="tool.phase ? `${tool.label}——将在阶段${tool.phase}实现（模型不可用时会有明确提示）` : tool.tooltip"
      placement="right"
      :show-after="300"
    >
      <button
        class="tool-btn"
        :class="{ active: store.activeTool === tool.id, disabled: !!tool.phase }"
        @click="selectTool(tool)"
      >
        <!-- 注意：必须在 SVG 命名空间下通过 v-html 注入路径片段，
             否则 circle/rect/path 会被 HTML 解析器当作未知元素而不渲染 -->
        <svg class="tool-icon" viewBox="0 0 24 24" fill="none" v-html="tool.svg" />
      </button>
    </el-tooltip>

    <div class="tool-sep" />
  </div>
</template>
