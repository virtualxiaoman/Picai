<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Loading, ZoomIn, ZoomOut } from '@element-plus/icons-vue';
import { useEditorStore } from '../stores/editor';
import { getDeviceInfo } from '../api/client';
import type { DeviceInfo } from '../types';

const store = useEditorStore();
const device = ref<DeviceInfo | null>(null);
const deviceError = ref('');

onMounted(async () => {
  try {
    device.value = await getDeviceInfo();
  } catch {
    deviceError.value = '后端未启动（AI 功能不可用）';
  }
  void store.refreshStorageEstimate();
});

const deviceText = computed(() => {
  if (device.value) {
    if (device.value.cuda_available) return `GPU 就绪：${device.value.device_name}`;
    if (device.value.torch_installed) return 'CUDA 不可用（将使用 CPU 推理）';
    return 'PyTorch 未安装（AI 功能不可用）';
  }
  return deviceError.value || '正在检测推理设备…';
});

const deviceOk = computed(() => !!device.value?.cuda_available);
const zoomPercent = computed(() => Math.round(store.viewScale * 100));

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

const storageText = computed(() => {
  if (!store.storageUsage) return '';
  return `存储占用 ${formatBytes(store.storageUsage.usage)}`;
});
</script>

<template>
  <footer class="status-bar">
    <span class="item">
      {{
        store.hasImage
          ? `${store.imageWidth} × ${store.imageHeight} px`
          : '未打开图片'
      }}
    </span>
    <span v-if="store.hasImage && store.cursorInImage" class="item">
      坐标 {{ store.cursorX }}, {{ store.cursorY }} px
    </span>

    <span class="spacer" />

    <span v-if="store.busy" class="item busy">
      <el-icon class="is-loading"><Loading /></el-icon>
      {{ store.busyText }}
      <template v-if="store.aiTask">（{{ Math.round(store.aiTask.progress * 100) }}%）</template>
      <el-button
        v-if="store.aiTask"
        size="small"
        text
        type="warning"
        @click="store.cancelAiTask()"
      >
        取消任务
      </el-button>
    </span>
    <span v-if="store.dirty" class="item" style="color: #d9b45a" title="有未保存的改动">
      ● 未保存
    </span>
    <span v-if="storageText" class="item" :title="'浏览器存储用量（快照与项目数据）'">
      {{ storageText }}
    </span>
    <span class="item" :style="{ color: deviceOk ? '#7dd3a0' : '#d9b45a' }">{{ deviceText }}</span>

    <el-button-group size="small">
      <el-button
        :icon="ZoomOut"
        :disabled="!store.hasImage"
        title="缩小"
        @click="store.zoomStep(-1)"
      />
      <el-button :disabled="!store.hasImage" title="100% 实际像素" @click="store.actualSize()">
        {{ zoomPercent }}%
      </el-button>
      <el-button :icon="ZoomIn" :disabled="!store.hasImage" title="放大" @click="store.zoomStep(1)" />
    </el-button-group>
    <el-button size="small" :disabled="!store.hasImage" @click="store.fitView()">适应窗口</el-button>
    <el-button size="small" :disabled="!store.hasImage" @click="store.centerView()">居中</el-button>
  </footer>
</template>
