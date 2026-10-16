<script setup lang="ts">
import { ref } from 'vue';
import TopToolbar from './TopToolbar.vue';
import LeftToolbar from './LeftToolbar.vue';
import ImageViewport from './ImageViewport.vue';
import RightPanel from './RightPanel.vue';
import StatusBar from './StatusBar.vue';

const leftCollapsed = ref(false);
const rightCollapsed = ref(false);
</script>

<template>
  <div class="app-shell">
    <TopToolbar />
    <div class="app-body">
      <aside class="side-bar left">
        <LeftToolbar v-show="!leftCollapsed" />
        <button
          class="collapse-btn"
          :title="leftCollapsed ? '展开工具栏' : '收起工具栏'"
          @click="leftCollapsed = !leftCollapsed"
        >
          {{ leftCollapsed ? '›' : '‹' }}
        </button>
      </aside>
      <main class="canvas-area">
        <ImageViewport />
      </main>
      <aside class="side-bar right">
        <button
          class="collapse-btn"
          :title="rightCollapsed ? '展开属性面板' : '收起属性面板'"
          @click="rightCollapsed = !rightCollapsed"
        >
          {{ rightCollapsed ? '‹' : '›' }}
        </button>
        <RightPanel v-show="!rightCollapsed" />
      </aside>
    </div>
    <StatusBar />
  </div>
</template>
