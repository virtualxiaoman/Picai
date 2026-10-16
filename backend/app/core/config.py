"""全局配置：模型目录、下载代理、推理设备等。"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/core/config.py 位于 <项目根>/backend/app/core/ 下，向上 3 层得到项目根目录
PROJECT_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="PICAI_",
        env_file=str(PROJECT_ROOT / ".env"),
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = 8000

    # HuggingFace 模型缓存目录（固定在项目内，满足“模型安装在项目目录下”）
    hf_home: Path = PROJECT_ROOT / "models" / "hf-cache"
    # 模型下载代理，例如 http://127.0.0.1:17890；留空表示直连
    hf_proxy: str = ""
    # 推理设备偏好：cuda / cpu
    device_preference: str = "cuda"

    # 模型标识与本地权重目录
    birefnet_model_id: str = "ZhengPeng7/BiRefNet"
    sam3_model_id: str = "facebook/sam3"
    sam3_local_dir: Path = PROJECT_ROOT / "models" / "sam3"
    # SAM 3 文本概念分割阈值
    sam3_text_threshold: float = 0.5
    # 后台任务超时（秒）
    task_timeout_seconds: float = 600.0

    @property
    def frontend_dist(self) -> Path:
        return PROJECT_ROOT / "frontend" / "dist"


settings = Settings()
