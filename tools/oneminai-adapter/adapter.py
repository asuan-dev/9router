#!/usr/bin/env python3
"""
1min.ai → OpenAI 兼容适配器
把标准 OpenAI /v1/chat/completions 请求转成 1min.ai /api/chat-with-ai 格式，
再把 1min.ai 响应转回 OpenAI 格式。

用法：
  python3 oneminai_adapter.py --port 3199 --api-key YOUR_1MIN_API_KEY

然后在 AxonHub 里配 OpenAI 类型渠道：
  base_url: http://127.0.0.1:3199/v1
  api_key: anything（适配器不校验入站 key）
  模型映射：gpt-4o-mini / claude-sonnet-4-6 等（1min.ai 支持的模型名）

或直接用 curl 测试：
  curl http://127.0.0.1:3199/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -H 'Authorization: Bearer anything' \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hello"}]}'
"""
from __future__ import annotations
import argparse, json, time, uuid, http.server, threading, urllib.request, urllib.error

UPSTREAM = "https://api.1min.ai/api/chat-with-ai"

# ── 请求转换：OpenAI messages → 1min.ai promptObject ──────────────────────
def convert_request(openai_body: dict) -> dict:
    """把 OpenAI chat/completions 请求转成 1min.ai 格式。"""
    messages = openai_body.get("messages", [])
    model = openai_body.get("model", "gpt-4o-mini")
    stream = openai_body.get("stream", False)

    # 把 messages 拼成单个 prompt（1min.ai 只接受单 prompt 字符串）
    # 如果有 conversation history，用结构化方式拼
    parts = []
    conversation_id = None
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if isinstance(content, list):
            # OpenAI vision 格式：提取 text 部分
            content = " ".join(
                block.get("text", "") for block in content
                if isinstance(block, dict) and block.get("type") == "text"
            )
        if role == "system":
            parts.append(f"[System]\n{content}")
        elif role == "user":
            parts.append(f"[User]\n{content}")
        elif role == "assistant":
            parts.append(f"[Assistant]\n{content}")
        elif role == "developer":
            parts.append(f"[Developer]\n{content}")

    prompt = "\n\n".join(parts) if parts else ""

    payload = {
        "type": "UNIFY_CHAT_WITH_AI",
        "model": model,
        "promptObject": {
            "prompt": prompt,
        },
    }

    # 透传 web_search 参数
    if openai_body.get("web_search_options") or openai_body.get("tools"):
        payload["promptObject"]["settings"] = {
            "webSearchSettings": {
                "webSearch": True,
                "numOfSite": 3,
                "maxWord": 1000,
            }
        }

    return payload, stream


# ── 响应转换：1min.ai → OpenAI ─────────────────────────────────────────────
def convert_response(onemin_body: dict, model: str) -> dict:
    """把 1min.ai 非流式响应转成 OpenAI chat/completions 格式。"""
    ai_record = onemin_body.get("aiRecord", {})
    detail = ai_record.get("aiRecordDetail", {})
    result_list = detail.get("resultObject", [])
    content = result_list[0] if result_list else ""

    meta = ai_record.get("metadata", {}) or {}
    prompt_tokens = meta.get("inputToken", 0) or 0
    completion_tokens = meta.get("outputToken", 0) or 0
    finish_reason = meta.get("finishReason", "stop") or "stop"

    return {
        "id": f"chatcmpl-{ai_record.get('uuid', uuid.uuid4().hex[:24])}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


def convert_stream_chunk(content: str, model: str, done: bool = False) -> str:
    """生成 OpenAI SSE 格式的流式 chunk。"""
    chunk = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {} if done else {"content": content},
                "finish_reason": "stop" if done else None,
            }
        ],
    }
    return f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"


def convert_stream_end() -> str:
    return "data: [DONE]\n\n"


# ── HTTP 处理 ──────────────────────────────────────────────────────────────
class AdapterHandler(http.server.BaseHTTPRequestHandler):
    api_key: str = ""

    def log_message(self, fmt, *args):
        pass  # 静默

    def _send_json(self, code: int, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_sse(self, lines: list[str]):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        for line in lines:
            self.wfile.write(line.encode())
            self.wfile.flush()

    def do_GET(self):
        if self.path == "/v1/models":
            self._send_json(200, {
                "object": "list",
                "data": [
                    {"id": m, "object": "model", "owned_by": p}
                    for m, p in KNOWN_MODELS
                ],
            })
        elif self.path == "/health":
            self._send_json(200, {"status": "ok"})
        else:
            self._send_json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if "/chat/completions" not in self.path:
            self._send_json(404, {"error": {"message": "not found"}})
            return

        length = int(self.headers.get("Content-Length", 0))
        try:
            raw = self.rfile.read(length)
            openai_body = json.loads(raw) if raw else {}
        except Exception as e:
            self._send_json(400, {"error": {"message": f"bad request: {e}"}})
            return

        model = openai_body.get("model", "gpt-4o-mini")
        onemin_payload, want_stream = convert_request(openai_body)

        # 调 1min.ai
        url = UPSTREAM + ("?isStreaming=true" if want_stream else "")
        req_body = json.dumps(onemin_payload, ensure_ascii=False).encode()
        req = urllib.request.Request(url, data=req_body, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("API-KEY", self.api_key)
        req.add_header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) 1minAI-Adapter/1.0")

        try:
            if want_stream:
                self._handle_stream(req, model)
            else:
                resp = urllib.request.urlopen(req, timeout=120)
                onemin_body = json.loads(resp.read())
                if "aiRecord" not in onemin_body:
                    self._send_json(502, {"error": {"message": f"upstream error: {json.dumps(onemin_body)[:500]}"}})
                    return
                openai_resp = convert_response(onemin_body, model)
                self._send_json(200, openai_resp)
        except urllib.error.HTTPError as e:
            err_body = e.read().decode(errors="replace")[:500]
            self._send_json(e.code, {"error": {"message": f"upstream {e.code}: {err_body}"}})
        except Exception as e:
            self._send_json(500, {"error": {"message": f"adapter error: {e}"}})

    def _handle_stream(self, req, model: str):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        try:
            resp = urllib.request.urlopen(req, timeout=120)
            full_content = ""
            for raw_line in resp:
                line = raw_line.decode(errors="replace").strip()
                if not line:
                    continue
                if line.startswith("event:"):
                    continue
                if line.startswith("data:"):
                    data_str = line[5:].strip()
                    try:
                        data = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue

                    if "content" in data:
                        chunk = data["content"]
                        full_content += chunk
                        self.wfile.write(convert_stream_chunk(chunk, model).encode())
                        self.wfile.flush()
                    elif "aiRecord" in data or "result" in data:
                        # result event — 可能含完整内容，但我们已经流式发了
                        pass
                    elif "message" in data and "done" in str(data.get("message", "")).lower():
                        pass

            self.wfile.write(convert_stream_end().encode())
            self.wfile.flush()
        except Exception as e:
            err_chunk = {
                "error": {"message": f"stream error: {e}"}
            }
            self.wfile.write(f"data: {json.dumps(err_chunk)}\n\n".encode())
            self.wfile.flush()


KNOWN_MODELS = [
    ("gpt-4o-mini", "openai"),
    ("gpt-4o", "openai"),
    ("gpt-4o-mini", "openai"),
    ("claude-sonnet-4-6", "anthropic"),
    ("gemini-3.5-flash", "google"),
    ("deepseek-chat", "deepseek"),
]


def main():
    parser = argparse.ArgumentParser(description="1min.ai → OpenAI compatible adapter")
    parser.add_argument("--port", type=int, default=3199)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--api-key", required=True, help="1min.ai API key")
    args = parser.parse_args()

    AdapterHandler.api_key = args.api_key
    server = http.server.ThreadingHTTPServer((args.host, args.port), AdapterHandler)
    print(f"1min.ai adapter listening on http://{args.host}:{args.port}")
    print(f"  AxonHub config: openai channel, base_url=http://{args.host}:{args.port}/v1")
    print(f"  Test: curl http://{args.host}:{args.port}/v1/chat/completions -H 'Authorization: Bearer x' -d '{{\"model\":\"gpt-4o-mini\",\"messages\":[{{\"role\":\"user\",\"content\":\"hi\"}}]}}'")
    server.serve_forever()


if __name__ == "__main__":
    main()
