"""Optional integrated interviewer through the official Anthropic Messages API. Off by default.

API mode is billed per token to the API key's account, separately from any Claude
subscription. The key is read from the server's environment (ANTHROPIC_API_KEY) and
is never sent to the browser. Each session has a request cap and every request has
an output cap; usage is recorded per session and in <home>/.lab/api_usage.json.
"""
from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

DEFAULT_MODEL = "claude-haiku-5-5"
API_VERSION = "2023-06-01"
_LOCK = threading.Lock()


class ApiError(Exception):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


def _int_env(env: Dict[str, str], name: str, default: int) -> int:
    try:
        return max(1, int(env.get(name, default)))
    except ValueError:
        return default


class ApiConfig:
    def __init__(self, env: Optional[Dict[str, str]] = None):
        env = os.environ if env is None else env
        self.enabled = env.get("PRACTICE_API_MODE", "off").lower() in ("on", "1", "true", "yes")
        self.key = env.get("ANTHROPIC_API_KEY", "")
        self.model = env.get("PRACTICE_API_MODEL") or DEFAULT_MODEL
        self.base_url = (env.get("ANTHROPIC_BASE_URL") or "https://api.anthropic.com").rstrip("/")
        self.max_output_tokens = _int_env(env, "PRACTICE_API_MAX_OUTPUT_TOKENS", 700)
        self.max_requests = _int_env(env, "PRACTICE_API_MAX_REQUESTS", 20)
        self.max_input_chars = 120_000
        self.timeout = 60

    def public(self, usage: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
        if not self.enabled:
            message = "API mode is off. The interviewer and grading run offline, and copyable prompts are available for a separate Claude conversation."
        elif not self.key:
            message = "API mode is on, but ANTHROPIC_API_KEY is not set on the server. Offline answers are used instead."
        else:
            message = f"API mode is on: interviewer and feedback requests use {self.model}, billed to your API credits."
        return {"enabled": self.enabled, "has_key": bool(self.key), "ready": self.enabled and bool(self.key), "model": self.model,
                "max_output_tokens": self.max_output_tokens, "max_requests_per_session": self.max_requests, "usage": usage or {}, "message": message}


def _record_total(home: Path, usage: Dict[str, int], model: str) -> None:
    path = home / ".lab" / "api_usage.json"
    with _LOCK:
        try:
            totals = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            totals = {"requests": 0, "input_tokens": 0, "output_tokens": 0, "by_model": {}}
        totals["requests"] += 1
        totals["input_tokens"] += usage.get("input_tokens", 0)
        totals["output_tokens"] += usage.get("output_tokens", 0)
        per_model = totals["by_model"].setdefault(model, {"requests": 0, "input_tokens": 0, "output_tokens": 0})
        for key in ("input_tokens", "output_tokens"):
            per_model[key] += usage.get(key, 0)
        per_model["requests"] += 1
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(totals, indent=2), encoding="utf-8")


def complete(config: ApiConfig, system: str, prompt: str, session_usage: Dict[str, int], home: Path) -> Dict[str, Any]:
    """One Messages API request. Raises ApiError with a kind the dashboard can explain."""
    if not config.enabled:
        raise ApiError("off", "API mode is off.")
    if not config.key:
        raise ApiError("missing_key", "ANTHROPIC_API_KEY is not set on the server.")
    if session_usage.get("requests", 0) >= config.max_requests:
        raise ApiError("cap", f"This session reached its cap of {config.max_requests} API requests (PRACTICE_API_MAX_REQUESTS).")
    if len(prompt) > config.max_input_chars:
        prompt = prompt[: config.max_input_chars] + "\n… [cut to fit the input cap]"
    body = json.dumps({"model": config.model, "max_tokens": config.max_output_tokens, "system": system,
                       "messages": [{"role": "user", "content": prompt}]}).encode("utf-8")
    request = urllib.request.Request(f"{config.base_url}/v1/messages", data=body, method="POST", headers={
        "x-api-key": config.key, "anthropic-version": API_VERSION, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=config.timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        try:
            message = json.loads(detail).get("error", {}).get("message", detail)
        except ValueError:
            message = detail
        raise _classify(error.code, message, error.headers.get("retry-after")) from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ApiError("network", f"Could not reach the Anthropic API ({getattr(error, 'reason', error)}).") from None
    text = "".join(block.get("text", "") for block in data.get("content", []) if block.get("type") == "text").strip()
    usage = {"input_tokens": int(data.get("usage", {}).get("input_tokens", 0)), "output_tokens": int(data.get("usage", {}).get("output_tokens", 0))}
    _record_total(home, usage, config.model)
    return {"text": text, "usage": usage, "model": data.get("model", config.model), "stop_reason": data.get("stop_reason")}


def _classify(status: int, message: str, retry_after: Optional[str]) -> ApiError:
    lowered = message.lower()
    if "credit balance" in lowered or "billing" in lowered or status == 402:
        return ApiError("credits", "Your API credits are used up or billing is not set up. Add or claim credits in the Claude Console (Billing), or switch API mode off.")
    if status in (401, 403):
        return ApiError("auth", "The API key was rejected. Check ANTHROPIC_API_KEY.")
    if status == 429:
        wait = f" Try again in about {retry_after} seconds." if retry_after else " Wait a minute and try again."
        return ApiError("rate_limited", "The API rate limit was reached." + wait)
    if status in (500, 502, 503, 529):
        return ApiError("overloaded", "The API is temporarily unavailable or overloaded. Try again shortly.")
    if status == 404 or "model" in lowered:
        return ApiError("model", f"The API did not accept the request ({message}). Check PRACTICE_API_MODEL.")
    return ApiError("request", f"The API returned an error ({status}): {message}")


INTERVIEWER_SYSTEM = """You are the interviewer in a practice software engineering interview. Answer the candidate's clarification question in two to four sentences, using only the answer key and interviewer guide provided. Never reveal planted defects, the reference solution, grading tests, or the requirement change before it has been revealed. If the key does not cover the question, tell them to state a reasonable assumption. You are not their coding assistant: do not write code."""

FEEDBACK_SYSTEM = """You are an experienced interviewer giving feedback on a practice software engineering interview. Follow the grading instructions in the prompt exactly. Be specific, cite evidence, use "not observed" where evidence is missing, and do not treat using less AI as better. Keep it under 500 words."""
