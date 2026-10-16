"""后台任务管理：推理在独立线程执行，避免阻塞请求处理；支持进度、取消与超时。"""

import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

FINAL_STATUSES = ('succeeded', 'failed', 'cancelled')


@dataclass
class Task:
    id: str
    name: str
    status: str = 'pending'  # pending / running / succeeded / failed / cancelled
    progress: float = 0.0
    message: str = '等待执行'
    error: str = ''
    result: Any = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    cancel_requested: bool = False
    timeout_exceeded: bool = False


class TaskCancelledError(Exception):
    """任务被用户取消或超时后由作业函数抛出。"""


class TaskManager:
    def __init__(self, timeout_seconds: float = 600.0) -> None:
        self._tasks: dict[str, Task] = {}
        self._lock = threading.Lock()
        self.timeout_seconds = timeout_seconds

    def create(self, name: str, job: Callable[[Task], Any]) -> Task:
        task = Task(id=uuid.uuid4().hex[:12], name=name)
        with self._lock:
            self._tasks[task.id] = task
            self._prune_locked()
        thread = threading.Thread(target=self._run, args=(task, job), daemon=True, name=f'task-{task.id}')
        thread.start()
        return task

    def _run(self, task: Task, job: Callable[[Task], Any]) -> None:
        task.status = 'running'
        task.started_at = time.time()
        task.message = '执行中'
        try:
            result = job(task)
            if task.timeout_exceeded:
                task.status = 'failed'
                task.error = f'任务超时（超过 {int(self.timeout_seconds)} 秒）'
                task.message = '超时'
            elif task.cancel_requested:
                task.status = 'cancelled'
                task.message = '已取消'
            else:
                task.result = result
                task.status = 'succeeded'
                task.progress = 1.0
                task.message = '完成'
        except TaskCancelledError:
            if task.timeout_exceeded:
                task.status = 'failed'
                task.error = f'任务超时（超过 {int(self.timeout_seconds)} 秒）'
                task.message = '超时'
            else:
                task.status = 'cancelled'
                task.message = '已取消'
        except Exception as exc:
            traceback.print_exc()
            task.status = 'failed'
            task.error = str(exc) or exc.__class__.__name__
            task.message = '失败'
        finally:
            task.finished_at = time.time()

    def get(self, task_id: str) -> Task | None:
        with self._lock:
            task = self._tasks.get(task_id)
        if task and task.status == 'running' and task.started_at:
            if time.time() - task.started_at > self.timeout_seconds:
                # 标记超时：作业函数中的 check_cancelled 会尽快中断；若已卡死则等线程结束
                task.timeout_exceeded = True
                task.cancel_requested = True
        return task

    def cancel(self, task_id: str) -> Task | None:
        task = self.get(task_id)
        if task and task.status in ('pending', 'running'):
            task.cancel_requested = True
            task.message = '正在取消…'
        return task

    def check_cancelled(self, task: Task) -> None:
        if task.cancel_requested:
            raise TaskCancelledError()

    def _prune_locked(self) -> None:
        if len(self._tasks) < 200:
            return
        finished = sorted(
            (t for t in self._tasks.values() if t.status in FINAL_STATUSES),
            key=lambda t: t.finished_at or t.created_at,
        )
        for task in finished[: len(finished) // 2]:
            self._tasks.pop(task.id, None)


task_manager = TaskManager()
