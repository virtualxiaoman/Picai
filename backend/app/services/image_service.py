"""图像处理服务：邻域渐变填充等整图操作（OpenCV/NumPy）。"""

import io

import cv2
import numpy as np
from PIL import Image


def inpaint(image_bytes: bytes, mask_bytes: bytes, radius: float) -> bytes:
    """邻域渐变填充：从选区边界采样邻近颜色并向内扩散（OpenCV Telea 算法）。

    注意：这是邻域颜色估算，不等同于完整的语义内容修复。
    返回与原图同尺寸的 PNG。
    """
    image = np.asarray(Image.open(io.BytesIO(image_bytes)).convert('RGB'))
    mask = np.asarray(Image.open(io.BytesIO(mask_bytes)).convert('L'))
    if mask.shape[:2] != image.shape[:2]:
        raise ValueError(
            f'蒙版尺寸 {mask.shape[1]}×{mask.shape[0]} 与原图 {image.shape[1]}×{image.shape[0]} 不一致'
        )
    binary = np.where(mask > 127, np.uint8(255), np.uint8(0))
    if int(binary.max()) == 0:
        raise ValueError('选区为空（容差过小或点击位置无匹配），无法执行填充')
    filled = cv2.inpaint(image, binary, float(max(1.0, radius)), cv2.INPAINT_TELEA)
    out = Image.fromarray(filled)
    buf = io.BytesIO()
    out.save(buf, format='PNG')
    return buf.getvalue()
