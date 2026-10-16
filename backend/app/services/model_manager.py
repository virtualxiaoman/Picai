"""模型管理器：设备选择、下载网络环境、适配器注册与状态查询、推理串行化。"""

import os
import threading

from ..adapters.birefnet import BiRefNetAdapter
from ..adapters.sam3 import Sam3Adapter, Sam3TrackerAdapter
from ..core.config import settings


class ModelManager:
    def __init__(self) -> None:
        # GPU/CPU 推理串行执行，避免多个任务争抢显存与算力
        self.inference_lock = threading.Lock()
        self._device: str | None = None
        self._birefnet: BiRefNetAdapter | None = None
        self._sam3: Sam3Adapter | None = None
        self._sam3_tracker: Sam3TrackerAdapter | None = None

    def apply_network_env(self) -> None:
        """在导入 HuggingFace 相关库之前应用缓存目录与代理设置。"""
        os.environ.setdefault('HF_HOME', str(settings.hf_home))
        if settings.hf_proxy:
            os.environ.setdefault('HTTP_PROXY', settings.hf_proxy)
            os.environ.setdefault('HTTPS_PROXY', settings.hf_proxy)

    @property
    def device(self) -> str:
        if self._device is None:
            if settings.device_preference == 'cuda':
                try:
                    import torch

                    self._device = 'cuda' if torch.cuda.is_available() else 'cpu'
                except Exception:
                    self._device = 'cpu'
            else:
                self._device = 'cpu'
        return self._device

    def get_birefnet(self) -> BiRefNetAdapter:
        if self._birefnet is None:
            self.apply_network_env()
            self._birefnet = BiRefNetAdapter(settings.birefnet_model_id, self.device)
        return self._birefnet

    def get_sam3(self) -> Sam3Adapter:
        if self._sam3 is None:
            self._sam3 = Sam3Adapter(settings.sam3_model_id, self.device, settings.sam3_local_dir)
        return self._sam3

    def get_sam3_tracker(self) -> Sam3TrackerAdapter:
        if self._sam3_tracker is None:
            self._sam3_tracker = Sam3TrackerAdapter(
                settings.sam3_model_id, self.device, settings.sam3_local_dir
            )
        return self._sam3_tracker

    def status(self) -> dict:
        sam3 = self.get_sam3()
        tracker = self.get_sam3_tracker()
        models = [
            {
                'name': 'birefnet',
                'title': '自动抠图（BiRefNet）',
                'model_id': settings.birefnet_model_id,
                'loaded': self._birefnet.loaded if self._birefnet else False,
                'available': True,
                'note': '',
                'last_error': self._birefnet.last_error if self._birefnet else '',
            },
            {
                'name': 'sam3',
                'title': '文本对象分割（SAM 3）',
                'model_id': sam3._source(),
                'loaded': sam3.loaded,
                'available': sam3.local_weights_available() or bool(os.environ.get('PICAI_ALLOW_HF_DOWNLOAD')),
                'note': '本地权重已就绪（models/sam3）' if sam3.local_weights_available() else '本地无权重，将尝试在线下载',
                'last_error': sam3.last_error,
            },
            {
                'name': 'sam3-tracker',
                'title': '点选 / 框选分割（SAM 3 Tracker）',
                'model_id': tracker._source(),
                'loaded': tracker.loaded,
                'available': tracker.local_weights_available()
                or bool(os.environ.get('PICAI_ALLOW_HF_DOWNLOAD')),
                'note': '本地权重已就绪（models/sam3）' if tracker.local_weights_available() else '本地无权重，将尝试在线下载',
                'last_error': tracker.last_error,
            },
        ]
        return {'device': self.device, 'models': models}


manager = ModelManager()
