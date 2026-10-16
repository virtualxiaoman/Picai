"""分割服务：把模型推理与后处理组织为后台任务（不阻塞请求处理）。"""

import io

import numpy as np
from PIL import Image

from .model_manager import manager
from .task_manager import Task, task_manager


def decode_image(data: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(data))
    image.load()
    return image.convert('RGB')


def encode_mask_png(mask: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(mask, 'L').save(buf, format='PNG')
    return buf.getvalue()


def _cancel_checker(task: Task):
    return lambda: task_manager.check_cancelled(task)


def run_remove_background(image_bytes: bytes):
    """自动抠图：BiRefNet 前景蒙版（可反选为背景）。"""

    def job(task: Task) -> bytes:
        image = decode_image(image_bytes)
        task.progress = 0.15
        task.message = '加载 BiRefNet 模型…'
        adapter = manager.get_birefnet()
        with manager.inference_lock:
            task_manager.check_cancelled(task)
            adapter.load()
            task.progress = 0.4
            task.message = '前景分割推理中…'
            mask = adapter.infer(image, check_cancelled=_cancel_checker(task))
        task.progress = 0.95
        task.message = '编码蒙版…'
        return encode_mask_png(mask)

    return task_manager.create('remove_background', job)


def run_text_segment(image_bytes: bytes, prompt: str):
    """按文本描述分割所有匹配对象（SAM 3 概念分割）。"""

    def job(task: Task) -> bytes:
        image = decode_image(image_bytes)
        task.progress = 0.15
        task.message = '加载 SAM 3 模型…'
        adapter = manager.get_sam3()
        with manager.inference_lock:
            task_manager.check_cancelled(task)
            adapter.load()
            task.progress = 0.4
            task.message = f'按描述「{prompt}」分割中…'
            mask = adapter.infer_text(
                image, prompt, check_cancelled=_cancel_checker(task)
            )
        if int(mask.max()) == 0:
            raise RuntimeError(f'未在图片中找到与「{prompt}」匹配的对象，请更换描述词或使用点选工具')
        task.progress = 0.95
        task.message = '编码蒙版…'
        return encode_mask_png(mask)

    return task_manager.create('text_segment', job)


def run_point_segment(
    image_bytes: bytes,
    points: list[list[float]],
    labels: list[int],
    box: list[float] | None = None,
):
    """点选 / 框选交互式分割（SAM 3 Tracker）。"""

    def job(task: Task) -> bytes:
        image = decode_image(image_bytes)
        task.progress = 0.15
        task.message = '加载 SAM 3 Tracker 模型…'
        adapter = manager.get_sam3_tracker()
        with manager.inference_lock:
            task_manager.check_cancelled(task)
            adapter.load()
            task.progress = 0.45
            task.message = '交互式分割中…'
            mask = adapter.infer_points(
                image,
                points,
                labels,
                box=box,
                check_cancelled=_cancel_checker(task),
            )
        if int(mask.max()) == 0:
            raise RuntimeError('未能分割出目标，请尝试调整点击位置或框选范围')
        task.progress = 0.95
        task.message = '编码蒙版…'
        return encode_mask_png(mask)

    return task_manager.create('point_segment', job)
