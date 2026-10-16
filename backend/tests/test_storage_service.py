"""磁盘存储服务测试：保存/读取/重命名/清理/防目录穿越。"""

import json

import pytest

from app.services.storage_service import (
    StorageService,
    referenced_blob_names,
    slugify,
)


@pytest.fixture()
def storage(tmp_path):
    return StorageService(tmp_path / 'history')


def make_manifest(project_id: str, name: str, active_image: str | None = None) -> dict:
    return {
        'id': project_id,
        'name': name,
        'createdAt': 1000,
        'updatedAt': 2000,
        'activeImageId': active_image,
        'images': [
            {
                'id': 'img-1',
                'name': 'photo.png',
                'width': 100,
                'height': 50,
                'currentHistoryId': 2,
                'originNote': '',
                'createdAt': 1,
                'original': 'img-1.original',
                'thumb': 'img-1.thumb',
                'nodes': [
                    {
                        'id': 1,
                        'parentId': None,
                        'childIds': [2],
                        'op': {'type': 'import'},
                        'time': 1,
                        'label': '原图',
                        'regionIds': [],
                        'snapshot': 'img-1.n1.snapshot',
                        'thumb': 'img-1.n1.thumb',
                    },
                    {
                        'id': 2,
                        'parentId': 1,
                        'childIds': [],
                        'op': {'type': 'solid', 'params': {'color': [1, 2, 3]}},
                        'time': 2,
                        'label': '纯色替换',
                        'regionIds': ['rg-1'],
                        'snapshot': 'img-1.n2.snapshot',
                        'thumb': None,
                    },
                ],
                'regions': [
                    {
                        'id': 'rg-1',
                        'name': '人像',
                        'locked': True,
                        'order': 0,
                        'gray': 'rg-1.gray',
                        'thumb': 'rg-1.thumb',
                    }
                ],
            }
        ],
    }


def test_slugify_keeps_chinese_and_replaces_illegal():
    assert slugify('天依方卡') == '天依方卡'
    # 非法字符替换为下划线；首尾的 ._- 会被清理
    assert slugify('a/b:c*d?') == 'a_b_c_d'
    assert slugify('   ') == 'project'


def test_save_and_reload_project(storage):
    manifest = make_manifest('p1', '天依方卡', active_image='img-1')
    files = [
        ('img-1.original', b'original-bytes'),
        ('img-1.n2.snapshot', b'snapshot-bytes'),
        ('rg-1.gray', b'gray-bytes'),
    ]
    folder = storage.save_project(None, manifest, files)
    assert folder == '天依方卡'

    projects = storage.list_projects()
    assert len(projects) == 1
    assert projects[0]['name'] == '天依方卡'
    assert projects[0]['imageCount'] == 1

    loaded = storage.read_manifest(folder)
    assert loaded is not None
    assert loaded['images'][0]['nodes'][1]['regionIds'] == ['rg-1']

    blob_path = storage.read_blob_path(folder, 'img-1.n2.snapshot')
    assert blob_path.read_bytes() == b'snapshot-bytes'

    state = storage.read_app_state()
    assert state['folder'] == '天依方卡'
    assert state['imageId'] == 'img-1'


def test_save_prunes_unreferenced_blobs(storage):
    manifest = make_manifest('p1', '项目A')
    storage.save_project(
        None,
        manifest,
        [('img-1.original', b'x'), ('orphan-old.png', b'y'), ('rg-1.gray', b'g')],
    )
    # 未在清单中引用的孤儿文件应被清理
    blobs = storage.root / '项目A' / 'blobs'
    assert (blobs / 'img-1.original').exists()
    assert not (blobs / 'orphan-old.png').exists()


def test_rename_project_renames_folder(storage):
    manifest = make_manifest('p1', '旧名字')
    folder = storage.save_project(None, manifest, [])
    assert folder == '旧名字'
    manifest['name'] = '新名字'
    folder2 = storage.save_project(folder, manifest, [])
    assert folder2 == '新名字'
    assert not (storage.root / '旧名字').exists()
    assert (storage.root / '新名字' / 'project.json').exists()


def test_same_name_collision_gets_suffix(storage):
    storage.save_project(None, make_manifest('p1', '项目'), [])
    folder2 = storage.save_project(None, make_manifest('p2', '项目'), [])
    assert folder2 == '项目 (2)'


def test_rejects_directory_traversal(storage):
    with pytest.raises(ValueError):
        storage.read_blob_path('项目A', '../evil.txt')
    with pytest.raises(ValueError):
        storage.save_project('..', make_manifest('p1', 'x'), [])


def test_save_blobs_creates_folder(storage):
    manifest = make_manifest('p1', '迁移项目', active_image='img-1')
    storage.save_project(None, manifest, [])
    storage.save_blobs('迁移项目', [('img-1.original', b'chunked')])
    assert storage.read_blob_path('迁移项目', 'img-1.original').read_bytes() == b'chunked'


def test_referenced_names_collects_all(storage):
    names = referenced_blob_names(make_manifest('p1', 'x'))
    assert names == {
        'img-1.original',
        'img-1.thumb',
        'img-1.n1.snapshot',
        'img-1.n1.thumb',
        'img-1.n2.snapshot',
        'rg-1.gray',
        'rg-1.thumb',
    }


def test_usage_counts_bytes(storage):
    storage.save_project(None, make_manifest('p1', '项目'), [('a.bin', b'12345')])
    usage = storage.usage()
    assert usage['bytes'] > 5
    assert usage['projects'] == 1
    assert usage['files'] >= 2  # project.json + a.bin
