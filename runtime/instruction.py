import argparse
import json
import os
import platform
import random
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except AttributeError:
    pass

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}
TEXT_EXTENSIONS = {
    ".txt", ".py", ".js", ".ts", ".tsx", ".jsx", ".md", ".html", ".css",
    ".json", ".xml", ".yaml", ".yml", ".toml", ".ini", ".ps1", ".sh", ".bat",
    ".c", ".cpp", ".h", ".hpp", ".cs", ".java", ".go", ".rs", ".php", ".rb",
}

LOCK_STALE_MS = 15000
LOCK_WAIT_SECONDS = 5
DEFAULT_SETTINGS = {
    "waitTimeoutSeconds": 0,
    "keepaliveSeconds": 300,
    "offlineAfterSeconds": 15,
    "maxConcurrentSessions": 4,
    "schedulingMode": "direct",
    "perSessionQueueLimit": 3,
    "globalQueueLimit": 20,
    "pollSeconds": 0.2,
    "historyLimit": 200,
    "imageLimit": 50,
    "imageMaxDimension": 2000,
    "notifyOnAttention": True,
}

# --- Windows-safe filesystem helpers ------------------------------------------
# On Windows, renaming a temp file over an existing target (our "atomic write")
# fails with PermissionError / [WinError 5] 拒绝访问 / [WinError 32] whenever the
# target is momentarily held open by another process: another waiter, the panel
# reader inside the extension host, antivirus, or the search indexer. Reads that
# race with a concurrent rename can fail the same way. These failures are
# transient, so we retry with a short jittered backoff instead of letting the
# waiter crash -- crashing on every collision is what produced the multi-session
# "拒绝访问" errors when several sessions ran at once.
RENAME_RETRY_ATTEMPTS = 24
RENAME_RETRY_BASE_DELAY = 0.015
RENAME_RETRY_MAX_DELAY = 0.30
BEST_EFFORT_ATTEMPTS = 6
READ_RETRY_ATTEMPTS = 6


def is_transient_fs_error(error):
    if isinstance(error, PermissionError):
        return True
    if getattr(error, "winerror", None) in (5, 32, 33):
        return True
    if getattr(error, "errno", None) in (13, 16):
        return True
    return False


def retry_transient(action, attempts=RENAME_RETRY_ATTEMPTS,
                    base_delay=RENAME_RETRY_BASE_DELAY,
                    max_delay=RENAME_RETRY_MAX_DELAY):
    delay = base_delay
    last_error = None
    for attempt in range(attempts):
        try:
            return action()
        except OSError as error:
            if not is_transient_fs_error(error):
                raise
            last_error = error
            if attempt == attempts - 1:
                break
            time.sleep(min(delay, max_delay) * (0.5 + random.random()))
            delay = min(delay * 1.7, max_delay)
    if last_error is not None:
        raise last_error


def now_ms():
    return int(time.time() * 1000)


def iso_now():
    # UTC ISO-8601 with milliseconds + 'Z', matching the Node runtime's
    # Date.toISOString() so both runtimes write identical timestamp formats.
    t = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int((t % 1) * 1000):03d}Z"


def safe_session_id(value):
    raw = str(value or "").strip().lower()
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in raw)
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    return cleaned[:48] or "agent-1"


def normalize_payload(item):
    if isinstance(item, str):
        return {
            "status": "continue",
            "user_input": item,
            "selected_choice": None,
            "file_paths": [],
            "image_paths": [],
            "suggested_tools": [],
        }
    if not isinstance(item, dict):
        return normalize_payload("")
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else item
    return {
        "status": payload.get("status") or "continue",
        "user_input": str(payload.get("user_input") or item.get("message") or ""),
        "selected_choice": payload.get("selected_choice"),
        "file_paths": [str(x) for x in payload.get("file_paths") or [] if x],
        "image_paths": [str(x) for x in payload.get("image_paths") or [] if x],
        "suggested_tools": [str(x) for x in payload.get("suggested_tools") or [] if x],
    }


class ProjectState:
    def __init__(self, state_dir):
        self.state_dir = Path(state_dir).resolve()
        self.sessions_dir = self.state_dir / "sessions"
        self.sessions_path = self.state_dir / "sessions.json"
        self.settings_path = self.state_dir / "settings.json"
        self.global_queue_path = self.state_dir / "global_queue.json"
        self.global_queue_lock = self.state_dir / ".global_queue.lock"
        self.history_path = self.state_dir / "history.jsonl"

    def ensure(self):
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)

    def read_json(self, path, fallback):
        for attempt in range(READ_RETRY_ATTEMPTS):
            try:
                with open(path, "r", encoding="utf-8-sig") as file:
                    return json.load(file)
            except (FileNotFoundError, json.JSONDecodeError):
                return fallback
            except OSError as error:
                if not is_transient_fs_error(error) or attempt == READ_RETRY_ATTEMPTS - 1:
                    return fallback
                time.sleep(0.02 * (attempt + 1))
        return fallback

    def write_json_atomic(self, path, data, attempts=RENAME_RETRY_ATTEMPTS):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
        try:
            with open(tmp, "w", encoding="utf-8") as file:
                json.dump(data, file, ensure_ascii=False, indent=2)
            retry_transient(lambda: os.replace(tmp, path), attempts=attempts)
        finally:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass

    def write_json_best_effort(self, path, data):
        try:
            self.write_json_atomic(path, data, attempts=BEST_EFFORT_ATTEMPTS)
            return True
        except OSError:
            return False

    def settings(self):
        data = self.read_json(self.settings_path, {})
        settings = dict(DEFAULT_SETTINGS)
        settings.update(data if isinstance(data, dict) else {})
        return settings

    def acquire_lock(self, lock_dir, timeout_seconds=LOCK_WAIT_SECONDS, stale_ms=LOCK_STALE_MS):
        self.ensure()
        started = time.time()
        token = f"{os.getpid()}.{uuid.uuid4().hex}"
        while True:
            try:
                lock_dir.mkdir(parents=True, exist_ok=False)
                # Stamp ownership so release_lock only deletes a lock we still hold:
                # after a stale-takeover the original owner must not delete the
                # successor's lock.
                try:
                    (lock_dir / "owner").write_text(token, encoding="utf-8")
                except OSError:
                    pass
                return token
            except FileExistsError:
                try:
                    age_ms = now_ms() - int(lock_dir.stat().st_mtime * 1000)
                    if age_ms > stale_ms:
                        shutil.rmtree(lock_dir, ignore_errors=True)
                        continue
                except FileNotFoundError:
                    continue
                if time.time() - started > timeout_seconds:
                    raise RuntimeError(f"lock timeout: {lock_dir}")
                time.sleep(0.04)

    def release_lock(self, lock_dir, token=None):
        # With a token, only remove the lock if we still own it (don't delete a
        # successor's lock after a stale-takeover). Without one, keep old behavior.
        if token:
            try:
                current = (lock_dir / "owner").read_text(encoding="utf-8")
            except OSError:
                current = None
            if current is not None and current != token:
                return
        shutil.rmtree(lock_dir, ignore_errors=True)

    def append_history(self, record, limit=None):
        self.ensure()
        line = json.dumps(record, ensure_ascii=False) + "\n"

        def _write():
            with open(self.history_path, "a", encoding="utf-8") as file:
                file.write(line)

        try:
            retry_transient(_write, attempts=BEST_EFFORT_ATTEMPTS)
        except OSError:
            return
        self.trim_jsonl(self.history_path, limit or int(self.settings().get("historyLimit", 200)))

    def trim_jsonl(self, path, limit):
        if limit <= 0:
            return
        try:
            path = Path(path)
            with open(path, "r", encoding="utf-8") as file:
                lines = [line for line in file.read().splitlines() if line]
            if len(lines) <= limit:
                return
            # Atomic rewrite (tmp + rename) so a concurrent append from another
            # process can't be clobbered by a partial trim write.
            tmp = path.with_suffix(f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
            try:
                with open(tmp, "w", encoding="utf-8") as file:
                    file.write("\n".join(lines[-limit:]) + "\n")
                retry_transient(lambda: os.replace(tmp, path), attempts=BEST_EFFORT_ATTEMPTS)
            finally:
                try:
                    if os.path.exists(tmp):
                        os.remove(tmp)
                except OSError:
                    pass
        except OSError:
            return

    def sessions_index(self):
        data = self.read_json(self.sessions_path, {"sessions": [], "roundRobinIndex": 0})
        if not isinstance(data, dict):
            data = {"sessions": [], "roundRobinIndex": 0}
        if not isinstance(data.get("sessions"), list):
            data["sessions"] = []
        if not isinstance(data.get("roundRobinIndex"), int):
            data["roundRobinIndex"] = 0
        return data

    def save_sessions_index(self, index):
        self.write_json_atomic(self.sessions_path, index)

    def register_session(self, session_id, name=None):
        self.ensure()
        session_id = safe_session_id(session_id)
        index = self.sessions_index()
        existing = next((item for item in index["sessions"] if item.get("id") == session_id), None)
        if existing:
            if name and existing.get("name") != name:
                existing["name"] = name
                self.save_sessions_index(index)
            return existing
        item = {
            "id": session_id,
            "name": name or session_id,
            "created_at": iso_now(),
            "created_at_ms": now_ms(),
        }
        index["sessions"].append(item)
        self.save_sessions_index(index)
        SessionState(self, session_id).ensure()
        return item

    def session(self, session_id):
        session_id = safe_session_id(session_id)
        self.register_session(session_id)
        return SessionState(self, session_id)

    def normalize_queue(self, data):
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and isinstance(data.get("messages"), list):
            return data["messages"]
        if isinstance(data, dict) and (data.get("payload") or data.get("message") or data.get("id")):
            return [data]
        return []

    def read_global_queue(self):
        return self.normalize_queue(self.read_json(self.global_queue_path, []))

    def enqueue_global(self, payload, source="manual"):
        lock_token = self.acquire_lock(self.global_queue_lock)
        try:
            queue = self.read_global_queue()
            limit = int(self.settings().get("globalQueueLimit", 20) or 20)
            if len(queue) >= limit:
                raise RuntimeError(f"空闲优先队列已达到上限 {limit}。")
            item = make_queue_item(payload, source, target="idle-first")
            queue.append(item)
            self.write_json_atomic(self.global_queue_path, queue)
        finally:
            self.release_lock(self.global_queue_lock, lock_token)
        self.append_history({"type": "queued_global", **item})
        return item

    def pop_global(self):
        # Peek without the lock first: when idle (the common case) this avoids
        # creating/removing the lock directory on every poll, which removes most
        # of the cross-process filesystem contention.
        if not self.read_global_queue():
            return None, 0, True
        lock_token = None
        try:
            lock_token = self.acquire_lock(self.global_queue_lock)
            queue = self.read_global_queue()
            if not queue:
                return None, 0, True
            item = queue.pop(0)
            self.write_json_atomic(self.global_queue_path, queue)
            return item, len(queue), True
        except Exception:
            # Lock busy or write failed -> inconclusive; retry without advancing
            # the queue signature so the item is not skipped.
            return None, 0, False
        finally:
            if lock_token:
                self.release_lock(self.global_queue_lock, lock_token)

    def clear_global(self):
        lock_token = self.acquire_lock(self.global_queue_lock)
        try:
            self.write_json_atomic(self.global_queue_path, [])
        finally:
            self.release_lock(self.global_queue_lock, lock_token)
        self.append_history({"type": "global_queue_cleared", "at": iso_now()})

    def status_summary(self):
        settings = self.settings()
        offline_after_ms = int(settings.get("offlineAfterSeconds", 15)) * 1000
        sessions = []
        for item in self.sessions_index()["sessions"]:
            session = SessionState(self, item.get("id"))
            sessions.append(session.summary(item, offline_after_ms))
        return {
            "settings": settings,
            "sessions": sessions,
            "global_queue_length": len(self.read_global_queue()),
        }


class SessionState:
    def __init__(self, project, session_id):
        self.project = project
        self.session_id = safe_session_id(session_id)
        self.dir = project.sessions_dir / self.session_id
        self.queue_path = self.dir / "queue.json"
        self.status_path = self.dir / "status.json"
        self.history_path = self.dir / "history.jsonl"
        self.queue_lock_dir = self.dir / ".queue.lock"
        self.waiter_lock_dir = self.dir / "waiter.lock"
        self.presence_path = self.dir / "presence.json"

    def ensure(self):
        self.dir.mkdir(parents=True, exist_ok=True)

    def read_json(self, path, fallback):
        return self.project.read_json(path, fallback)

    def write_json_atomic(self, path, data):
        self.project.write_json_atomic(path, data)

    def write_json_best_effort(self, path, data):
        return self.project.write_json_best_effort(path, data)

    def queue(self):
        return self.project.normalize_queue(self.read_json(self.queue_path, []))

    def append_history(self, record):
        self.ensure()
        line = json.dumps(record, ensure_ascii=False) + "\n"

        def _write():
            with open(self.history_path, "a", encoding="utf-8") as file:
                file.write(line)

        try:
            retry_transient(_write, attempts=BEST_EFFORT_ATTEMPTS)
        except OSError:
            return
        self.project.trim_jsonl(self.history_path, int(self.project.settings().get("historyLimit", 200)))

    def enqueue(self, payload, source="manual"):
        lock_token = self.project.acquire_lock(self.queue_lock_dir)
        try:
            queue = self.queue()
            limit = int(self.project.settings().get("perSessionQueueLimit", 3) or 3)
            if len(queue) >= limit:
                raise RuntimeError(f"{self.session_id} 的队列已达到上限 {limit}。")
            item = make_queue_item(payload, source, target=self.session_id)
            queue.append(item)
            self.write_json_atomic(self.queue_path, queue)
        finally:
            self.project.release_lock(self.queue_lock_dir, lock_token)
        self.append_history({"type": "queued", **item})
        self.project.append_history({"type": "queued_session", "session_id": self.session_id, **item})
        return item

    def pop_next(self):
        # Peek without the lock first; only contend for the lock when there is
        # actually something to pop. This keeps an idle waiter from creating and
        # deleting the queue lock directory several times per second.
        if not self.queue():
            return None, 0, True
        lock_token = None
        try:
            lock_token = self.project.acquire_lock(self.queue_lock_dir)
            queue = self.queue()
            if not queue:
                return None, 0, True
            item = queue.pop(0)
            self.write_json_atomic(self.queue_path, queue)
            return item, len(queue), True
        except Exception:
            # Lock busy or write failed -> inconclusive; retry without advancing
            # the queue signature so the item is not skipped.
            return None, 0, False
        finally:
            if lock_token:
                self.project.release_lock(self.queue_lock_dir, lock_token)

    def current_waiter(self):
        return self.read_json(self.waiter_lock_dir / "owner.json", None)

    def write_waiter_owner(self, run_id):
        owner = {
            "pid": os.getpid(),
            "session_id": self.session_id,
            "run_id": run_id,
            "heartbeat_ms": now_ms(),
            "heartbeat_at": iso_now(),
        }
        ok = self.write_json_best_effort(self.waiter_lock_dir / "owner.json", owner)
        return ok, owner

    def acquire_waiter(self, run_id):
        self.ensure()
        while True:
            try:
                self.waiter_lock_dir.mkdir(parents=True, exist_ok=False)
            except FileExistsError:
                owner = self.current_waiter() or {}
                heartbeat_ms = int(owner.get("heartbeat_ms", 0) or 0)
                age_ms = now_ms() - heartbeat_ms if heartbeat_ms else LOCK_STALE_MS + 1
                if age_ms > LOCK_STALE_MS:
                    shutil.rmtree(self.waiter_lock_dir, ignore_errors=True)
                    continue
                return False, owner
            # We hold the lock dir; persist ownership or back out so a missing
            # owner.json can't be misread as a stale lock by a rival waiter.
            ok, owner = self.write_waiter_owner(run_id)
            if not ok:
                shutil.rmtree(self.waiter_lock_dir, ignore_errors=True)
                return False, owner
            return True, owner

    def refresh_waiter(self, run_id):
        owner = self.current_waiter() or {}
        if owner.get("run_id") == run_id:
            self.write_waiter_owner(run_id)

    def release_waiter(self, run_id):
        owner = self.current_waiter() or {}
        if owner.get("run_id") == run_id:
            shutil.rmtree(self.waiter_lock_dir, ignore_errors=True)

    def write_status(self, run_id, state, **extra):
        status = self.read_json(self.status_path, {})
        status.update({
            "protocol": 6,
            "session_id": self.session_id,
            "run_id": run_id,
            "state": state,
            "pid": os.getpid(),
            "heartbeat_ms": now_ms(),
            "heartbeat_at": iso_now(),
            "queue_length": len(self.queue()),
            "queue_path": str(self.queue_path),
            "status_path": str(self.status_path),
            "waiter": self.current_waiter(),
        })
        status.update(extra)
        self.write_json_best_effort(self.status_path, status)

    def record_result(self, summary, result_status="done", run_id=None):
        # Called when the agent reports what it just finished (via `wait --report`).
        # Persists a short summary into status.json + history so the panel can show
        # per-session results without the user opening each Cursor chat.
        text = str(summary or "").strip()
        if not text:
            return
        if result_status not in ("done", "need_input", "error"):
            result_status = "done"
        self.append_history({
            "type": "result",
            "session_id": self.session_id,
            "run_id": run_id,
            "status": result_status,
            "summary": text[:2000],
            "at": iso_now(),
        })
        self.project.append_history({
            "type": "result",
            "session_id": self.session_id,
            "status": result_status,
            "summary_preview": text[:240],
            "at": iso_now(),
        })
        status = self.read_json(self.status_path, {})
        status.update({
            "last_result": text[:1000],
            "last_result_status": result_status,
            "last_result_at": iso_now(),
            "last_result_at_ms": now_ms(),
        })
        self.write_json_best_effort(self.status_path, status)

    def status(self):
        status = self.read_json(self.status_path, {})
        status["queue_length"] = len(self.queue())
        return status

    def summary(self, index_item, offline_after_ms):
        status = self.status()
        heartbeat_ms = int(status.get("heartbeat_ms", 0) or 0)
        heartbeat_age_ms = now_ms() - heartbeat_ms if heartbeat_ms else None
        connected = (
            status.get("state") == "waiting"
            and heartbeat_age_ms is not None
            and heartbeat_age_ms <= offline_after_ms
        )
        return {
            "id": self.session_id,
            "name": index_item.get("name") or self.session_id,
            "created_at": index_item.get("created_at"),
            "state": status.get("state") or "new",
            "connected": connected,
            "heartbeat_age_ms": heartbeat_age_ms,
            "queue_length": len(self.queue()),
            "last_ack_id": status.get("last_ack_id") or "",
            "last_ack_at": status.get("last_ack_at") or "",
            "last_message_preview": status.get("last_message_preview") or "",
            "conversation_id": status.get("conversation_id") or "",
            "workspace_label": status.get("workspace_label") or "",
            "waiter": status.get("waiter"),
        }


def make_queue_item(payload, source, target):
    normalized = normalize_payload(payload)
    return {
        "id": uuid.uuid4().hex,
        "payload": normalized,
        "message": normalized["user_input"],
        "source": source,
        "target": target,
        "created_at": iso_now(),
        "created_at_ms": now_ms(),
        "pid": os.getpid(),
    }


MAX_TEXT_CONTEXT_BYTES = 256 * 1024


def read_text_file(file_path):
    try:
        size = os.path.getsize(file_path)
        with open(file_path, "rb") as binary_file:
            raw = binary_file.read(MAX_TEXT_CONTEXT_BYTES)
        content = raw.decode("utf-8", errors="ignore")
        if size > MAX_TEXT_CONTEXT_BYTES:
            # Cap inlined attachment context so an oversized file can't flood the
            # agent's stdout / memory; show only the first chunk.
            content += f"\n[...内容过长已截断：文件共 {size} 字节，仅显示前 {MAX_TEXT_CONTEXT_BYTES} 字节...]"
        return content
    except OSError as error:
        return f"[读取失败: {error}]"


def render_file_context(file_path):
    path_obj = Path(file_path).expanduser()
    if path_obj.is_dir():
        try:
            children = sorted(str(child) for child in path_obj.iterdir())
        except OSError as error:
            children = [f"[读取目录失败: {error}]"]
        listing = "\n".join(children[:300])
        return f"\n\n[目录上下文: {path_obj}]\n{listing}\n[/目录上下文]"
    if not path_obj.is_file():
        return f"\n\n[文件不存在: {path_obj}]"
    if path_obj.suffix.lower() in IMAGE_EXTENSIONS:
        return render_image_context(path_obj)
    if path_obj.suffix.lower() not in TEXT_EXTENSIONS:
        return f"\n\n[附件路径: {path_obj}]"
    content = read_text_file(path_obj)
    return f"\n\n[文件上下文: {path_obj}]\n{content}\n[/文件上下文]"


def render_image_context(file_path):
    # The pasted image is already saved on disk by the extension. Hand the agent
    # the file path and let it open the image with its native file-read tool,
    # which is what actually feeds the picture into the model's vision. Dumping
    # the base64 inline (the old behaviour) bloated stdout by ~1MB+ per image and
    # an LLM cannot "see" an image from base64 text anyway.
    path_obj = Path(file_path).expanduser()
    if not path_obj.is_file():
        return f"\n\n[图片不存在: {path_obj}]"
    try:
        path_obj = path_obj.resolve()
    except OSError:
        pass
    return (
        f"\n\n[图片上下文: {path_obj.name}]\n"
        f"图片已保存到本地。请使用 Read / 读取文件工具打开下面的路径来查看图像内容"
        f"（这是真实的图片文件，不要当作纯文本或尝试手动解码）：\n"
        f"{path_obj}\n"
        f"[/图片上下文]"
    )


def render_payload(payload):
    parts = []
    status = payload.get("status") or "continue"
    if status == "stop":
        return "stop"
    if payload.get("selected_choice"):
        parts.append(f"已选择: {payload['selected_choice']}")
    if payload.get("user_input"):
        parts.append(payload["user_input"])
    for file_path in payload.get("file_paths") or []:
        parts.append(render_file_context(file_path))
    for image_path in payload.get("image_paths") or []:
        parts.append(render_image_context(image_path))
    if payload.get("suggested_tools"):
        parts.append("\n建议工具: " + ", ".join(payload["suggested_tools"]))
    return "\n".join(part for part in parts if part).strip()


import random as _random


def _generate_keepalive_instruction():
    r = _random.random()
    if r < 0.6:
        a = _random.randint(1, 20)
        b = _random.randint(1, 20)
        ops = [
            (f"{a} + {b}", str(a + b)),
            (f"{a} - {b}", str(a - b)),
            (f"{a} × {b}", str(a * b)),
        ]
        expr, _ = ops[_random.randint(0, 2)]
        return f"请计算：{expr} = ?"
    questions = [
        "水的沸点是多少度？",
        "地球到月球大约多少公里？",
        "一年有多少天？",
        "光速大约是多少米每秒？",
        "地球有几个大洲？",
        "太阳系有几颗行星？",
        "中国的首都是哪里？",
        "一年有多少个月？",
        "一周有多少天？",
        "一公里等于多少米？",
    ]
    return _random.choice(questions)


def keepalive_message(session_id, interactive=False, rerun_cmd=None):
    if interactive:
        question = _generate_keepalive_instruction()
        cmd = f"\n\n请立即执行以下命令重新进入等待：\n{rerun_cmd}" if rerun_cmd else "\n请立刻重新运行同一条 wait 命令"
        return f"""KEEPALIVE_NOOP:
当前没有新的用户指令。为保持对话活跃，请简短回答以下问题，然后重新进入等待：

{question}

请不要修改项目。回答后{cmd}，继续等待会话 {session_id} 的下一条插件消息。"""
    return f"""KEEPALIVE_NOOP:
当前没有新的用户指令。请不要修改项目，也不要总结，只需要继续保持这个 Cursor 对话可用。
请立刻重新运行同一条 wait 命令，继续等待会话 {session_id} 的下一条插件消息。"""


def session_busy_message(session_id, owner_pid=None):
    pid = f"pid {owner_pid}" if owner_pid else "另一个进程"
    # Keep the English phrase below so any older detection still matches.
    return f"""SESSION_BUSY:
会话 {session_id} 已有一个活动的等待进程（{pid}），通常是另一个 Cursor 对话也在用同一个 session-id。
为避免两个对话互相抢消息，同一个会话同时只允许一个 wait（another instruction waiter is already active for this session）。
请不要重复运行 wait、也不要去结束其它进程；请在续聊助手面板为本对话新建一个会话并复制其启动指令重开本循环，或让本对话改用一个唯一的 --session-id。"""


def queue_signature(path):
    # (mtime_ns, size) changes whenever the panel writes the queue file. Lets an
    # idle waiter skip re-reading/parsing the queue JSON on every poll when nothing
    # changed; a missing file returns None (also a valid, comparable signature).
    try:
        stat_result = os.stat(path)
        return (stat_result.st_mtime_ns, stat_result.st_size)
    except OSError:
        return None


def build_rerun_cmd(project, session_id, timeout_seconds, keepalive_seconds, poll_seconds,
                     report, report_status, interactive_keepalive, bridge_config):
    import sys as _sys
    script = _sys.argv[0] if _sys.argv else ""
    state_dir = project.state_dir
    parts = [
        f'python "{script}" wait',
        f'--state-dir "{state_dir}"',
        f'--session-id {session_id}',
        f'--keepalive {keepalive_seconds}',
        f'--timeout {timeout_seconds}',
        f'--poll {poll_seconds}',
    ]
    if interactive_keepalive:
        parts.append("--interactive-keepalive")
    if bridge_config and bridge_config.get("port") and bridge_config.get("secret"):
        parts.append(f'--bridge-port {bridge_config["port"]}')
        parts.append(f'--bridge-secret "{bridge_config["secret"]}"')
    if report:
        parts.append(f'--report "{report}"')
    if report_status and report_status != "done":
        parts.append(f'--report-status {report_status}')
    return " ".join(parts)


# --- Presence beacon ----------------------------------------------------------
# A tiny detached process the waiter launches transparently. It heartbeats a
# presence file for the whole session lifetime and self-terminates when the
# launching shell dies (terminal closed / conversation interrupted), so the panel
# can tell "working" (beacon alive, no waiter) from "interrupted" (beacon gone)
# in seconds instead of guessing from a time threshold.
BEACON_INTERVAL_MS = 4000
BEACON_STALE_MS = 12000
BEACON_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000


def _pid_alive(pid):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return True
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def spawn_beacon_if_needed(project, session):
    try:
        existing = session.read_json(session.presence_path, None)
        if existing and int(existing.get("heartbeat_ms", 0) or 0) \
                and (now_ms() - int(existing.get("heartbeat_ms", 0))) <= BEACON_STALE_MS \
                and _pid_alive(existing.get("pid")):
            return
        script = sys.argv[0] if sys.argv else ""
        if not script:
            return
        cmd = [sys.executable, script, "beacon",
               "--state-dir", str(project.state_dir),
               "--session-id", session.session_id,
               "--watch-ppid", str(os.getppid() or 0),
               "--interval", str(BEACON_INTERVAL_MS // 1000)]
        kwargs = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL, close_fds=True)
        if os.name == "nt":
            kwargs["creationflags"] = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED|NEW_GROUP|NO_WINDOW
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen(cmd, **kwargs)
    except Exception:  # noqa: BLE001 - best effort; panel falls back to time threshold
        pass


def run_beacon(project, session_id, watch_ppid, interval_ms):
    session = project.session(session_id)
    existing = session.read_json(session.presence_path, None)
    if existing and existing.get("pid") != os.getpid() and int(existing.get("heartbeat_ms", 0) or 0) \
            and (now_ms() - int(existing.get("heartbeat_ms", 0))) <= BEACON_STALE_MS \
            and _pid_alive(existing.get("pid")):
        return 0
    stop = {"v": False}

    def _on_signal(_signum, _frame):
        stop["v"] = True

    for _sig in (getattr(signal, "SIGTERM", None), getattr(signal, "SIGINT", None)):
        if _sig is not None:
            try:
                signal.signal(_sig, _on_signal)
            except Exception:  # noqa: BLE001 - some platforms restrict signal handlers
                pass
    interval = max(1.0, (interval_ms or BEACON_INTERVAL_MS) / 1000.0)
    started = time.time()
    ppid = int(watch_ppid or 0)
    while not stop["v"]:
        if ppid > 0 and not _pid_alive(ppid):
            break
        if (time.time() - started) * 1000 > BEACON_MAX_LIFETIME_MS:
            break
        session.write_json_best_effort(session.presence_path, {
            "beacon": True,
            "pid": os.getpid(),
            "watch_ppid": ppid,
            "heartbeat_ms": now_ms(),
            "heartbeat_at": iso_now(),
            "interval_ms": int(interval * 1000),
        })
        time.sleep(interval)
    return 0


def wait_for_instruction(project, session_id, timeout_seconds, keepalive_seconds, poll_seconds,
                         report=None, report_status="done", interactive_keepalive=False, bridge_config=None):
    session_id = safe_session_id(session_id)
    project.register_session(session_id)
    session = project.session(session_id)
    run_id = uuid.uuid4().hex
    if report:
        session.record_result(report, report_status, run_id)
    acquired, owner = session.acquire_waiter(run_id)
    if not acquired:
        session.write_status(run_id, "busy", last_error="another waiter is already active", active_waiter=owner)
        print(session_busy_message(session_id, (owner or {}).get("pid")))
        return 3

    started_at_ms = now_ms()
    deadline = None if timeout_seconds <= 0 else time.time() + timeout_seconds
    keepalive_deadline = None if keepalive_seconds <= 0 else time.time() + keepalive_seconds
    # The heartbeat (waiter owner + status writes) only needs to stay well below
    # the offline cutoff and the stale-lock window. Writing it on every poll
    # (~5x/sec by default) was the main source of cross-process rename
    # contention, so throttle it while still polling the queue at full speed for
    # low instruction latency.
    offline_after = float(project.settings().get("offlineAfterSeconds", 15) or 15)
    heartbeat_interval = max(1.0, min(5.0, offline_after / 3.0, LOCK_STALE_MS / 3000.0))
    # Auto-capture the Cursor conversation identity from the agent terminal's
    # environment (Cursor sets these for its agent-exec terminals), so the panel
    # can show / reference the exact chat with zero manual entry and without
    # touching Cursor's private SQLite store. write_status re-reads + merges the
    # file each call, so writing it once here keeps it present in later writes.
    agent_env = {
        "conversation_id": os.environ.get("CURSOR_CONVERSATION_ID", ""),
        "workspace_label": os.environ.get("CURSOR_WORKSPACE_LABEL", ""),
        "cursor_agent": os.environ.get("CURSOR_AGENT") == "1",
    }
    session.write_status(run_id, "waiting", started_at=iso_now(), last_ack_id=None, **agent_env)
    # Launch (once per session) the detached presence beacon so the panel sees
    # real working-vs-interrupted state during the agent's work between waits.
    spawn_beacon_if_needed(project, session)
    print(f"[续聊助手] 会话 {session_id} 已进入等待状态，正在轮询队列…", flush=True)
    last_heartbeat = time.time()
    spinner_active = [False]
    last_spinner_beat = time.time()
    spinner_idx = [0]
    spinner_chars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    # Adaptive heartbeat. A real terminal (TTY) gets the per-second \r spinner so a
    # human watching sees a live animation. But when stdout is a pipe -- how the
    # Cursor Shell tool captures the agent's command -- \r and ANSI escapes are NOT
    # folded onto one line: they pile up at ~1 line/sec (≈300 lines per 300s
    # keepalive cycle) and the clear sequence leaks a literal "[K" before the
    # result. So when not a TTY we emit a plain newline heartbeat far less often:
    # still enough output to prove the process is alive (the Shell tool never flags
    # a hang), but ~10x less captured noise for the agent to read past.
    is_tty = bool(getattr(sys.stdout, "isatty", lambda: False)())
    spinner_interval = 1.0 if is_tty else 10.0

    def clear_spinner():
        # Only the TTY spinner leaves an unterminated line to wipe; the piped
        # heartbeat already ends each line with \n, so there is nothing to clear
        # (and we must not emit ANSI there, or it leaks as a literal "[K").
        if spinner_active[0] and is_tty:
            sys.stdout.write("\r\x1b[K")
            sys.stdout.flush()
        spinner_active[0] = False

    def write_spinner():
        elapsed = int((now_ms() - started_at_ms) / 1000)
        if is_tty:
            ch = spinner_chars[spinner_idx[0] % len(spinner_chars)]
            spinner_idx[0] += 1
            sys.stdout.write(f"\r{ch} [续聊助手] 等待中… {elapsed}s")
            sys.stdout.flush()
            spinner_active[0] = True
        else:
            sys.stdout.write(f"[续聊助手] 等待中… {elapsed}s\n")
            sys.stdout.flush()
    last_session_sig = "init"
    last_global_sig = "init"
    # P-3 adaptive poll: poll the queue at the fast base interval while there is
    # recent activity, then gradually back off up to max_poll after a stretch of
    # idleness to cut CPU/filesystem wakeups during long waits. Any queue change
    # (the panel enqueuing) snaps the interval back to the base so instruction
    # latency stays low. This is platform-independent.
    base_poll = max(0.05, float(poll_seconds))
    max_poll = max(base_poll, min(1.0, base_poll * 5.0))
    idle_backoff_after = 10.0
    current_poll = base_poll
    last_activity = time.time()

    try:
        while True:
            now = time.time()
            if now - last_spinner_beat >= spinner_interval:
                write_spinner()
                last_spinner_beat = now
            if now - last_heartbeat >= heartbeat_interval:
                session.refresh_waiter(run_id)
                session.write_status(run_id, "waiting", uptime_ms=now_ms() - started_at_ms)
                last_heartbeat = now

            item = None
            remaining = 0
            source_queue = "session"
            session_sig = queue_signature(session.queue_path)
            if session_sig != last_session_sig:
                popped, popped_remaining, conclusive = session.pop_next()
                # Advance the signature only once the pop conclusively succeeded
                # or confirmed the queue empty; a transient lock-busy / failed
                # write leaves it stale so the next iteration retries.
                if conclusive:
                    last_session_sig = session_sig
                if popped:
                    item, remaining = popped, popped_remaining
                    last_activity = now
                    current_poll = base_poll
            if not item:
                global_sig = queue_signature(project.global_queue_path)
                if global_sig != last_global_sig:
                    popped, popped_remaining, conclusive = project.pop_global()
                    if conclusive:
                        last_global_sig = global_sig
                    if popped:
                        item, remaining = popped, popped_remaining
                        last_activity = now
                        current_poll = base_poll
                        source_queue = "global"
            if item:
                payload = normalize_payload(item)
                rendered = render_payload(payload)
                ack = {
                    "id": item.get("id"),
                    "payload": payload,
                    "source": item.get("source"),
                    "source_queue": source_queue,
                    "received_at": iso_now(),
                    "received_at_ms": now_ms(),
                    "remaining_queue_length": remaining,
                    "session_id": session_id,
                    "run_id": run_id,
                    "message_preview": rendered[:160],
                }
                session.append_history({"type": "received", **ack})
                project.append_history({"type": "received", **ack})
                session.write_status(
                    run_id,
                    "received",
                    last_ack_id=ack["id"],
                    last_ack_at=ack["received_at"],
                    last_message_preview=ack["message_preview"],
                    remaining_queue_length=remaining,
                    uptime_ms=now_ms() - started_at_ms,
                )
                clear_spinner()
                print(rendered)
                return 0

            if deadline is not None and time.time() >= deadline:
                session.write_status(run_id, "timeout", uptime_ms=now_ms() - started_at_ms)
                clear_spinner()
                print("timeout waiting for instruction")
                return 2

            if keepalive_deadline is not None and time.time() >= keepalive_deadline:
                rerun_cmd = build_rerun_cmd(project, session_id, timeout_seconds, keepalive_seconds, poll_seconds,
                                           report, report_status, interactive_keepalive, bridge_config)
                message = keepalive_message(session_id, interactive_keepalive, rerun_cmd)
                session.append_history({
                    "type": "keepalive",
                    "session_id": session_id,
                    "run_id": run_id,
                    "at": iso_now(),
                })
                session.write_status(
                    run_id,
                    "keepalive",
                    last_message_preview="KEEPALIVE_NOOP",
                    uptime_ms=now_ms() - started_at_ms,
                )
                clear_spinner()
                print(message)
                return 4

            if now - last_activity >= idle_backoff_after:
                current_poll = min(max_poll, current_poll * 1.5)
            time.sleep(current_poll)
    finally:
        session.release_waiter(run_id)


def read_message_from_file(path):
    with open(path, "r", encoding="utf-8", errors="ignore") as file:
        return file.read()


# --- F-6 doctor ---------------------------------------------------------------
# A one-shot environment self-check that runs the same way on Windows and Linux.
# It quantifies the things that actually break the bridge in the field: slow
# cold-start (the ~40s "antivirus tax" on Windows), a missing python launcher,
# whether Node is available (which decides the P-1 Node-runtime route), and
# whether the state directory is writable. It deliberately avoids touching
# Cursor's install dir -- workbench/patch diagnostics belong to the extension
# (Node) side, which can resolve the per-OS install path.
PY_SLOW_SPAWN_MS = 3000.0


def python_launcher_command():
    return "py" if sys.platform.startswith("win") else "python3"


def time_subprocess(cmd):
    start = time.perf_counter()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        return {"ok": False, "ms": None, "error": "命令未找到", "out": ""}
    except subprocess.TimeoutExpired:
        return {"ok": False, "ms": None, "error": "超时(>60s)", "out": ""}
    except Exception as error:  # noqa: BLE001 - report any spawn failure verbatim
        return {"ok": False, "ms": None, "error": str(error), "out": ""}
    elapsed = (time.perf_counter() - start) * 1000.0
    out = (proc.stdout or "").strip() or (proc.stderr or "").strip()
    ok = proc.returncode == 0
    return {"ok": ok, "ms": elapsed, "error": None if ok else f"退出码 {proc.returncode}", "out": out[:200]}


def check_state_writable(project):
    probe = project.state_dir / f".doctor-{os.getpid()}-{uuid.uuid4().hex}.tmp"
    start = time.perf_counter()
    try:
        project.ensure()
        project.write_json_atomic(probe, {"ok": True, "at": iso_now()})
        data = project.read_json(probe, None)
        elapsed = (time.perf_counter() - start) * 1000.0
        ok = isinstance(data, dict) and data.get("ok") is True
        return {"ok": ok, "ms": elapsed, "error": None if ok else "写入后读回不一致"}
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "ms": None, "error": str(error)}
    finally:
        try:
            if probe.exists():
                probe.unlink()
        except OSError:
            pass


def doctor_findings(report):
    findings = []
    self_entry = report.get("python_self_spawn") or {}
    launcher = report.get("python_launcher") or {}
    spawn_times = [v.get("ms") for v in (self_entry, launcher) if isinstance(v.get("ms"), (int, float))]
    worst = max(spawn_times) if spawn_times else None
    if worst is not None and worst > PY_SLOW_SPAWN_MS:
        if sys.platform.startswith("win"):
            findings.append(
                f"Python 冷启动 {worst:.0f}ms 偏慢，疑似杀毒软件实时扫描拖慢。"
                "建议把 Python 解释器目录加入 Windows 安全中心排除项，或改用 Node 运行时(P-1)。"
            )
        else:
            findings.append(f"Python 冷启动 {worst:.0f}ms 偏慢，可能受磁盘/IO 或安全软件影响。")
    elif worst is not None:
        findings.append(f"Python 冷启动 {worst:.0f}ms，正常。")
    if not launcher.get("ok"):
        findings.append(
            f"找不到 Python 启动命令 `{launcher.get('command')}`：{launcher.get('error')}。"
            "请确认已安装 Python 且在 PATH 中。"
        )
    node = report.get("node") or {}
    if node.get("ok"):
        ms = node.get("ms")
        ms_s = f"{ms:.0f}ms" if isinstance(ms, (int, float)) else "?"
        findings.append(f"Node 可用（{node.get('out')}，{ms_s}），可作为 P-1 Node 运行时方案的基础。")
    else:
        findings.append(
            f"未在 PATH 中检测到 `node`（{node.get('error')}）。"
            "若改用 Node 运行时，需用 Cursor 自带 Electron(ELECTRON_RUN_AS_NODE=1) 或显式 node 路径。"
        )
    state_write = report.get("state_dir_write") or {}
    if state_write.get("ok"):
        ms = state_write.get("ms")
        ms_s = f"{ms:.0f}ms" if isinstance(ms, (int, float)) else "?"
        findings.append(f"状态目录可写（{ms_s}）。")
    else:
        findings.append(f"状态目录写入失败：{state_write.get('error')}。请检查目录权限。")
    return findings


def run_doctor(project, session_id=None):
    report = {
        "platform": {
            "sys_platform": sys.platform,
            "os": platform.platform(),
            "python_version": platform.python_version(),
            "python_executable": sys.executable,
            "state_dir": str(project.state_dir),
        },
        "python_self_spawn": time_subprocess([sys.executable, "-c", "pass"]),
    }
    launcher = python_launcher_command()
    report["python_launcher"] = {"command": launcher, **time_subprocess([launcher, "-c", "pass"])}
    report["node"] = time_subprocess(["node", "--version"])
    report["state_dir_write"] = check_state_writable(project)
    if session_id:
        report["waiter"] = project.session(session_id).current_waiter()
    report["findings"] = doctor_findings(report)
    return report


def render_doctor(report):
    def fmt(entry):
        if not entry:
            return "n/a"
        ms = entry.get("ms")
        ms_s = f"{ms:.0f}ms" if isinstance(ms, (int, float)) else "—"
        tag = "OK" if entry.get("ok") else f"FAIL({entry.get('error')})"
        extra = f" {entry.get('out')}" if entry.get("out") else ""
        return f"{tag} {ms_s}{extra}"

    info = report["platform"]
    lines = [
        "续聊助手 doctor 自检",
        "=" * 32,
        f"平台:           {info['os']}",
        f"Python:         {info['python_version']}  ({info['python_executable']})",
        f"状态目录:       {info['state_dir']}",
        "-" * 32,
        f"Python 自启动:  {fmt(report.get('python_self_spawn'))}",
        f"Python[{(report.get('python_launcher') or {}).get('command')}]:    {fmt(report.get('python_launcher'))}",
        f"Node:           {fmt(report.get('node'))}",
        f"状态目录可写:   {fmt(report.get('state_dir_write'))}",
        "-" * 32,
        "诊断结论:",
    ]
    for finding in report.get("findings", []):
        lines.append(f"  - {finding}")
    return "\n".join(lines)


def legacy_mode(args):
    project = ProjectState(args.state_dir)
    if args.clear:
        project.session("agent-1").write_json_atomic(project.session("agent-1").queue_path, [])
        project.clear_global()
        print("cleared")
        return 0
    if args.status:
        print(json.dumps(project.status_summary(), ensure_ascii=False, indent=2))
        return 0
    if args.stop:
        project.session("agent-1").enqueue({"status": "stop", "user_input": "stop"}, "stop")
        return 0
    if args.send_payload:
        project.session("agent-1").enqueue(json.loads(args.send_payload), "send-payload")
        return 0
    if args.send_file:
        project.session("agent-1").enqueue(read_message_from_file(args.send_file), "send-file")
        return 0
    if args.send is not None:
        project.session("agent-1").enqueue(args.send, "send")
        return 0
    return wait_for_instruction(project, "agent-1", args.timeout, args.keepalive, args.poll)


def main():
    default_state = Path.cwd() / ".cursor" / "local-continue-state"
    parser = argparse.ArgumentParser(description="Continue Assistant multi-session bridge")
    subparsers = parser.add_subparsers(dest="command")

    wait_parser = subparsers.add_parser("wait", help="Wait for the next message for one session")
    wait_parser.add_argument("--state-dir", default=str(default_state))
    wait_parser.add_argument("--session-id", default="agent-1")
    wait_parser.add_argument("--timeout", type=int, default=0)
    wait_parser.add_argument("--keepalive", type=int, default=90)
    wait_parser.add_argument("--poll", type=float, default=0.2)
    wait_parser.add_argument("--report", default=None,
                             help="One-line summary of the task just finished, shown in the panel")
    wait_parser.add_argument("--report-status", default="done",
                             choices=["done", "need_input", "error"])
    wait_parser.add_argument("--interactive-keepalive", action="store_true",
                             help="Send math/common-sense questions in keepalive messages")
    wait_parser.add_argument("--bridge-port", type=int, default=0,
                             help="HTTP bridge port for real-time instruction polling")
    wait_parser.add_argument("--bridge-secret", default="",
                             help="Secret for HTTP bridge authentication")

    send_parser = subparsers.add_parser("send", help="Queue a message")
    send_parser.add_argument("--state-dir", default=str(default_state))
    send_parser.add_argument("--session-id")
    send_parser.add_argument("--global-queue", action="store_true")
    send_parser.add_argument("--payload")
    send_parser.add_argument("--text")

    status_parser = subparsers.add_parser("status", help="Print JSON status")
    status_parser.add_argument("--state-dir", default=str(default_state))

    clear_parser = subparsers.add_parser("clear", help="Clear queues")
    clear_parser.add_argument("--state-dir", default=str(default_state))
    clear_parser.add_argument("--session-id")
    clear_parser.add_argument("--global-queue", action="store_true")

    doctor_parser = subparsers.add_parser("doctor", help="Diagnose runtime/environment (Windows+Linux)")
    doctor_parser.add_argument("--state-dir", default=str(default_state))
    doctor_parser.add_argument("--session-id", default=None)
    doctor_parser.add_argument("--json", action="store_true", help="Emit the raw report as JSON")

    beacon_parser = subparsers.add_parser("beacon", help="Run a presence beacon for one session")
    beacon_parser.add_argument("--state-dir", default=str(default_state))
    beacon_parser.add_argument("--session-id", default="agent-1")
    beacon_parser.add_argument("--watch-ppid", type=int, default=0)
    beacon_parser.add_argument("--interval", type=int, default=4)

    parser.add_argument("--state-dir", default=str(default_state), help=argparse.SUPPRESS)
    parser.add_argument("--send", help=argparse.SUPPRESS)
    parser.add_argument("--send-file", help=argparse.SUPPRESS)
    parser.add_argument("--send-payload", help=argparse.SUPPRESS)
    parser.add_argument("--stop", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--status", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--clear", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--timeout", type=int, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--keepalive", type=int, default=90, help=argparse.SUPPRESS)
    parser.add_argument("--poll", type=float, default=0.2, help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.command == "wait":
        project = ProjectState(args.state_dir)
        bridge_config = None
        if args.bridge_port and args.bridge_secret:
            bridge_config = {"port": args.bridge_port, "secret": args.bridge_secret}
        return wait_for_instruction(project, args.session_id, args.timeout, args.keepalive, args.poll,
                                    args.report, args.report_status,
                                    args.interactive_keepalive, bridge_config)
    if args.command == "beacon":
        project = ProjectState(args.state_dir)
        return run_beacon(project, args.session_id, args.watch_ppid, args.interval * 1000)
    if args.command == "send":
        project = ProjectState(args.state_dir)
        payload = json.loads(args.payload) if args.payload else normalize_payload(args.text or "")
        if args.global_queue:
            item = project.enqueue_global(payload, "send")
        else:
            item = project.session(args.session_id or "agent-1").enqueue(payload, "send")
        print(f"queued: {item['id']}")
        return 0
    if args.command == "status":
        project = ProjectState(args.state_dir)
        print(json.dumps(project.status_summary(), ensure_ascii=False, indent=2))
        return 0
    if args.command == "doctor":
        project = ProjectState(args.state_dir)
        report = run_doctor(project, args.session_id)
        if getattr(args, "json", False):
            print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
        else:
            print(render_doctor(report))
        return 0
    if args.command == "clear":
        project = ProjectState(args.state_dir)
        if args.global_queue or not args.session_id:
            project.clear_global()
        if args.session_id:
            session = project.session(args.session_id)
            lock_token = session.project.acquire_lock(session.queue_lock_dir)
            try:
                session.write_json_atomic(session.queue_path, [])
            finally:
                session.project.release_lock(session.queue_lock_dir, lock_token)
        print("cleared")
        return 0

    return legacy_mode(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        raise SystemExit(130)
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
