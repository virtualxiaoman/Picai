"""图像服务测试：蒙版编码、邻域填充（选区内外隔离）。"""

import io

import numpy as np
import pytest
from PIL import Image

from app.services import image_service, segmentation_service


def _png(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format='PNG')
    return buf.getvalue()


def test_encode_mask_png_roundtrip() -> None:
    gray = np.zeros((10, 20), dtype=np.uint8)
    gray[2:8, 5:15] = 255
    data = segmentation_service.encode_mask_png(gray)
    decoded = np.asarray(Image.open(io.BytesIO(data)))
    assert decoded.shape == (10, 20)
    assert decoded[5, 10] == 255
    assert decoded[0, 0] == 0


def test_decode_image_converts_to_rgb() -> None:
    rgba = np.zeros((4, 4, 4), dtype=np.uint8)
    rgba[..., 0] = 10
    rgba[..., 3] = 128
    img = segmentation_service.decode_image(_png(rgba))
    assert img.mode == 'RGB'
    assert img.size == (4, 4)


def test_inpaint_fills_region_and_keeps_unselected_pixels() -> None:
    image = np.full((40, 60, 3), 200, dtype=np.uint8)
    image[10:30, 20:40] = 30  # 待填充的深色区域
    mask = np.zeros((40, 60), dtype=np.uint8)
    mask[10:30, 20:40] = 255

    result = np.asarray(
        Image.open(io.BytesIO(image_service.inpaint(_png(image), _png(mask), 8))).convert('RGB')
    )
    assert result.shape == image.shape
    # 填充区域颜色接近周边（200 附近），而不是保留原始深色
    assert abs(int(result[20, 30, 0]) - 200) < 20
    # 选区外像素严格不变
    assert np.array_equal(result[:10], image[:10])
    assert np.array_equal(result[:, :20], image[:, :20])


def test_inpaint_rejects_empty_mask() -> None:
    image = np.full((10, 10, 3), 100, dtype=np.uint8)
    mask = np.zeros((10, 10), dtype=np.uint8)
    with pytest.raises(ValueError, match='选区为空'):
        image_service.inpaint(_png(image), _png(mask), 5)


def test_inpaint_rejects_size_mismatch() -> None:
    image = np.full((10, 10, 3), 100, dtype=np.uint8)
    mask = np.zeros((20, 20), dtype=np.uint8)
    mask[5:15, 5:15] = 255
    with pytest.raises(ValueError, match='尺寸'):
        image_service.inpaint(_png(image), _png(mask), 5)
