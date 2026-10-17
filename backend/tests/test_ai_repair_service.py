"""AI 修复服务测试：HTTP 全部 mock，不访问外部服务、不使用真实密钥。"""

import base64
import io
from unittest.mock import patch

import pytest
from PIL import Image

from app.services import ai_repair_service as service


def make_png(width=64, height=32, color=(20, 40, 80)) -> bytes:
    buf = io.BytesIO()
    Image.new('RGB', (width, height), color).save(buf, format='PNG')
    return buf.getvalue()


class FakeResponse:
    def __init__(self, status_code=200, payload=None, content=b'', text=''):
        self.status_code = status_code
        self._payload = payload
        self.content = content
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError('no json')
        return self._payload


def test_read_api_key(tmp_path):
    key_file = tmp_path / 'key.txt'
    key_file.write_text('sk-test-123\n', encoding='utf-8')
    assert service.read_api_key(key_file) == 'sk-test-123'


def test_read_api_key_missing(tmp_path):
    with pytest.raises(RuntimeError, match='未找到'):
        service.read_api_key(tmp_path / 'missing.txt')


def test_read_api_key_bad_format(tmp_path):
    key_file = tmp_path / 'key.txt'
    key_file.write_text('not-a-key', encoding='utf-8')
    with pytest.raises(RuntimeError, match='格式不正确'):
        service.read_api_key(key_file)


def test_pick_image_size():
    assert service.pick_image_size(1920, 1080) == '1536x1024'
    assert service.pick_image_size(1080, 1920) == '1024x1536'
    assert service.pick_image_size(1000, 1000) == '1024x1024'


def test_request_edit_b64_prefers_original_size():
    result_png = make_png(16, 16, (200, 30, 30))
    fake = FakeResponse(200, {'data': [{'b64_json': base64.b64encode(result_png).decode()}]})
    with patch('requests.post', return_value=fake) as post:
        out = service.request_edit(make_png(), '把皮肤调白', 'sk-test')
    call = post.call_args
    assert call.kwargs['headers'] == {'Authorization': 'Bearer sk-test'}
    assert call.kwargs['data']['model'] == 'gpt-image-2'
    assert call.kwargs['data']['quality'] == 'high'
    # 默认优先按原图分辨率请求
    assert call.kwargs['data']['size'] == '64x32'
    assert post.call_count == 1
    image = Image.open(io.BytesIO(out))
    assert image.size == (16, 16)


def test_request_edit_falls_back_when_original_size_rejected():
    result_png = make_png(10, 10)
    rejected = FakeResponse(400, None, text='{"error":{"message":"invalid size"}}')
    ok = FakeResponse(200, {'data': [{'b64_json': base64.b64encode(result_png).decode()}]})
    sent_sizes: list[str] = []

    def fake_post(*args, **kwargs):
        sent_sizes.append(kwargs['data']['size'])
        return rejected if len(sent_sizes) == 1 else ok

    with patch('requests.post', side_effect=fake_post):
        out = service.request_edit(make_png(64, 32), 'p', 'sk-test')
    assert sent_sizes == ['64x32', '1536x1024']
    assert Image.open(io.BytesIO(out)).size == (10, 10)


def test_request_edit_supported_size_only_when_disabled(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, 'openlux_prefer_original_size', False)
    result_png = make_png(4, 4)
    fake = FakeResponse(200, {'data': [{'b64_json': base64.b64encode(result_png).decode()}]})
    with patch('requests.post', return_value=fake) as post:
        service.request_edit(make_png(64, 32), 'p', 'sk-test')
    assert post.call_args.kwargs['data']['size'] == '1536x1024'


def test_request_edit_does_not_swallow_auth_errors():
    fake = FakeResponse(401, None, text='unauthorized')
    with patch('requests.post', return_value=fake) as post:
        with pytest.raises(RuntimeError, match='401'):
            service.request_edit(make_png(64, 32), 'p', 'sk-test')
    assert post.call_count == 1


def test_request_edit_url():
    result_png = make_png(8, 8)
    fake_post = FakeResponse(200, {'data': [{'url': 'https://cdn.example.com/x.png'}]})
    fake_get = FakeResponse(200, content=result_png)
    with patch('requests.post', return_value=fake_post), patch(
        'requests.get', return_value=fake_get
    ):
        out = service.request_edit(make_png(), 'p', 'sk-test')
    assert Image.open(io.BytesIO(out)).size == (8, 8)


def test_request_edit_http_error():
    fake = FakeResponse(401, None, text='{"error":{"message":"invalid key"}}')
    with patch('requests.post', return_value=fake):
        with pytest.raises(RuntimeError, match='401'):
            service.request_edit(make_png(), 'p', 'sk-test')


def test_request_edit_empty_data():
    fake = FakeResponse(200, {'data': []})
    with patch('requests.post', return_value=fake):
        with pytest.raises(RuntimeError, match='未返回图片'):
            service.request_edit(make_png(), 'p', 'sk-test')


def test_transparent_image_is_flattened_to_white():
    buf = io.BytesIO()
    Image.new('RGBA', (10, 10), (0, 0, 0, 0)).save(buf, format='PNG')
    flat, width, height = service._to_rgb_png(buf.getvalue())
    assert (width, height) == (10, 10)
    image = Image.open(io.BytesIO(flat)).convert('RGB')
    assert image.getpixel((5, 5)) == (255, 255, 255)
