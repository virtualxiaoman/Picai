"""磁盘项目存储 API：项目清单、Blob 读写、保存与最近打开状态。"""

import json

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..core.config import settings
from ..services.storage_service import StorageService

router = APIRouter(prefix='/storage', tags=['storage'])

storage = StorageService(settings.storage_root)


def _save_error(exc: Exception) -> HTTPException:
    if isinstance(exc, FileNotFoundError):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=400, detail=str(exc))
    return HTTPException(status_code=500, detail=f'存储操作失败：{exc}')


@router.get('/app-state')
def get_app_state() -> dict:
    return {'state': storage.read_app_state()}


@router.get('/projects')
def list_projects() -> dict:
    return {'projects': storage.list_projects()}


@router.get('/projects/{folder}')
def get_project(folder: str) -> dict:
    try:
        manifest = storage.read_manifest(folder)
    except Exception as exc:
        raise _save_error(exc) from exc
    if manifest is None:
        raise HTTPException(status_code=404, detail=f'项目不存在：{folder}')
    return {'manifest': manifest}


@router.post('/save')
async def save_project(
    folder: str | None = Form(None),
    manifest: str = Form(...),
    files: list[UploadFile] = File(default=[]),
) -> dict:
    try:
        manifest_dict = json.loads(manifest)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f'清单 JSON 解析失败：{exc}') from exc
    payload: list[tuple[str, bytes]] = []
    for upload in files:
        payload.append((upload.filename or '', await upload.read()))
    try:
        final_folder = storage.save_project(folder or None, manifest_dict, payload)
    except Exception as exc:
        raise _save_error(exc) from exc
    return {'folder': final_folder}


@router.post('/projects/{folder}/blobs')
async def upload_blobs(folder: str, files: list[UploadFile] = File(...)) -> dict:
    if not files:
        raise HTTPException(status_code=400, detail='没有需要上传的文件')
    payload: list[tuple[str, bytes]] = []
    for upload in files:
        payload.append((upload.filename or '', await upload.read()))
    try:
        storage.save_blobs(folder, payload)
    except Exception as exc:
        raise _save_error(exc) from exc
    return {'uploaded': len(payload)}


@router.get('/projects/{folder}/blobs/{filename}')
def get_blob(folder: str, filename: str) -> FileResponse:
    try:
        path = storage.read_blob_path(folder, filename)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise _save_error(exc) from exc
    return FileResponse(path, media_type='application/octet-stream')


@router.get('/usage')
def storage_usage() -> dict:
    return storage.usage()
