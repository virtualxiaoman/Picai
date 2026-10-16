"""图像编辑 API：邻域渐变填充等需要在后端执行的整图操作。"""

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ..services import image_service
from ..services.task_manager import Task, task_manager

router = APIRouter(tags=['edit'])

MAX_BYTES = 120 * 1024 * 1024


async def _read(upload: UploadFile, name: str) -> bytes:
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail=f'{name} 内容为空')
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f'{name} 过大（超过 120MB）')
    return data


@router.post('/edit/neighborhood-fill')
async def neighborhood_fill(
    image: UploadFile = File(...),
    mask: UploadFile = File(...),
    radius: float = Form(8.0),
) -> dict:
    image_bytes = await _read(image, '图片')
    mask_bytes = await _read(mask, '蒙版')

    def job(task: Task) -> bytes:
        task.progress = 0.2
        task.message = '邻域颜色估算与扩散中…'
        task_manager.check_cancelled(task)
        result = image_service.inpaint(image_bytes, mask_bytes, radius)
        task.progress = 0.95
        task.message = '编码结果…'
        return result

    task = task_manager.create('neighborhood_fill', job)
    return {
        'id': task.id,
        'name': task.name,
        'status': task.status,
        'progress': task.progress,
        'message': task.message,
        'error': task.error,
        'has_result': False,
    }
