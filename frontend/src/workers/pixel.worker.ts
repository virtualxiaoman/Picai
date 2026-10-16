/// <reference lib="webworker" />

/** 像素运算 Worker：编辑操作、魔棒、蒙版后处理都在此执行，避免阻塞界面 */

import { applyPixelOp, featherGray, magicWand, morphGray } from '../core/pixelOps';
import type { MaskOpKind, PixelOp } from '../types';

interface ApplyMessage {
  id: number;
  kind: 'apply';
  op: PixelOp;
  pixels: ArrayBuffer;
  mask: ArrayBuffer;
  width: number;
  height: number;
}

interface MagicWandMessage {
  id: number;
  kind: 'magic-wand';
  pixels: ArrayBuffer;
  width: number;
  height: number;
  refColor: [number, number, number];
  tolerance: number;
  contiguous: boolean;
  seedX: number;
  seedY: number;
}

interface MaskOpMessage {
  id: number;
  kind: 'mask-op';
  op: MaskOpKind;
  gray: ArrayBuffer;
  width: number;
  height: number;
  radius: number;
}

type RequestMessage = ApplyMessage | MagicWandMessage | MaskOpMessage;

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<RequestMessage>) => {
  const msg = event.data;
  try {
    let buffer: ArrayBuffer;
    if (msg.kind === 'apply') {
      const px = new Uint8ClampedArray(msg.pixels);
      const mk = new Uint8ClampedArray(msg.mask);
      applyPixelOp(px, mk, msg.op, msg.width, msg.height);
      buffer = px.buffer;
    } else if (msg.kind === 'magic-wand') {
      const px = new Uint8ClampedArray(msg.pixels);
      const gray = magicWand(px, msg.width, msg.height, {
        refColor: msg.refColor,
        tolerance: msg.tolerance,
        contiguous: msg.contiguous,
        seedX: msg.seedX,
        seedY: msg.seedY,
      });
      buffer = gray.buffer;
    } else {
      const gray = new Uint8ClampedArray(msg.gray);
      const result =
        msg.op === 'feather'
          ? featherGray(gray, msg.width, msg.height, msg.radius)
          : morphGray(gray, msg.width, msg.height, msg.radius, msg.op);
      buffer = result.buffer;
    }
    worker.postMessage({ id: msg.id, ok: true, buffer }, [buffer]);
  } catch (err) {
    worker.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
