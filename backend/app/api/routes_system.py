"""系统状态路由：健康检查与推理设备信息。"""

from fastapi import APIRouter

router = APIRouter(tags=["system"])


@router.get("/health")
def health() -> dict:
    return {"status": "ok", "app": "picai-backend", "version": "0.1.0"}


@router.get("/device")
def device_info() -> dict:
    info: dict = {
        "torch_installed": False,
        "torch_version": None,
        "cuda_available": False,
        "device_name": None,
        "message": "",
    }
    try:
        import torch

        info["torch_installed"] = True
        info["torch_version"] = torch.__version__
        info["cuda_available"] = bool(torch.cuda.is_available())
        if info["cuda_available"]:
            info["device_name"] = torch.cuda.get_device_name(0)
        else:
            info["message"] = "CUDA 不可用，将回退 CPU 推理（速度较慢）"
    except Exception as exc:  # torch 未安装或加载失败
        info["message"] = f"PyTorch 未安装或加载失败：{exc}"
    return info
