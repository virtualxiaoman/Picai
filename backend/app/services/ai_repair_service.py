"""AI 修复服务：调用 openlux（OpenAI 兼容图像编辑接口）生成修复结果。

注意：图片会上传到 openlux.ai 进行生成（前端已向用户提示）。
API Key 由服务端在请求时从本地文件读取；不写日志、不返回给前端。
"""

import base64
import io
from pathlib import Path

from PIL import Image

from ..core.config import settings
from .task_manager import Task, task_manager


def read_api_key(path: Path) -> str:
    try:
        raw = Path(path).read_text(encoding='utf-8').strip()
    except FileNotFoundError as exc:
        raise RuntimeError(f'未找到 API Key 文件：{path}') from exc
    except OSError as exc:
        raise RuntimeError(f'读取 API Key 失败：{exc}') from exc
    key = raw.splitlines()[0].strip() if raw else ''
    if not key.startswith('sk-'):
        raise RuntimeError('API Key 格式不正确（应以 sk- 开头），请检查密钥文件内容')
    return key


def pick_image_size(width: int, height: int) -> str:
    """按原图宽高比选择接口支持的尺寸（返回图会由前端缩放回原图尺寸）"""
    ratio = width / height if height else 1.0
    if ratio >= 1.15:
        return '1536x1024'
    if ratio <= 0.87:
        return '1024x1536'
    return '1024x1024'


def _to_rgb_png(image_bytes: bytes) -> tuple[bytes, int, int]:
    """解析输入图；透明区域铺白后输出 PNG（AI 接口不接受透明语义）"""
    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
    except Exception as exc:
        raise RuntimeError(f'输入图片无法解析：{exc}') from exc
    width, height = image.size
    if image.mode in ('RGBA', 'LA', 'P'):
        rgba = image.convert('RGBA')
        background = Image.new('RGB', rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.split()[-1])
        image = background
    else:
        image = image.convert('RGB')
    buf = io.BytesIO()
    image.save(buf, format='PNG')
    return buf.getvalue(), width, height


def request_edit(
    image_bytes: bytes,
    prompt: str,
    api_key: str,
    notify=None,
) -> bytes:
    """调用图像编辑接口并返回 PNG 字节（兼容 b64_json / url 两种响应）。

    尺寸策略：优先请求原图分辨率；若服务不接受该尺寸（400/422），
    自动回退到最接近的支持尺寸（返回图由前端缩放到原图尺寸并提示）。
    """
    import requests

    png_bytes, width, height = _to_rgb_png(image_bytes)
    fallback_size = pick_image_size(width, height)
    original_size = f'{width}x{height}'
    sizes: list[str] = []
    if settings.openlux_prefer_original_size:
        sizes.append(original_size)
    if fallback_size not in sizes:
        sizes.append(fallback_size)

    url = f'{settings.openlux_base_url.rstrip("/")}{settings.openlux_edits_path}'
    headers = {'Authorization': f'Bearer {api_key}'}
    files = {'image': ('image.png', png_bytes, 'image/png')}
    resp = None
    for index, size in enumerate(sizes):
        # 每次尝试使用独立表单，避免复用字典导致的歧义
        request_data = {
            'model': settings.openlux_model,
            'prompt': prompt,
            'n': '1',
            'size': size,
            'quality': settings.openlux_quality,
        }
        if notify:
            notify(f'请求尺寸 {size}，等待 AI 生成（可能需要数十秒）…')
        try:
            resp = requests.post(
                url, headers=headers, files=files, data=request_data, timeout=(15, 300)
            )
        except requests.RequestException as exc:
            raise RuntimeError(f'连接 AI 服务失败：{exc}') from exc
        if resp.status_code == 200:
            break
        # 原图尺寸不被支持时回退到受支持尺寸
        if index == 0 and len(sizes) > 1 and resp.status_code in (400, 422):
            if notify:
                notify(f'原图尺寸 {size} 不被服务支持，改用 {sizes[1]}…')
            continue
        detail = (resp.text or '')[:400]
        raise RuntimeError(f'AI 服务返回错误（HTTP {resp.status_code}）：{detail}')
    if resp is None or resp.status_code != 200:
        raise RuntimeError('AI 服务未返回结果')
    try:
        payload = resp.json()
    except ValueError as exc:
        raise RuntimeError('AI 服务返回了无法解析的响应（非 JSON）') from exc
    items = payload.get('data') or []
    if not items:
        raise RuntimeError(f'AI 服务未返回图片：{str(payload)[:300]}')
    item = items[0]
    result_bytes: bytes | None = None
    if item.get('b64_json'):
        try:
            result_bytes = base64.b64decode(item['b64_json'])
        except Exception as exc:
            raise RuntimeError('AI 返回的图片数据解码失败') from exc
    elif item.get('url'):
        try:
            img_resp = requests.get(item['url'], timeout=(15, 180))
        except requests.RequestException as exc:
            raise RuntimeError(f'下载 AI 结果失败：{exc}') from exc
        if img_resp.status_code != 200:
            raise RuntimeError(f'下载 AI 结果失败（HTTP {img_resp.status_code}）')
        result_bytes = img_resp.content
    if not result_bytes:
        raise RuntimeError('AI 服务返回格式不受支持（缺少 b64_json / url）')
    try:
        result_image = Image.open(io.BytesIO(result_bytes))
        result_image.load()
    except Exception as exc:
        raise RuntimeError(f'AI 返回的图片无法解析：{exc}') from exc
    out = io.BytesIO()
    result_image.convert('RGB').save(out, format='PNG')
    return out.getvalue()


def run_ai_repair(image_bytes: bytes, prompt: str):
    def job(task: Task) -> bytes:
        task.progress = 0.1
        task.message = '读取 API 配置…'
        api_key = read_api_key(settings.openlux_key_file)
        task_manager.check_cancelled(task)
        task.progress = 0.25
        task.message = '上传图片并等待 AI 生成（可能需要数十秒）…'
        return request_edit(
            image_bytes,
            prompt,
            api_key,
            notify=lambda msg: setattr(task, 'message', msg),
        )

    return task_manager.create('ai_repair', job)
