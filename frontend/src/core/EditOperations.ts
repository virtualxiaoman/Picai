/**
 * 编辑操作：把全分辨率像素运算派发到 Web Worker，避免阻塞界面。
 */

import type { MaskOpKind, PixelOp } from '../types';

interface PendingEntry {
  resolve: (buffer: ArrayBuffer) => void;
  reject: (error: Error) => void;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  buffer?: ArrayBuffer;
  error?: string;
}

export class EditOperations {
  private worker: Worker;
  private seq = 1;
  private pending = new Map<number, PendingEntry>();

  constructor() {
    this.worker = new Worker(new URL('../workers/pixel.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const { id, ok, buffer, error } = event.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (ok && buffer) entry.resolve(buffer);
      else entry.reject(new Error(error ?? '像素运算失败'));
    };
    this.worker.onerror = (event) => {
      const err = new Error(`像素运算 Worker 异常：${event.message}`);
      for (const entry of this.pending.values()) entry.reject(err);
      this.pending.clear();
    };
  }

  private dispatch(
    message: Record<string, unknown>,
    transfer: Transferable[],
  ): Promise<ArrayBuffer> {
    const id = this.seq++;
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  /**
   * 应用编辑操作。pixels 与 mask 的底层缓冲会被转移（调用方不再持有它们）。
   * 返回处理后的新像素数据。
   */
  async apply(
    pixels: Uint8ClampedArray,
    mask: Uint8ClampedArray,
    op: PixelOp,
    width: number,
    height: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer>> {
    // op 可能携带来自 Vue ref 的响应式 Proxy（无法 structured clone），
    // PixelOp 均为 JSON 安全值，先转为普通对象再发送。
    const plainOp = JSON.parse(JSON.stringify(op)) as PixelOp;
    const buffer = await this.dispatch(
      { kind: 'apply', op: plainOp, pixels: pixels.buffer, mask: mask.buffer, width, height },
      [pixels.buffer, mask.buffer],
    );
    return new Uint8ClampedArray(buffer);
  }

  /** 魔棒：从参考色生成灰度蒙版 */
  async magicWand(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    options: {
      refColor: [number, number, number];
      tolerance: number;
      contiguous: boolean;
      seedX: number;
      seedY: number;
    },
  ): Promise<Uint8ClampedArray<ArrayBuffer>> {
    const buffer = await this.dispatch(
      { kind: 'magic-wand', pixels: pixels.buffer, width, height, ...options },
      [pixels.buffer],
    );
    return new Uint8ClampedArray(buffer);
  }

  /** AI 差异蒙版：比较原图与 AI 结果（白底合成后按颜色距离阈值） */
  async diffMask(
    original: Uint8ClampedArray,
    modified: Uint8ClampedArray,
    threshold: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer>> {
    const buffer = await this.dispatch(
      { kind: 'diff-mask', original: original.buffer, modified: modified.buffer, threshold },
      [original.buffer, modified.buffer],
    );
    return new Uint8ClampedArray(buffer);
  }

  /** 蒙版后处理：羽化 / 膨胀 / 收缩 */
  async maskOp(
    op: MaskOpKind,
    gray: Uint8ClampedArray,
    width: number,
    height: number,
    radius: number,
  ): Promise<Uint8ClampedArray<ArrayBuffer>> {
    const buffer = await this.dispatch(
      { kind: 'mask-op', op, gray: gray.buffer, width, height, radius },
      [gray.buffer],
    );
    return new Uint8ClampedArray(buffer);
  }
}
