<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import { useEditorStore, type ProjectImage } from '../stores/editor';
import { projectStorage, type ImageRow, type ProjectRow } from '../core/ProjectStorage';

const store = useEditorStore();

const visible = computed({
  get: () => store.libraryVisible,
  set: (value: boolean) => {
    store.libraryVisible = value;
  },
});
const mode = computed(() => store.libraryMode);

const otherData = ref<{ project: ProjectRow; images: ImageRow[] }[]>([]);
const loadingOthers = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const thumbUrls = new Map<string, string>();

// 空白图片表单
const blankVisible = ref(false);
const blankWidth = ref(1920);
const blankHeight = ref(1080);
const blankBg = ref<'transparent' | '#ffffff' | 'custom'>('transparent');
const blankCustomColor = ref('#dddddd');

async function refresh(): Promise<void> {
  try {
    store.projects = await projectStorage.listProjects();
  } catch {
    /* 存储不可用时保持现有列表 */
  }
  loadingOthers.value = true;
  try {
    const others = store.projects.filter((p) => p.id !== store.activeProjectId);
    const data: { project: ProjectRow; images: ImageRow[] }[] = [];
    for (const project of others) {
      data.push({ project, images: await projectStorage.listImages(project.id) });
    }
    otherData.value = data;
  } catch (err) {
    ElMessage.error(`读取其他项目失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    loadingOthers.value = false;
  }
}

function cleanupUrls(): void {
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
}

watch(visible, (value) => {
  if (value) {
    cleanupUrls();
    void refresh();
  }
});

function thumbUrlFor(key: string, blob: Blob | null): string | null {
  if (!blob) return null;
  let url = thumbUrls.get(key);
  if (!url) {
    url = URL.createObjectURL(blob);
    thumbUrls.set(key, url);
  }
  return url;
}

async function onPickCurrent(img: ProjectImage): Promise<void> {
  if (mode.value === 'insert') {
    await store.startInsertFromImage(store.activeProjectId!, img.id);
  } else {
    await store.switchImage(img.id);
  }
}

async function onPickOther(projectId: string, row: ImageRow): Promise<void> {
  if (mode.value === 'insert') {
    await store.startInsertFromImage(projectId, row.id);
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将「${row.name}」的当前编辑结果复制到当前项目并打开？（各项目数据保持独立）`,
      '跨项目使用图片',
      { confirmButtonText: '复制并打开', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  await store.copyImageFromOtherProject(projectId, row.id);
}

function openFilePick(): void {
  fileInput.value?.click();
}

async function onFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  for (const file of files) {
    if (['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      await store.importImage(file, file.name);
    } else {
      ElMessage.warning(`跳过不支持的格式：${file.name}`);
    }
  }
  // 多选导入全部完成后关闭对话框（最后导入的图片保持打开）
  if (files.length > 0) store.libraryVisible = false;
}

async function createBlank(): Promise<void> {
  const background =
    blankBg.value === 'transparent'
      ? 'transparent'
      : blankBg.value === 'custom'
        ? blankCustomColor.value
        : blankBg.value;
  await store.createBlankImage(blankWidth.value, blankHeight.value, background);
  blankVisible.value = false;
}

async function doRename(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('输入新的项目名称', '重命名项目', {
      inputValue: store.activeProjectName,
      confirmButtonText: '确定',
      cancelButtonText: '取消',
    });
    store.renameProject(value ?? '');
  } catch {
    /* 取消 */
  }
}

async function doNewProject(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('输入新项目名称', '新建项目', {
      inputPlaceholder: '未命名项目',
      confirmButtonText: '创建',
      cancelButtonText: '取消',
    });
    store.createProject(value ?? '');
  } catch {
    /* 取消 */
  }
}

onBeforeUnmount(cleanupUrls);
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="mode === 'insert' ? '插入图片到当前画布（优先当前项目）' : '图片库'"
    width="880px"
    top="5vh"
    append-to-body
  >
    <div class="lib-project-row">
      <span class="lib-label">项目</span>
      <el-select
        :model-value="store.activeProjectId ?? ''"
        style="width: 200px"
        @change="(value: string) => void store.switchProject(value)"
      >
        <el-option v-for="p in store.projects" :key="p.id" :label="p.name" :value="p.id" />
      </el-select>
      <el-button size="small" @click="doRename">重命名</el-button>
      <el-button size="small" @click="doNewProject">新建项目</el-button>
      <span class="lib-spacer" />
      <span class="lib-hint">
        {{
          mode === 'insert'
            ? '点击任意图片将其插入当前画布（其他项目的图片直接使用，不复制）'
            : '其他项目的图片将复制当前编辑结果到当前项目后打开；粘贴（Ctrl+V）可直接导入'
        }}
      </span>
    </div>

    <h4 class="lib-section-title">
      当前项目「{{ store.activeProjectName }}」的图片（{{ store.projectImages.length }}）
    </h4>
    <div class="lib-grid">
      <div
        v-for="img in store.projectImages"
        :key="img.id"
        class="lib-card"
        :class="{ active: img.id === store.activeImageId }"
        :title="img.name"
        @click="void onPickCurrent(img)"
      >
        <img v-if="thumbUrlFor(`c-${img.id}`, img.thumbBlob)" :src="thumbUrlFor(`c-${img.id}`, img.thumbBlob)!" alt="" />
        <div v-else class="lib-thumb-empty" />
        <div class="lib-name">{{ img.name }}</div>
        <div class="lib-meta">
          {{ img.width }}×{{ img.height }}<template v-if="img.originNote"> · {{ img.originNote }}</template>
        </div>
        <div v-if="img.id === store.activeImageId" class="lib-badge">当前</div>
      </div>
      <div class="lib-card lib-add" @click="openFilePick">
        <el-icon :size="26"><Plus /></el-icon>
        <div class="lib-add-hint">导入 / 粘贴新增</div>
      </div>
    </div>
    <p v-if="store.projectImages.length === 0" class="lib-hint">
      当前项目还没有图片：导入图片、粘贴（Ctrl+V）或新建空白图片开始编辑。
    </p>

    <div class="lib-actions-row">
      <el-button size="small" @click="openFilePick">导入图片文件（可多选）</el-button>
      <el-button size="small" @click="blankVisible = true">新建空白图片…</el-button>
    </div>

    <template v-if="otherData.length > 0">
      <h4 class="lib-section-title">
        其他项目（{{ mode === 'insert' ? '点击直接插入' : '点击复制到当前项目' }}）
      </h4>
      <el-collapse>
        <el-collapse-item
          v-for="item in otherData"
          :key="item.project.id"
          :title="`${item.project.name}（${item.images.length} 张）`"
          :name="item.project.id"
        >
          <div v-if="item.images.length > 0" class="lib-grid">
            <div
              v-for="row in item.images"
              :key="row.id"
              class="lib-card"
              :title="row.name"
              @click="void onPickOther(item.project.id, row)"
            >
              <img v-if="thumbUrlFor(row.id, row.thumbBlob)" :src="thumbUrlFor(row.id, row.thumbBlob)!" alt="" />
              <div v-else class="lib-thumb-empty" />
              <div class="lib-name">{{ row.name }}</div>
              <div class="lib-meta">{{ row.width }}×{{ row.height }}</div>
            </div>
          </div>
          <p v-else class="lib-hint">该项目暂无图片</p>
        </el-collapse-item>
      </el-collapse>
    </template>
    <p v-else-if="loadingOthers" class="lib-hint">正在读取其他项目…</p>

    <input
      ref="fileInput"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      multiple
      hidden
      @change="onFiles"
    />

    <el-dialog v-model="blankVisible" title="新建空白图片" width="400px" append-to-body>
      <el-form label-width="70px">
        <el-form-item label="宽度">
          <el-input-number v-model="blankWidth" :min="1" :max="16384" />
        </el-form-item>
        <el-form-item label="高度">
          <el-input-number v-model="blankHeight" :min="1" :max="16384" />
        </el-form-item>
        <el-form-item label="背景">
          <el-radio-group v-model="blankBg">
            <el-radio-button value="transparent">透明</el-radio-button>
            <el-radio-button value="#ffffff">白色</el-radio-button>
            <el-radio-button value="custom">自定义</el-radio-button>
          </el-radio-group>
          <el-color-picker v-if="blankBg === 'custom'" v-model="blankCustomColor" style="margin-left: 8px" />
        </el-form-item>
      </el-form>
      <p class="lib-hint">空白图片创建后会加入当前项目，可用于插入/合成其他图片。</p>
      <template #footer>
        <el-button @click="blankVisible = false">取消</el-button>
        <el-button type="primary" :loading="store.busy" @click="createBlank">创建并打开</el-button>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<style scoped>
.lib-project-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.lib-label {
  font-size: 13px;
  color: #a9a9b4;
}

.lib-spacer {
  flex: 1;
}

.lib-hint {
  font-size: 12px;
  color: #8a8a94;
  line-height: 1.5;
  margin: 4px 0;
}

.lib-section-title {
  margin: 10px 0 8px;
  font-size: 13px;
  color: #d6d6de;
}

.lib-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}

.lib-card {
  position: relative;
  border: 1px solid #35353b;
  border-radius: 8px;
  padding: 8px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  background: #26262b;
}

.lib-card:hover {
  border-color: #3b82f6;
}

.lib-card.active {
  border-color: #3b82f6;
  background: #2b3f63;
}

.lib-card img {
  width: 100%;
  height: 90px;
  object-fit: contain;
  border-radius: 4px;
  background: #141416;
}

.lib-thumb-empty {
  width: 100%;
  height: 90px;
  border-radius: 4px;
  background: #141416;
}

.lib-name {
  font-size: 12px;
  color: #e2e2e8;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lib-meta {
  font-size: 11px;
  color: #8a8a94;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lib-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  font-size: 11px;
  color: #7db4ff;
  background: rgba(27, 27, 31, 0.8);
  border-radius: 4px;
  padding: 0 4px;
}

.lib-add {
  justify-content: center;
  min-height: 130px;
  color: #9aa0ab;
  border-style: dashed;
}

.lib-add-hint {
  font-size: 12px;
}

.lib-actions-row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
</style>
