<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useEditorStore } from '../stores/editor';

interface Row {
  index: number;
  label: string;
  kind: string;
  kindLabel: string;
  isCurrent: boolean;
  isFuture: boolean;
}

const store = useEditorStore();
const listRef = ref<HTMLDivElement | null>(null);

const kindLabels: Record<string, string> = {
  selection: '选区',
  edit: '图片',
  region_save: '区域',
  region_delete: '区域',
  region_lock: '区域',
};

const rows = computed<Row[]>(() => {
  const items = store.operationsView;
  const cursor = store.operationCursor;
  const list: Row[] = [
    {
      index: -1,
      label: '初始状态',
      kind: 'base',
      kindLabel: '',
      isCurrent: cursor === -1,
      isFuture: false,
    },
  ];
  items.forEach((item, i) => {
    list.push({
      index: i,
      label: item.label,
      kind: item.kind,
      kindLabel: kindLabels[item.kind] ?? '',
      isCurrent: i === cursor,
      isFuture: i > cursor,
    });
  });
  return list;
});

function jump(index: number): void {
  void store.jumpToOperation(index);
}

// 当前步骤变化时滚动到可见位置
watch(
  () => store.operationCursor,
  async () => {
    await nextTick();
    listRef.value?.querySelector('.op-item.current')?.scrollIntoView({ block: 'nearest' });
  },
);
</script>

<template>
  <div class="op-panel">
    <p class="op-hint">
      与 Ctrl+Z / Ctrl+Y 为同一份操作历史：点击任意步骤回退/前进；撤销后再执行新操作会截断其后的步骤。
      此历史仅在本次会话有效（图片成果仍由版本树持久化）。
    </p>
    <div ref="listRef" class="op-list">
      <div
        v-for="row in rows"
        :key="row.index"
        class="op-item"
        :class="{ current: row.isCurrent, future: row.isFuture, base: row.kind === 'base' }"
        :title="row.label"
        @click="jump(row.index)"
      >
        <span class="op-dot" :class="`kind-${row.kind}`" />
        <span class="op-label">{{ row.label }}</span>
        <span v-if="row.kindLabel" class="op-tag">{{ row.kindLabel }}</span>
        <span v-if="row.isCurrent" class="op-current-tag">当前</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.op-panel {
  display: flex;
  flex-direction: column;
}

.op-hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: #8a8a94;
  line-height: 1.5;
}

.op-list {
  max-height: 56vh;
  overflow-y: auto;
  border: 1px solid #35353b;
  border-radius: 8px;
  background: #1b1b1f;
  padding: 4px;
}

.op-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  min-width: 0;
}

.op-item:hover {
  background: #2e2e35;
}

.op-item.current {
  background: #2b3f63;
  outline: 1px solid #3b82f6;
}

.op-item.future {
  opacity: 0.45;
}

.op-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: #6f6f78;
}

.op-dot.kind-selection {
  background: #00b8d4;
}

.op-dot.kind-edit {
  background: #ff8a3c;
}

.op-dot.kind-region_save,
.op-dot.kind-region_delete,
.op-dot.kind-region_lock {
  background: #34c759;
}

.op-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: #e2e2e8;
}

.op-tag {
  flex: none;
  font-size: 11px;
  color: #9aa0ab;
  border: 1px solid #3a3a40;
  border-radius: 4px;
  padding: 0 5px;
}

.op-current-tag {
  flex: none;
  font-size: 11px;
  color: #7db4ff;
}
</style>
