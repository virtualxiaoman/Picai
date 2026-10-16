<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import AppLayout from './components/AppLayout.vue';
import { useEditorStore } from './stores/editor';

const store = useEditorStore();
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp'];

function importFile(file: File): void {
  if (ACCEPT.includes(file.type)) void store.importImage(file, file.name);
  else ElMessage.warning('仅支持 PNG / JPEG / WebP 图片');
}

function onPaste(event: ClipboardEvent): void {
  const items = event.clipboardData?.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          importFile(file);
          return;
        }
      }
    }
  }
  const files = event.clipboardData?.files;
  if (files && files.length > 0 && files[0].type.startsWith('image/')) {
    event.preventDefault();
    importFile(files[0]);
  }
}

function onGlobalKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  ) {
    return;
  }
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (ctrl && key === 'z' && !event.shiftKey) {
    event.preventDefault();
    void store.undo();
  } else if (ctrl && (key === 'y' || (key === 'z' && event.shiftKey))) {
    event.preventDefault();
    void store.redo();
  } else if (ctrl && key === 'o') {
    event.preventDefault();
    store.openLibrary();
  } else if (ctrl && event.key === '0') {
    event.preventDefault();
    store.fitView();
  } else if (ctrl && event.key === '1') {
    event.preventDefault();
    store.actualSize();
  } else if (ctrl && key === 'a') {
    event.preventDefault();
    store.selectAll();
  } else if (ctrl && key === 'd') {
    event.preventDefault();
    store.clearSelection();
  } else if (ctrl && key === 'i') {
    event.preventDefault();
    store.invertSelection();
  } else if (ctrl && key === 's') {
    event.preventDefault();
    void store.saveProject();
  }
}

// 阻止浏览器直接打开拖入窗口的图片（画布内的拖放由 ImageViewport 处理）
function preventWindowDrop(event: DragEvent): void {
  event.preventDefault();
}

// 有未保存改动时离开页面给出浏览器原生提醒
function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (store.dirty) event.preventDefault();
}

onMounted(() => {
  document.addEventListener('paste', onPaste);
  window.addEventListener('keydown', onGlobalKey);
  window.addEventListener('dragover', preventWindowDrop);
  window.addEventListener('drop', preventWindowDrop);
  window.addEventListener('beforeunload', onBeforeUnload);
  // 启动：先尝试迁移浏览器旧存储到 data/history，再自动恢复最近打开的项目
  void store.initializeStorage();
});

onBeforeUnmount(() => {
  document.removeEventListener('paste', onPaste);
  window.removeEventListener('keydown', onGlobalKey);
  window.removeEventListener('dragover', preventWindowDrop);
  window.removeEventListener('drop', preventWindowDrop);
  window.removeEventListener('beforeunload', onBeforeUnload);
});
</script>

<template>
  <AppLayout />
</template>
