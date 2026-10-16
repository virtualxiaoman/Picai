"""下载所需模型权重到项目 models 目录。

- BiRefNet：HuggingFace 官方仓库（经 .env 中配置的代理）
- SAM 3：建议使用魔搭（ModelScope）本地下载，见 README：
    .venv/Scripts/modelscope.exe download --model facebook/sam3 \
        --include "*.json" "*.txt" "*.md" "*.safetensors" "LICENSE" --local_dir models/sam3

用法：.venv/Scripts/python.exe scripts/download_models.py [模型名...]
    不带参数时下载全部。
"""

import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / 'backend'))

from app.core.config import settings  # noqa: E402

MODELS = {
    'birefnet': ('ZhengPeng7/BiRefNet', ['*.md', '.gitattributes', '*.png', '*.jpg']),
}


def main() -> int:
    os.environ.setdefault('HF_HOME', str(settings.hf_home))
    if settings.hf_proxy:
        os.environ.setdefault('HTTP_PROXY', settings.hf_proxy)
        os.environ.setdefault('HTTPS_PROXY', settings.hf_proxy)

    from huggingface_hub import snapshot_download

    targets = sys.argv[1:] or list(MODELS.keys())
    failed = []
    for name in targets:
        if name not in MODELS:
            print(f'未知模型：{name}（可选：{", ".join(MODELS)}）')
            failed.append(name)
            continue
        repo_id, ignore = MODELS[name]
        print(f'==> 下载 {name}: {repo_id}')
        try:
            path = snapshot_download(repo_id, ignore_patterns=ignore)
            print(f'    完成：{path}')
        except Exception as exc:
            print(f'    失败：{exc}')
            failed.append(name)
    if failed:
        print(f'\n以下模型下载失败：{", ".join(failed)}')
        return 1
    print('\n全部模型下载完成。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
