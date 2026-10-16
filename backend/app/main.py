"""Picai 本地 AI 图片编辑 - FastAPI 入口。"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .api.routes_edit import router as edit_router
from .api.routes_segmentation import router as segmentation_router
from .api.routes_system import router as system_router
from .core.config import settings
from .services.model_manager import manager
from .services.task_manager import TaskManager, task_manager

app = FastAPI(title="Picai 本地 AI 图片编辑", version="0.1.0")

# 统一任务超时配置
task_manager.timeout_seconds = settings.task_timeout_seconds

# 在导入任何 HuggingFace 相关库之前应用缓存目录与代理
manager.apply_network_env()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(system_router, prefix="/api")
app.include_router(segmentation_router, prefix="/api")
app.include_router(edit_router, prefix="/api")

# 生产模式：若前端已构建（frontend/dist），直接由后端托管
if settings.frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=str(settings.frontend_dist), html=True), name="frontend")
