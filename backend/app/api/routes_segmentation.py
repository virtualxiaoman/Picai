"""分割 API 路由：提交后台任务、查询状态、获取蒙版结果、取消任务。"""

import json

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from ..services import segmentation_service as service
from ..services.model_manager import manager
from ..services.task_manager import task_manager

router = APIRouter(tags=['segmentation'])

MAX_IMAGE_BYTES = 120 * 1024 * 1024


async def _read_image(image: UploadFile) -> bytes:
    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail='图片内容为空')
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail='图片过大（超过 120MB）')
    return data


def _task_payload(task) -> dict:
    return {
        'id': task.id,
        'name': task.name,
        'status': task.status,
        'progress': round(task.progress, 3),
        'message': task.message,
        'error': task.error,
        'has_result': task.result is not None,
    }


@router.post('/segmentation/remove-background')
async def remove_background(image: UploadFile = File(...)) -> dict:
    task = service.run_remove_background(await _read_image(image))
    return _task_payload(task)


@router.post('/segmentation/text')
async def text_segment(image: UploadFile = File(...), prompt: str = Form(...)) -> dict:
    prompt = prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail='请填写对象描述（如 person、sky、cat、car）')
    task = service.run_text_segment(await _read_image(image), prompt)
    return _task_payload(task)


@router.post('/segmentation/points')
async def point_segment(
    image: UploadFile = File(...),
    points: str = Form('[]'),
    labels: str = Form('[]'),
    box: str | None = Form(None),
) -> dict:
    try:
        points_list = json.loads(points)
        labels_list = json.loads(labels)
        box_list = json.loads(box) if box else None
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f'参数格式错误：{exc}') from exc
    for p in points_list:
        if not (isinstance(p, list) and len(p) == 2):
            raise HTTPException(status_code=400, detail='点坐标格式应为 [x, y]')
    if not points_list and not box_list:
        raise HTTPException(status_code=400, detail='请提供至少一个点或一个框')
    task = service.run_point_segment(
        await _read_image(image), points_list, labels_list, box_list
    )
    return _task_payload(task)


@router.get('/tasks/{task_id}')
def task_status(task_id: str) -> dict:
    task = task_manager.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail='任务不存在或已过期')
    return _task_payload(task)


@router.get('/tasks/{task_id}/result')
def task_result(task_id: str) -> Response:
    task = task_manager.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail='任务不存在或已过期')
    if task.status != 'succeeded' or task.result is None:
        raise HTTPException(status_code=409, detail='任务尚未成功完成')
    return Response(
        content=task.result,
        media_type='image/png',
        headers={'Cache-Control': 'no-store'},
    )


@router.delete('/tasks/{task_id}')
def cancel_task(task_id: str) -> dict:
    task = task_manager.cancel(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail='任务不存在或已过期')
    return _task_payload(task)


@router.get('/models/status')
def models_status() -> dict:
    return manager.status()
