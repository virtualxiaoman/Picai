/** 后端 API 客户端（开发期经 Vite 代理到 127.0.0.1:8000） */

import type { DeviceInfo } from '../types';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = (await res.json()) as { detail?: string };
      if (data.detail) detail = data.detail;
    } catch {
      /* 非 JSON 响应体 */
    }
    throw new Error(detail || `请求失败：HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function getHealth(): Promise<{ status: string; app: string; version: string }> {
  return request('/health');
}

export function getDeviceInfo(): Promise<DeviceInfo> {
  return request('/device');
}

// ---------- AI 分割 ----------

export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface TaskState {
  id: string;
  name: string;
  status: TaskStatus;
  progress: number;
  message: string;
  error: string;
  has_result: boolean;
}

export interface ModelStatus {
  name: string;
  title: string;
  model_id: string;
  loaded: boolean;
  available: boolean;
  note: string;
  last_error: string;
}

export interface ModelsStatus {
  device: string;
  models: ModelStatus[];
}

function imageForm(image: Blob, extra?: Record<string, string>): FormData {
  const form = new FormData();
  form.append('image', image, 'image.png');
  if (extra) {
    for (const [key, value] of Object.entries(extra)) form.append(key, value);
  }
  return form;
}

export function requestRemoveBackground(image: Blob): Promise<TaskState> {
  return request('/segmentation/remove-background', { method: 'POST', body: imageForm(image) });
}

export function requestTextSegment(image: Blob, prompt: string): Promise<TaskState> {
  return request('/segmentation/text', {
    method: 'POST',
    body: imageForm(image, { prompt }),
  });
}

export function requestPointSegment(
  image: Blob,
  points: [number, number][],
  labels: number[],
  box: [number, number, number, number] | null,
): Promise<TaskState> {
  return request('/segmentation/points', {
    method: 'POST',
    body: imageForm(image, {
      points: JSON.stringify(points),
      labels: JSON.stringify(labels),
      ...(box ? { box: JSON.stringify(box) } : {}),
    }),
  });
}

export function getTask(taskId: string): Promise<TaskState> {
  return request(`/tasks/${taskId}`);
}

export function cancelTask(taskId: string): Promise<TaskState> {
  return request(`/tasks/${taskId}`, { method: 'DELETE' });
}

export async function fetchTaskResult(taskId: string): Promise<Blob> {
  const res = await fetch(`${BASE}/tasks/${taskId}/result`);
  if (!res.ok) throw new Error(`获取蒙版结果失败：HTTP ${res.status}`);
  return res.blob();
}

export function getModelsStatus(): Promise<ModelsStatus> {
  return request('/models/status');
}

// ---------- AI 修复（openlux，图片会上传至云端） ----------

export function requestAiRepair(image: Blob, prompt: string): Promise<TaskState> {
  return request('/ai/repair', {
    method: 'POST',
    body: imageForm(image, { prompt }),
  });
}

export interface AiStatus {
  configured: boolean;
  key_file: string;
  message: string;
}

export function getAiStatus(): Promise<AiStatus> {
  return request('/ai/status');
}

// ---------- 图像编辑（后端整图操作） ----------

export function requestNeighborhoodFill(
  image: Blob,
  mask: Blob,
  radius: number,
): Promise<TaskState> {
  const form = new FormData();
  form.append('image', image, 'image.png');
  form.append('mask', mask, 'mask.png');
  form.append('radius', String(radius));
  return request('/edit/neighborhood-fill', { method: 'POST', body: form });
}
