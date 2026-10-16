"""磁盘项目存储服务：把项目/图片/历史版本/区域以文件形式保存到项目目录。

目录结构（data/history/）：
    app_state.json                  # 最近打开的项目/图片
    <项目名>/                        # 每个项目一个文件夹（重命名时自动改名）
        project.json                # 项目清单（图片 / 历史节点 / 区域元数据 + Blob 文件名）
        blobs/                      # 原图、历史快照、缩略图、区域蒙版（二进制文件）

前端通过 /api/storage/* 读写；浏览器沙箱无法直接访问磁盘，因此由后端代持。
"""

import json
import os
import re
import time
from pathlib import Path

_ILLEGAL_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_MANIFEST_NAME = 'project.json'
_BLOBS_DIR = 'blobs'
_APP_STATE_NAME = 'app_state.json'


def slugify(name: str) -> str:
    """项目名 -> 文件夹名（保留中文，替换非法字符）"""
    cleaned = _ILLEGAL_CHARS.sub('_', (name or '').strip()).strip(' ._-')
    return cleaned or 'project'


def _unique_folder(root: Path, base: str) -> Path:
    candidate = root / base
    if not candidate.exists():
        return candidate
    index = 2
    while True:
        candidate = root / f'{base} ({index})'
        if not candidate.exists():
            return candidate
        index += 1


def _safe_blob_name(filename: str) -> str:
    """Blob 文件名校验：只允许裸文件名，防目录穿越"""
    name = (filename or '').strip()
    if (
        not name
        or name != Path(name).name
        or name in ('.', '..')
        or '/' in name
        or '\\' in name
    ):
        raise ValueError(f'非法 Blob 文件名：{filename!r}')
    return name


def referenced_blob_names(manifest: dict) -> set[str]:
    """清单中引用的全部 Blob 文件名"""
    names: set[str] = set()
    for image in manifest.get('images') or []:
        for key in ('original', 'thumb'):
            value = image.get(key)
            if value:
                names.add(str(value))
        for node in image.get('nodes') or []:
            for key in ('snapshot', 'thumb'):
                value = node.get(key)
                if value:
                    names.add(str(value))
        for region in image.get('regions') or []:
            for key in ('gray', 'thumb'):
                value = region.get(key)
                if value:
                    names.add(str(value))
    return names


class StorageService:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    # ---------- 项目 ----------

    def list_projects(self) -> list[dict]:
        projects: list[dict] = []
        for folder in self.root.iterdir():
            if not folder.is_dir():
                continue
            manifest_path = folder / _MANIFEST_NAME
            if not manifest_path.exists():
                continue
            try:
                manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            except Exception:
                continue
            projects.append(
                {
                    'id': manifest.get('id') or folder.name,
                    'folder': folder.name,
                    'name': manifest.get('name') or folder.name,
                    'createdAt': manifest.get('createdAt') or 0,
                    'updatedAt': manifest.get('updatedAt') or 0,
                    'imageCount': len(manifest.get('images') or []),
                }
            )
        projects.sort(key=lambda p: p['updatedAt'], reverse=True)
        return projects

    def read_manifest(self, folder: str) -> dict | None:
        path = self._folder_path(folder) / _MANIFEST_NAME
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except Exception:
            return None

    def save_project(
        self,
        folder: str | None,
        manifest: dict,
        files: list[tuple[str, bytes]],
    ) -> str:
        """保存项目：写 Blob、写清单、清理未引用 Blob、更新最近打开状态。返回最终文件夹名。"""
        target = self._resolve_folder(folder, str(manifest.get('name') or ''))
        blobs_dir = target / _BLOBS_DIR
        blobs_dir.mkdir(exist_ok=True)
        for filename, data in files:
            name = _safe_blob_name(filename)
            (blobs_dir / name).write_bytes(data)
        self._write_manifest(target, manifest)
        self._prune_blobs(blobs_dir, manifest)
        self._write_app_state(
            project_id=manifest.get('id'),
            folder=target.name,
            image_id=manifest.get('activeImageId'),
        )
        return target.name

    def save_blobs(self, folder: str, files: list[tuple[str, bytes]]) -> None:
        """仅上传 Blob（迁移时分批上传，不动清单）"""
        target = self._folder_path(folder)
        blobs_dir = target / _BLOBS_DIR
        blobs_dir.mkdir(parents=True, exist_ok=True)
        for filename, data in files:
            name = _safe_blob_name(filename)
            (blobs_dir / name).write_bytes(data)

    def read_blob_path(self, folder: str, filename: str) -> Path:
        name = _safe_blob_name(filename)
        path = self._folder_path(folder) / _BLOBS_DIR / name
        if not path.is_file():
            raise FileNotFoundError(f'Blob 不存在：{folder}/{name}')
        return path

    # ---------- 最近打开状态 ----------

    def read_app_state(self) -> dict | None:
        path = self.root / _APP_STATE_NAME
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except Exception:
            return None

    # ---------- 用量统计 ----------

    def usage(self) -> dict:
        total = 0
        files = 0
        for path in self.root.rglob('*'):
            if path.is_file():
                total += path.stat().st_size
                files += 1
        projects = len([p for p in self.list_projects()])
        return {'bytes': total, 'files': files, 'projects': projects}

    # ---------- 内部 ----------

    def _folder_path(self, folder: str) -> Path:
        name = (folder or '').strip()
        if not name or name != Path(name).name or name in ('.', '..'):
            raise ValueError(f'非法项目文件夹名：{folder!r}')
        return self.root / name

    def _resolve_folder(self, folder: str | None, project_name: str) -> Path:
        """确定项目文件夹：不存在则按项目名创建；重命名时同步改名"""
        desired = slugify(project_name)
        if folder:
            current = self._folder_path(folder)
            if not current.exists():
                raise FileNotFoundError(f'项目文件夹不存在：{folder}')
            if current.name != desired:
                renamed = _unique_folder(self.root, desired)
                current.rename(renamed)
                return renamed
            return current
        target = _unique_folder(self.root, desired)
        target.mkdir(parents=True)
        return target

    def _write_manifest(self, folder: Path, manifest: dict) -> None:
        path = folder / _MANIFEST_NAME
        tmp = folder / f'{_MANIFEST_NAME}.tmp'
        tmp.write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
        os.replace(tmp, path)

    def _prune_blobs(self, blobs_dir: Path, manifest: dict) -> None:
        referenced = referenced_blob_names(manifest)
        for path in blobs_dir.iterdir():
            if path.is_file() and path.name not in referenced:
                path.unlink()

    def _write_app_state(self, project_id, folder, image_id) -> None:
        path = self.root / _APP_STATE_NAME
        tmp = self.root / f'{_APP_STATE_NAME}.tmp'
        tmp.write_text(
            json.dumps(
                {
                    'projectId': project_id,
                    'folder': folder,
                    'imageId': image_id,
                    'updatedAt': time.time() * 1000,
                },
                ensure_ascii=False,
            ),
            encoding='utf-8',
        )
        os.replace(tmp, path)
