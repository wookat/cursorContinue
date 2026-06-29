import argparse
import base64
import json
import os
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
}


def now_ms():
    return int(time.time() * 1000)


def iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


class BridgeState:
    def __init__(self, state_dir):
        self.state_dir = Path(state_dir).resolve()
        self.queue_path = self.state_dir / "queue.json"
        self.status_path = self.state_dir / "status.json"
        self.history_path = self.state_dir / "history.jsonl"

    def ensure(self):
        self.state_dir.mkdir(parents=True, exist_ok=True)

    def read_json(self, path, fallback):
        try:
            with open(path, "r", encoding="utf-8") as file:
                return json.load(file)
        except (FileNotFoundError, json.JSONDecodeError):
            return fallback

    def write_json_atomic(self, path, data):
        self.ensure()
        tmp = path.with_suffix(f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
        with open(tmp, "w", encoding="utf-8") as file:
            json.dump(data, file, ensure_ascii=True, indent=2)
        os.replace(tmp, path)

    def append_history(self, record):
        self.ensure()
        with open(self.history_path, "a", encoding="utf-8") as file:
            file.write(json.dumps(record, ensure_ascii=True) + "\n")

    def queue(self):
        data = self.read_json(self.queue_path, [])
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and isinstance(data.get("messages"), list):
            return data["messages"]
        return []

    def enqueue(self, message, source="manual"):
        item = {
            "id": uuid.uuid4().hex,
            "message": message,
            "source": source,
            "created_at": iso_now(),
            "created_at_ms": now_ms(),
            "pid": os.getpid(),
        }
        queue = self.queue()
        queue.append(item)
        self.write_json_atomic(self.queue_path, queue)
        print(f"queued: {item['id']}")

    def pop_next(self):
        queue = self.queue()
        if not queue:
            return None, 0
        item = queue.pop(0)
        self.write_json_atomic(self.queue_path, queue)
        return item, len(queue)

    def status(self):
        status = self.read_json(self.status_path, {})
        queue = self.queue()
        status["queue_length"] = len(queue)
        status["connected"] = (
            status.get("state") == "waiting"
            and now_ms() - int(status.get("heartbeat_ms", 0) or 0) < 5000
        )
        return status

    def write_status(self, session_id, state, **extra):
        status = self.read_json(self.status_path, {})
        status.update({
            "protocol": 3,
            "session_id": session_id,
            "state": state,
            "pid": os.getpid(),
            "heartbeat_ms": now_ms(),
            "heartbeat_at": iso_now(),
            "queue_length": len(self.queue()),
            "queue_path": str(self.queue_path),
            "status_path": str(self.status_path),
        })
        status.update(extra)
        self.write_json_atomic(self.status_path, status)

    def clear(self):
        self.ensure()
        for path in [self.queue_path, self.status_path]:
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        print("cleared")


def process_instruction(value):
    possible_path = Path(value).expanduser()
    if possible_path.is_file():
        if possible_path.suffix.lower() in IMAGE_EXTENSIONS:
            with open(possible_path, "rb") as image_file:
                encoded = base64.b64encode(image_file.read()).decode("utf-8")
            print(f"IMAGE_CONTEXT_START:{possible_path.name}::{encoded}:IMAGE_CONTEXT_END")
            return
        if possible_path.suffix.lower() in TEXT_EXTENSIONS:
            with open(possible_path, "r", encoding="utf-8", errors="ignore") as text_file:
                content = text_file.read()
            print(f"FILE_CONTEXT_START:{possible_path.name}::{content}:FILE_CONTEXT_END")
            return
    print(value)


def wait_for_instruction(bridge, timeout_seconds, poll_seconds):
    bridge.ensure()
    session_id = uuid.uuid4().hex
    started_at_ms = now_ms()
    deadline = None if timeout_seconds <= 0 else time.time() + timeout_seconds
    bridge.write_status(session_id, "waiting", started_at=iso_now(), last_ack_id=None)

    while True:
        item, remaining = bridge.pop_next()
        if item:
            message = str(item.get("message", ""))
            ack = {
                "id": item.get("id"),
                "message_preview": message[:120],
                "source": item.get("source"),
                "received_at": iso_now(),
                "received_at_ms": now_ms(),
                "remaining_queue_length": remaining,
                "session_id": session_id,
            }
            bridge.append_history({"type": "received", **ack})
            bridge.write_status(
                session_id,
                "received",
                last_ack_id=ack["id"],
                last_ack_at=ack["received_at"],
                last_message_preview=ack["message_preview"],
                remaining_queue_length=remaining,
                uptime_ms=now_ms() - started_at_ms,
            )
            process_instruction(message)
            return 0

        if deadline is not None and time.time() >= deadline:
            bridge.write_status(session_id, "timeout", uptime_ms=now_ms() - started_at_ms)
            print("timeout waiting for instruction")
            return 2

        bridge.write_status(session_id, "waiting", uptime_ms=now_ms() - started_at_ms)
        time.sleep(poll_seconds)


def read_message_from_file(path):
    with open(path, "r", encoding="utf-8", errors="ignore") as file:
        return file.read()


def main():
    default_state = Path.cwd() / ".cursor" / "cutc-state"
    parser = argparse.ArgumentParser(description="CUTC instruction bridge")
    parser.add_argument("--state-dir", default=str(default_state), help="Per-workspace bridge state directory")
    parser.add_argument("--send", help="Queue a plain instruction")
    parser.add_argument("--send-file", help="Queue instruction text from a file")
    parser.add_argument("--stop", action="store_true", help="Queue stop")
    parser.add_argument("--status", action="store_true", help="Print JSON status")
    parser.add_argument("--clear", action="store_true", help="Clear queue and status")
    parser.add_argument("--timeout", type=int, default=0, help="Wait timeout in seconds; 0 means forever")
    parser.add_argument("--poll", type=float, default=0.5, help="Polling interval in seconds")
    args = parser.parse_args()

    bridge = BridgeState(args.state_dir)

    if args.clear:
        bridge.clear()
        return 0
    if args.status:
        print(json.dumps(bridge.status(), ensure_ascii=False, indent=2))
        return 0
    if args.stop:
        bridge.enqueue("stop", "stop")
        return 0
    if args.send_file:
        bridge.enqueue(read_message_from_file(args.send_file), "send-file")
        return 0
    if args.send is not None:
        bridge.enqueue(args.send, "send")
        return 0

    return wait_for_instruction(bridge, args.timeout, args.poll)


if __name__ == "__main__":
    raise SystemExit(main())
