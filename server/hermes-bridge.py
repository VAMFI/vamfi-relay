"""Allowlisted Relay bridge to the qualified, installed Hermes native client.

No credential files, generic RPC surface, provider configuration writes, or
process-wide gateway stop. Remote turn settlement is established by receipts.
"""
import argparse
import asyncio
from contextlib import suppress
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import sys
import time

MAX_BYTES = 1024 * 1024
VERSION = "0.23.0"
REQUIRED_CAPABILITIES = {"durable-admission-v1", "event-replay-v1", "acp-editor-policy-v1", "acp-session-mcp-v1"}
TERMINAL = {"completed", "interrupted", "failed"}
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:_-]{0,180}$")


class Rejected(Exception):
    def __init__(self, uncertain=False, turn_id=None):
        self.uncertain, self.turn_id = uncertain, turn_id


def identifier(value):
    return isinstance(value, str) and ID.fullmatch(value)


def session_id(value):
    if not identifier(value) or not value.startswith("hermes:local-"):
        raise Rejected()
    return value.removeprefix("hermes:")


def bounded(value, limit):
    return (value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))[:limit]


def send(value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(data.encode()) > MAX_BYTES:
        raise Rejected(True)
    sys.stdout.write(data + "\n")
    sys.stdout.flush()


class Bridge:
    def __init__(self, root, node):
        self.root, self.node = root, node
        self.client = None
        self.context = None
        self.sessions = {}
        self.runs = {}
        self.monitors = set()
        self.consumer = None
        self.locks = {}

    async def rpc(self, method, **params):
        # Only bridge implementation literals reach this private helper.
        return await self.client.rpc(method, _timeout=20, **params)

    async def eligible(self):
        from hermes_cli.config import load_config_readonly
        # Native behavioral config API; retain/emit no configuration values.
        config = await asyncio.to_thread(load_config_readonly)
        agent = config.get("agent") or {}
        if not isinstance(agent, dict) or any(config.get(key) for key in
                ("hooks", "context_engine", "system_prompt", "ephemeral_system_prompt", "outbound_webhooks")) \
                or any(agent.get(key) for key in ("system_prompt", "context_engine", "ephemeral_system_prompt")):
            raise Rejected()
        plugins = await self.rpc("plugins.list")
        if not isinstance(plugins.get("plugins"), list) or any(
                row.get("enabled") and row.get("hooks") for row in plugins["plugins"]):
            raise Rejected()

    async def connect(self):
        if self.client:
            return {"version": VERSION, "qualified": True}
        from hermes_cli import __version__
        from hermes_cli.gateway_client import connect_gateway
        if __version__ != VERSION or os.environ.get("HERMES_TUI_GATEWAY_URL"):
            raise Rejected()
        self.context = connect_gateway(max_size=8 * 1024 * 1024)
        self.client = await self.context.__aenter__()
        descriptor = await self.rpc("runtime.describe")
        create = descriptor.get("session_create") or {}
        if not REQUIRED_CAPABILITIES <= set(descriptor.get("capabilities") or []) \
                or "acp" not in (create.get("sources") or []) \
                or not {"request_id", "source", "cwd", "toolsets", "ignore_rules", "max_turns", "editor"} <= set(create.get("parameters") or []):
            raise Rejected()
        await self.eligible()
        self.consumer = asyncio.create_task(self.events())
        return {"version": VERSION, "qualified": True}

    def editor(self, workspace):
        script = str(Path(__file__).resolve().with_name("mcp-project.mjs"))
        return {"mcp_servers": [{"name": "vamfi_relay_project", "command": self.node,
                "args": [script, "--root", workspace], "env": []}], "edit_approval_policy": "ask"}

    def validate_scope(self, info, workspace):
        launch = info.get("launch_request") or {}
        groups = info.get("enabled_toolsets") or []
        editor = launch.get("editor") or {}
        expected = self.editor(workspace)
        fingerprint = hashlib.sha256(json.dumps(expected["mcp_servers"], sort_keys=True,
                                      separators=(",", ":")).encode()).hexdigest()
        if info.get("version") != VERSION or launch.get("source") != "acp" or launch.get("cwd") != workspace \
                or launch.get("ignore_rules") is not True or launch.get("toolsets") != ["no_mcp"] \
                or launch.get("max_turns") != 6 or editor.get("edit_approval_policy") != "ask" \
                or editor.get("mcp_servers") != {"fingerprint": fingerprint} \
                or len(groups) != 1 or not re.fullmatch(r"mcp-editor_vamfi_relay_project_[a-f0-9]{8}", groups[0]) \
                or launch.get("skills") or launch.get("accept_hooks"):
            raise Rejected()
        tools = info.get("tools") or {}
        if not isinstance(tools, dict):
            raise Rejected()
        allowed = {"mcp__" + groups[0].removeprefix("mcp-") + "__" + name
                   for name in ("list_files", "read_file", "search_files")}
        # The pinned dispatcher constrains these progressive-disclosure wrappers
        # to this session's raw tool catalog, already proven by the exact group.
        allowed.update({"tool_search", "tool_describe", "tool_call"})
        if any(not isinstance(names, list) or any(name not in allowed for name in names) for names in tools.values()):
            raise Rejected()

    async def inspect(self, sid, workspace=None):
        info = await self.rpc("session.info", session_id=sid)
        root = (info.get("launch_request") or {}).get("cwd")
        if not isinstance(root, str) or not Path(root).is_absolute() or (workspace is not None and root != workspace):
            raise Rejected()
        self.validate_scope(info, root)
        return root

    async def open(self, params, resume=False):
        workspace = params.get("workspace")
        if not isinstance(workspace, str) or not Path(workspace).is_absolute() \
                or str(Path(workspace).resolve(strict=True)) != workspace \
                or not Path(workspace).is_dir() or params.get("permissionMode") != "read-only":
            raise Rejected()
        await self.eligible()
        if resume:
            sid = session_id(params.get("id"))
            if sid in self.runs:
                raise Rejected(True, self.runs[sid].get("admission"))
            await self.inspect(sid, workspace)
            snapshot = await self.rpc("session.resume", session_id=sid, editor=self.editor(workspace))
        else:
            request_id = params.get("requestId")
            if not identifier(request_id) or not request_id.startswith("relay-"):
                raise Rejected()
            snapshot = await self.rpc("session.create", request_id=request_id, source="acp", cwd=workspace,
                toolsets=["no_mcp"], ignore_rules=True, max_turns=6, hidden=True, editor=self.editor(workspace))
            sid = snapshot.get("session_id")
        if not identifier(sid) or not sid.startswith("local-") or snapshot.get("session_id") != sid:
            raise Rejected()
        self.validate_scope(snapshot.get("info") or {}, workspace)
        self.sessions[sid] = {"workspace": workspace, "instructions": bounded(params.get("developerInstructions", ""), 12000)}
        return {"id": "hermes:" + sid, "workspace": workspace, "permissionMode": "read-only", "qualified": True}

    def notice(self, run, method, **params):
        send({"method": "notification", "params": {"method": method, "params": {
            "threadId": "hermes:" + run["sid"], "runId": run["run_id"],
            "turnId": run["admission"], **params}}})

    async def submit(self, params):
        sid = session_id(params.get("threadId"))
        run_id, text = params.get("runId"), params.get("text")
        if sid not in self.sessions or sid in self.runs or not identifier(run_id) \
                or not isinstance(text, str) or not text.strip() or len(text) > 32000:
            raise Rejected()
        await self.eligible()
        await self.inspect(sid, self.sessions[sid]["workspace"])
        run = {"sid": sid, "run_id": run_id, "admission": None, "generation": None,
               "seq": -1, "epoch": None, "done": False}
        self.runs[sid] = run
        instructions = self.sessions[sid]["instructions"]
        prompt = ("Relay project instructions:\n" + instructions + "\n\nCurrent request:\n" + text) if instructions else text
        try:
            receipt = await self.rpc("prompt.submit", session_id=sid, submission_id=run_id, text=prompt, finite=True)
            admission = receipt.get("admission_id")
            if not identifier(admission) or (receipt.get("ref") or {}).get("session_id") != sid:
                raise Rejected(True)
            run["admission"] = admission
            run["generation"] = receipt.get("execution_generation")
            self.notice(run, "turn/started", turn={"id": admission})
            monitor = asyncio.create_task(self.monitor(run))
            self.monitors.add(monitor)
            monitor.add_done_callback(self.monitors.discard)
            return {"id": admission}
        except Exception:
            raise Rejected(True, run.get("admission")) from None

    def receipt_state(self, receipt, admission):
        if receipt.get("admission_id") != admission:
            raise Rejected(True, admission)
        if receipt.get("status") in ("queued", "started"):
            return "running"
        if receipt.get("status") != "terminal":
            return "unknown"
        result = receipt.get("result") or {}
        outcome = receipt.get("outcome")
        if outcome in ("cancelled", "interrupted") or result.get("interrupted") is True:
            return "interrupted"
        if outcome == "failed" or result.get("failed") or result.get("error"):
            return "failed"
        if outcome == "completed" and result.get("completed") is not False:
            return "completed"
        return "unknown"

    async def receipt(self, sid, admission):
        receipt = await self.rpc("prompt.receipt", session_id=sid, admission_id=admission, include_result=True)
        if (receipt.get("ref") or {}).get("session_id") != sid:
            raise Rejected(True, admission)
        return self.receipt_state(receipt, admission), receipt

    def settled(self, run, state, receipt):
        if run["done"]:
            return
        run["done"] = True
        result = bounded((receipt.get("result") or {}).get("final_response") or "", 64000)
        if result:
            self.notice(run, "item/completed", item={"type": "agentMessage", "text": result, "phase": "final_answer"})
        self.notice(run, "turn/completed", turn={"id": run["admission"], "status": state})
        if self.runs.get(run["sid"]) is run:
            del self.runs[run["sid"]]

    async def monitor(self, run):
        try:
            deadline = time.monotonic() + 600
            while not run["done"]:
                state, receipt = await self.receipt(run["sid"], run["admission"])
                if state in TERMINAL:
                    self.settled(run, state, receipt)
                    return
                if state == "unknown":
                    raise Rejected(True, run["admission"])
                if time.monotonic() >= deadline:
                    await self.cancel({"threadId": "hermes:" + run["sid"], "turnId": run["admission"], "runId": run["run_id"]})
                    return
                await asyncio.sleep(0.5)
        except asyncio.CancelledError:
            raise
        except Exception:
            send({"method": "disconnect", "params": {"uncertain": True}})

    async def recover(self, params):
        sid, run_id = session_id(params.get("threadId")), params.get("runId")
        if not identifier(run_id):
            raise Rejected()
        previous = self.runs.get(sid)
        if previous and previous["run_id"] != run_id:
            raise Rejected(True)
        root = await self.inspect(sid)
        snapshot = await self.rpc("session.resume", session_id=sid, editor=self.editor(root))
        self.validate_scope(snapshot.get("info") or {}, root)
        # Read only exact submission correlation; never forward history or owner metadata.
        admissions = {row.get("admission_id") for row in snapshot.get("pending", []) if row.get("input_id") == run_id}
        admissions.update(row.get("message_id") for row in snapshot.get("messages", [])
            if row.get("role") == "user" and (row.get("display_metadata") or {}).get("submission_id") == run_id)
        admissions.discard(None)
        expected = params.get("turnId")
        if len(admissions) != 1 or (expected and expected not in admissions):
            if self.runs.get(sid) is previous and not (previous and previous["done"]):
                self.runs.setdefault(sid, {"sid": sid, "run_id": run_id, "admission": expected,
                    "generation": None, "seq": -1, "epoch": None, "done": False})
            return {"state": "unknown", "threadId": params["threadId"], "runId": run_id}
        admission = next(iter(admissions))
        if not identifier(admission):
            raise Rejected(True)
        state, receipt = await self.receipt(sid, admission)
        # A concurrent monitor can observe terminal settlement while the native
        # receipt is in flight. Its ownership change wins over this older read.
        if self.runs.get(sid) is not previous or (previous and previous["done"]):
            return {"state": state, "threadId": params["threadId"], "runId": run_id, "turnId": admission,
                    "result": bounded((receipt.get("result") or {}).get("final_response") or "", 64000)}
        if state == "running":
            self.sessions.setdefault(sid, {"workspace": root, "instructions": ""})
            run = self.runs.get(sid)
            if run and (run["run_id"] != run_id or run.get("admission") not in (None, admission)):
                raise Rejected(True, admission)
            if not run or not run.get("admission"):
                run = {"sid": sid, "run_id": run_id, "admission": admission,
                       "generation": receipt.get("execution_generation"), "seq": -1, "epoch": None, "done": False}
                self.runs[sid] = run
                monitor = asyncio.create_task(self.monitor(run)); self.monitors.add(monitor)
                monitor.add_done_callback(self.monitors.discard)
        elif state in TERMINAL:
            previous = self.runs.pop(sid, None)
            if previous:
                previous["done"] = True
        return {"state": state, "threadId": params["threadId"], "runId": run_id, "turnId": admission,
                "result": bounded((receipt.get("result") or {}).get("final_response") or "", 64000)}

    async def cancel(self, params):
        sid = session_id(params.get("threadId"))
        run = self.runs.get(sid)
        admission = params.get("turnId")
        if not run or run["run_id"] != params.get("runId") or run["admission"] != admission:
            raise Rejected()
        await self.rpc("prompt.cancel", session_id=sid, admission_id=admission)
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            state, receipt = await self.receipt(sid, admission)
            if state in TERMINAL:
                self.settled(run, state, receipt)
                return {"state": state, "turnId": admission}
            if state == "unknown":
                break
            await asyncio.sleep(0.25)
        raise Rejected(True, admission)

    async def events(self):
        try:
            while True:
                frame = await self.client.events.get()
                if isinstance(frame, Exception):
                    raise Rejected(True)
                if not isinstance(frame, dict) or frame.get("method") != "event":
                    continue
                p = frame.get("params") or {}
                run = self.runs.get(p.get("session_id"))
                if not run or run["done"] or not run["admission"] or p.get("admission_id") != run["admission"]:
                    continue
                generation = p.get("execution_generation")
                if run["generation"] is not None and generation is not None and generation != run["generation"]:
                    continue
                seq, epoch = p.get("seq"), p.get("replay_epoch")
                if not isinstance(seq, int) or not isinstance(epoch, str):
                    continue
                if run["epoch"] == epoch and seq <= run["seq"]:
                    continue
                run["epoch"], run["seq"] = epoch, seq
                payload, kind = p.get("payload") or {}, p.get("type")
                if kind == "message.delta" and isinstance(payload.get("text"), str):
                    self.notice(run, "item/agentMessage/delta", delta=payload["text"][:16000])
                elif kind in ("tool.start", "tool.complete"):
                    self.notice(run, "item/completed", item={"type": "providerTool",
                        "id": bounded(payload.get("tool_id", str(seq)), 100), "tool": bounded(payload.get("name", "tool"), 200),
                        "status": "running" if kind == "tool.start" else "completed",
                        "input": bounded(payload.get("args", {}), 8000), "output": bounded(payload.get("result", ""), 16000)})
                # Hidden reasoning, session.info, account metadata and other sessions are never forwarded.
        except asyncio.CancelledError:
            raise
        except Exception:
            send({"method": "disconnect", "params": {"uncertain": True}})

    async def dispatch(self, method, params):
        if method == "connect": return await self.connect()
        if not self.client: raise Rejected()
        if method == "thread/start": return await self.open(params)
        if method == "thread/resume": return await self.open(params, resume=True)
        if method == "turn/start": return await self.submit(params)
        if method == "turn/recover": return await self.recover(params)
        if method == "turn/interrupt": return await self.cancel(params)
        if method == "close":
            if self.runs: raise Rejected(True)
            return {"closed": True}
        raise Rejected()

    async def handle(self, request):
        rid = request.get("id")
        try:
            method, params = request.get("method"), request.get("params")
            if not isinstance(rid, int) or not isinstance(method, str) or not isinstance(params, dict):
                raise Rejected()
            # Serialize session mutation, but permit exact cancellation while monitor polls.
            key = params.get("threadId") or params.get("id") or "create"
            lock = self.locks.setdefault(key, asyncio.Lock())
            async with lock:
                result = await self.dispatch(method, params)
            send({"id": rid, "result": result})
        except Rejected as error:
            send({"id": rid, "error": {"uncertain": error.uncertain,
                  **({"turnId": error.turn_id} if error.turn_id else {})}})
        except Exception:
            send({"id": rid, "error": {"uncertain": request.get("method") in ("turn/start", "turn/interrupt", "turn/recover")}})

    async def close(self):
        for task in [self.consumer, *self.monitors]:
            if task: task.cancel()
        await asyncio.gather(*(task for task in [self.consumer, *self.monitors] if task), return_exceptions=True)
        if self.context:
            with suppress(Exception): await self.context.__aexit__(None, None, None)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True); parser.add_argument("--node", required=True)
    args = parser.parse_args()
    root, node = Path(args.root).resolve(strict=True), Path(args.node).resolve(strict=True)
    sys.path.insert(0, str(root))
    logging.disable(logging.CRITICAL)
    bridge = Bridge(str(root), str(node))
    pending = set()
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.buffer.readline, MAX_BYTES + 1)
            if not line: break
            if len(line) > MAX_BYTES or not line.endswith(b"\n"): raise Rejected(True)
            request = json.loads(line)
            if not isinstance(request, dict) or len(pending) >= 32: raise Rejected(True)
            task = asyncio.create_task(bridge.handle(request)); pending.add(task); task.add_done_callback(pending.discard)
        await asyncio.gather(*pending)
    finally:
        await bridge.close()


if __name__ == "__main__":
    try: asyncio.run(main())
    except (Exception, KeyboardInterrupt):
        # No provider exception, profile, authentication or stderr contents cross this boundary.
        sys.exit(1)
