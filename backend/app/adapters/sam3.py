"""SAM 3 适配器。

- Sam3Adapter：文本概念分割 / 框提示概念分割（post_process_instance_segmentation）。
- Sam3TrackerAdapter：交互式点选分割（PVS，SAM2 风格的 tracker API）。

权重优先从项目内本地目录（models/sam3，经魔搭/镜像下载）加载；
本地缺失时回退到 HuggingFace 官方仓库 ID（需网络与授权）。
"""

from pathlib import Path

import numpy as np
from PIL import Image

from .base import ModelAdapter


def _merge_masks(masks, width: int, height: int) -> np.ndarray:
    """把实例蒙版集合合并为单张 uint8 蒙版（并集），与原图同尺寸。"""
    merged = np.zeros((height, width), dtype=np.uint8)

    def add(mask) -> None:
        if isinstance(mask, (list, tuple)):
            for sub in mask:
                add(sub)
            return
        arr = mask.cpu().numpy() if hasattr(mask, 'cpu') else np.asarray(mask)
        if arr.ndim > 2:
            for sub in arr:
                add(sub)
            return
        if arr.shape[-2] != height or arr.shape[-1] != width:
            return
        np.maximum(merged, (arr > 0).astype(np.uint8) * 255, out=merged)

    if masks is not None:
        add(masks)
    return merged


class Sam3Adapter(ModelAdapter):
    """文本 / 框提示的概念分割。"""

    name = 'sam3'

    def __init__(self, model_id: str, device: str, local_dir: Path | None = None) -> None:
        super().__init__(model_id, device)
        self.local_dir = local_dir
        self._model = None
        self._processor = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def local_weights_available(self) -> bool:
        return bool(self.local_dir and (self.local_dir / 'model.safetensors').exists())

    def _source(self) -> str:
        if self.local_weights_available():
            return str(self.local_dir)
        return self.model_id

    def load(self) -> None:
        if self._model is not None:
            return
        from transformers import Sam3Model, Sam3Processor

        try:
            source = self._source()
            self._processor = Sam3Processor.from_pretrained(source)
            model = Sam3Model.from_pretrained(source)
            model.to(self.device)
            model.eval()
            self._model = model
            self.last_error = ''
        except Exception as exc:
            self.last_error = (
                f'SAM 3 加载失败：{exc}。若使用本地权重请确认 models/sam3 完整；'
                '若需在线下载请检查代理配置（.env 的 PICAI_HF_PROXY）与模型授权。'
            )
            raise RuntimeError(self.last_error) from exc

    def unload(self) -> None:
        self._model = None
        self._processor = None
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def infer_text(
        self, image: Image.Image, text: str, check_cancelled=None, threshold: float = 0.5
    ) -> np.ndarray:
        self.load()
        import torch

        if check_cancelled:
            check_cancelled()
        rgb = image.convert('RGB')
        width, height = rgb.size
        inputs = self._processor(images=rgb, text=text, return_tensors='pt').to(self.device)
        with torch.no_grad():
            outputs = self._model(**inputs)
        if check_cancelled:
            check_cancelled()
        results = self._processor.post_process_instance_segmentation(
            outputs,
            threshold=threshold,
            mask_threshold=0.5,
            target_sizes=inputs.get('original_sizes').tolist(),
        )[0]
        return _merge_masks(results.get('masks'), width, height)

    def infer_boxes(
        self,
        image: Image.Image,
        boxes: list[list[float]],
        labels: list[int],
        check_cancelled=None,
        threshold: float = 0.5,
    ) -> np.ndarray:
        self.load()
        import torch

        if check_cancelled:
            check_cancelled()
        rgb = image.convert('RGB')
        width, height = rgb.size
        inputs = self._processor(
            images=rgb,
            input_boxes=[boxes],
            input_boxes_labels=[labels],
            return_tensors='pt',
        ).to(self.device)
        with torch.no_grad():
            outputs = self._model(**inputs)
        if check_cancelled:
            check_cancelled()
        results = self._processor.post_process_instance_segmentation(
            outputs,
            threshold=threshold,
            mask_threshold=0.5,
            target_sizes=inputs.get('original_sizes').tolist(),
        )[0]
        return _merge_masks(results.get('masks'), width, height)


class Sam3TrackerAdapter(ModelAdapter):
    """交互式点选 / 框选分割（单个目标实例）。"""

    name = 'sam3-tracker'

    def __init__(self, model_id: str, device: str, local_dir: Path | None = None) -> None:
        super().__init__(model_id, device)
        self.local_dir = local_dir
        self._model = None
        self._processor = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def local_weights_available(self) -> bool:
        return bool(self.local_dir and (self.local_dir / 'model.safetensors').exists())

    def _source(self) -> str:
        if self.local_weights_available():
            return str(self.local_dir)
        return self.model_id

    def load(self) -> None:
        if self._model is not None:
            return
        from transformers import Sam3TrackerModel, Sam3TrackerProcessor

        try:
            source = self._source()
            self._processor = Sam3TrackerProcessor.from_pretrained(source)
            model = Sam3TrackerModel.from_pretrained(source)
            model.to(self.device)
            model.eval()
            self._model = model
            self.last_error = ''
        except Exception as exc:
            self.last_error = (
                f'SAM 3 Tracker 加载失败：{exc}。若使用本地权重请确认 models/sam3 完整；'
                '若需在线下载请检查代理配置与模型授权。'
            )
            raise RuntimeError(self.last_error) from exc

    def infer_points(
        self,
        image: Image.Image,
        points: list[list[float]],
        labels: list[int],
        box: list[float] | None = None,
        check_cancelled=None,
    ) -> np.ndarray:
        self.load()
        import torch

        if check_cancelled:
            check_cancelled()
        rgb = image.convert('RGB')
        width, height = rgb.size

        kwargs: dict = {}
        if points:
            kwargs['input_points'] = [[points]]
            kwargs['input_labels'] = [[labels]]
        if box:
            kwargs['input_boxes'] = [[box]]

        inputs = self._processor(images=rgb, return_tensors='pt', **kwargs).to(self.device)
        with torch.no_grad():
            outputs = self._model(**inputs, multimask_output=False)
        if check_cancelled:
            check_cancelled()
        preds = self._processor.post_process_masks(
            outputs.pred_masks.cpu(), inputs['original_sizes']
        )[0]
        return _merge_masks(preds, width, height)
