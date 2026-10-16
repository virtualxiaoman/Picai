"""后台任务管理测试：成功、失败、取消与超时。"""

import threading
import time


from app.services.task_manager import Task, TaskManager


def _wait(task: Task, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while task.status not in ('succeeded', 'failed', 'cancelled') and time.time() < deadline:
        time.sleep(0.01)


def test_task_success_and_progress() -> None:
    tm = TaskManager()

    def job(task: Task) -> bytes:
        task.progress = 0.5
        task.message = '半程'
        return b'result'

    task = tm.create('demo', job)
    _wait(task)
    assert task.status == 'succeeded'
    assert task.result == b'result'
    assert task.progress == 1.0


def test_task_failure_records_error() -> None:
    tm = TaskManager()

    def job(task: Task) -> bytes:
        raise RuntimeError('显存不足')

    task = tm.create('demo', job)
    _wait(task)
    assert task.status == 'failed'
    assert '显存不足' in task.error


def test_task_cancel_cooperative() -> None:
    tm = TaskManager()
    started = threading.Event()

    def job(task: Task) -> bytes:
        started.set()
        while True:
            tm.check_cancelled(task)
            time.sleep(0.01)

    task = tm.create('loop', job)
    assert started.wait(2.0)
    tm.cancel(task.id)
    _wait(task)
    assert task.status == 'cancelled'


def test_task_timeout_marks_failed() -> None:
    tm = TaskManager(timeout_seconds=0.15)

    def job(task: Task) -> bytes:
        while True:
            tm.check_cancelled(task)
            time.sleep(0.01)

    task = tm.create('slow', job)
    deadline = time.time() + 5
    while task.status not in ('succeeded', 'failed', 'cancelled') and time.time() < deadline:
        tm.get(task.id)  # 轮询会触发超时标记
        time.sleep(0.02)
    assert task.status == 'failed'
    assert '超时' in task.error


def test_unknown_task_returns_none() -> None:
    tm = TaskManager()
    assert tm.get('不存在') is None
    assert tm.cancel('不存在') is None
