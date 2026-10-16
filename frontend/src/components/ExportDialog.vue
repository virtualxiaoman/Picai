<script setup lang="ts">
import { computed } from 'vue';
import { useEditorStore } from '../stores/editor';
import ParamSlider from './ParamSlider.vue';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>();

const store = useEditorStore();

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

const isPng = computed(() => store.exportFormat === 'png');

async function doExport(): Promise<void> {
  // 导出选项（格式/质量/铺底色）跨项目记忆，存于偏好
  await store.exportImage(store.exportFormat, store.exportBackground, store.exportQuality / 100);
  visible.value = false;
}
</script>

<template>
  <el-dialog v-model="visible" title="导出图片" width="460px" append-to-body>
    <el-form label-width="96px">
      <el-form-item label="格式">
        <el-radio-group v-model="store.exportFormat">
          <el-radio-button value="png">PNG</el-radio-button>
          <el-radio-button value="jpeg">JPEG</el-radio-button>
          <el-radio-button value="webp">WebP</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <el-form-item v-if="!isPng" label="质量">
        <ParamSlider v-model="store.exportQuality" label="编码质量" unit="%" :min="50" :max="100" />
      </el-form-item>

      <el-form-item v-if="!isPng" label="透明铺底">
        <el-color-picker v-model="store.exportBackground" :predefine="['#ffffff', '#000000', '#808080']" />
        <span class="hint-inline">{{ store.exportFormat.toUpperCase() }} 不支持透明度，透明区域将以此颜色铺底</span>
      </el-form-item>

      <el-form-item v-else label="透明度">
        <span class="hint-inline">PNG 保留透明通道（透明区域显示为棋盘格）</span>
      </el-form-item>

      <el-form-item label="导出尺寸">
        <span>{{ store.imageWidth }} × {{ store.imageHeight }} px（与原始分辨率一致）</span>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="store.busy" @click="doExport">导出</el-button>
    </template>
  </el-dialog>
</template>
