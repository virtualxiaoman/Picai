"""模型适配器基类：业务层只依赖此接口，不直接依赖具体模型实现。"""

from abc import ABC, abstractmethod


class ModelAdapter(ABC):
    name: str = 'base'

    def __init__(self, model_id: str, device: str) -> None:
        self.model_id = model_id
        self.device = device
        self.last_error: str = ''

    @property
    @abstractmethod
    def loaded(self) -> bool:
        """模型是否已完成加载。"""

    @abstractmethod
    def load(self) -> None:
        """加载模型（幂等，重复调用直接返回）。抛出的异常由调用方转为用户可读信息。"""

    def unload(self) -> None:
        """释放显存（可选实现）。"""

    def status(self) -> dict:
        return {
            'name': self.name,
            'model_id': self.model_id,
            'loaded': self.loaded,
            'last_error': self.last_error,
        }
