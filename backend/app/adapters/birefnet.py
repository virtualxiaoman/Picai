"""BiRefNet 自动抠图适配器（前景/背景二值、高质量 DIS 模型）。

参考模型卡用法：1024×1024 预处理 -> 前向 -> sigmoid -> 蒙版缩放回原图分辨率。
"""

import numpy as np
from PIL import Image

from .base import ModelAdapter


class BiRefNetAdapter(ModelAdapter):
    name = 'birefnet'

    def __init__(self, model_id: str, device: str) -> None:
        super().__init__(model_id, device)
        self._model = None
        self._transform = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        if self._model is not None:
            return
        import torch  # noqa: F401
        from torchvision import transforms
        from transformers import AutoModelForImageSegmentation

        try:
            # 优先本地缓存加载：避免每次加载时的联网检查拖慢启动或卡住
            try:
                model = AutoModelForImageSegmentation.from_pretrained(
                    self.model_id, trust_remote_code=True, local_files_only=True
                )
            except Exception:
                model = AutoModelForImageSegmentation.from_pretrained(
                    self.model_id, trust_remote_code=True
                )
            model.to(self.device)
            model.eval()
            if self.device == 'cuda':
                try:
                    model.half()
                except Exception:
                    pass  # 部分自定义层不支持半精度时保持 fp32
            self._transform = transforms.Compose(
                [
                    transforms.Resize((1024, 1024)),
                    transforms.ToTensor(),
                    transforms.Normalize(
                        mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]
                    ),
                ]
            )
            self._model = model
            self.last_error = ''
        except Exception as exc:
            self.last_error = f'BiRefNet 加载失败：{exc}'
            raise

    def unload(self) -> None:
        self._model = None
        self._transform = None
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def infer(self, image: Image.Image, check_cancelled=None) -> np.ndarray:
        """返回与原图同尺寸的前景蒙版（uint8，0-255）。"""
        self.load()
        import torch

        if check_cancelled:
            check_cancelled()
        rgb = image.convert('RGB')
        width, height = rgb.size
        x = self._transform(rgb).unsqueeze(0).to(self.device)
        param_dtype = next(self._model.parameters()).dtype
        if param_dtype == torch.float16:
            x = x.half()
        with torch.no_grad():
            preds = self._model(x)[-1].sigmoid().cpu()
        if check_cancelled:
            check_cancelled()
        pred = preds[0].squeeze().numpy()
        mask_img = Image.fromarray((pred * 255).astype(np.uint8), 'L').resize(
            (width, height), Image.BILINEAR
        )
        return np.asarray(mask_img, dtype=np.uint8)
