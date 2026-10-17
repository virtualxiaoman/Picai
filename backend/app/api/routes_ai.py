"""AI 修复 API：提交生成任务，结果经通用任务接口获取。"""

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ..services import ai_repair_service as service
from ..services.task_manager import task_manager

router = APIRouter(tags=['ai'])

MAX_IMAGE_BYTES = 120 * 1024 * 1024


@router.post('/ai/repair')
async def ai_repair(image: UploadFile = File(...), prompt: str = Form(...)) -> dict:
    text = prompt.strip()
    if not text:
        raise HTTPException(status_code=400, detail='请填写修复描述（如：把皮肤调白、去掉衣服上的褶皱）')
    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail='图片内容为空')
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail='图片过大（超过 120MB）')
    task = service.run_ai_repair(data, text)
    return {
        'id': task.id,
        'name': task.name,
        'status': task.status,
        'progress': task.progress,
        'message': task.message,
        'error': task.error,
        'has_result': False,
    }


@router.get('/ai/status')
def ai_status() -> dict:
    """AI 修复可用性（密钥文件是否就绪），不返回密钥内容。"""
    from ..core.config import settings
    from ..services.ai_repair_service import read_api_key

    key_file = settings.openlux_key_file
    info = {
        'configured': False,
        'key_file': str(key_file),
        'message': '',
    }
    try:
        read_api_key(key_file)
        info['configured'] = True
        info['message'] = 'API Key 已就绪'
    except RuntimeError as exc:
        info['message'] = str(exc)
    return info
