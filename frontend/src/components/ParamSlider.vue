<script setup lang="ts">
/**
 * 参数滑杆 + 可输入数值：拖动不便精确定位时可直接输入数字。
 * 输入自动取整并限制在 [min, max]（与各参数的消费方约束一致）。
 */

const props = defineProps<{
  modelValue: number;
  label: string;
  min: number;
  max: number;
  unit?: string;
  disabled?: boolean;
  /** 是否在标签处显示取值范围提示（默认显示；百分比类参数可关闭） */
  showRange?: boolean;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', value: number): void }>();

function commit(value: number | null | undefined): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  const clamped = Math.min(props.max, Math.max(props.min, Math.round(value)));
  if (clamped !== props.modelValue) emit('update:modelValue', clamped);
}
</script>

<template>
  <div class="param-slider">
    <div class="param-head">
      <span class="param-label">
        {{ label }}
        <span v-if="showRange !== false" class="param-range">（{{ min }}~{{ max }}）</span>
      </span>
      <span class="param-input-wrap">
        <el-input-number
          :model-value="modelValue"
          :min="min"
          :max="max"
          :step="1"
          :disabled="disabled"
          size="small"
          controls-position="right"
          class="param-input"
          @update:model-value="commit"
        />
        <span v-if="unit" class="param-unit">{{ unit }}</span>
      </span>
    </div>
    <el-slider
      :model-value="modelValue"
      :min="min"
      :max="max"
      :disabled="disabled"
      size="small"
      @update:model-value="commit"
    />
  </div>
</template>

