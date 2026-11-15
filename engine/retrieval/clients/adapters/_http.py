"""Tiny shared HTTP seam for the reference adapters that need more than a plain GET (headers, POST bodies, retries).

`_urlopen` is the module-level seam tests replace; production uses urllib. Every failure is raised as `FetchError`
with a message a reviewer can read, and each adapter turns it into a degraded result - never into an exception that
reaches a pipeline, never into an empty "nothing found" answer.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

_urlopen = urllib.request.urlopen          # test seam
USER_AGENT = "speckle/0.1 (reference adapters)"


class FetchError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def cache_dir(name: str) -> Path:
    try:
        from engine.retrieval.settings import load_settings
        root = Path(load_settings().data_dir)
    except Exception:
        root = Path(os.environ.get("NISAR_DATA_DIR") or "data")
    d = root / "cache" / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def cache_get(name: str, key: str, ttl_s: float):
    try:
        p = cache_dir(name) / f"{key}.json"
        if p.exists() and time.time() - p.stat().st_mtime < ttl_s:
            return json.loads(p.read_text())
    except Exception:
        return None
    return None


def cache_put(name: str, key: str, payload) -> None:
    try:
        (cache_dir(name) / f"{key}.json").write_text(json.dumps(payload))
    except Exception:
        pass                                 # a cache write never breaks a fetch


def key_of(*parts) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()


def request(url: str, *, method: str = "GET", headers: dict | None = None, body: bytes | None = None,
            timeout_s: float = 30.0, retries: int = 1) -> tuple[bytes, str]:
    """-> (body bytes, sha256 hex). Retries once on a dropped connection / 5xx; 4xx are final."""
    hdrs = {"User-Agent": USER_AGENT, **(headers or {})}
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
            with _urlopen(req, timeout=timeout_s) as resp:
                data = resp.read()
            return data, hashlib.sha256(data).hexdigest()
        except urllib.error.HTTPError as ex:
            if ex.code < 500:
                raise FetchError(f"HTTP {ex.code} from {url.split('?')[0]}", status=ex.code) from ex
            last = ex
        except (urllib.error.URLError, TimeoutError, OSError) as ex:
            last = ex
        time.sleep(0.2 * (attempt + 1))
    raise FetchError(f"{url.split('?')[0]} unreachable: {last}")


def provenance(adapter: str, url_or_id: str, sha256: str | None = None) -> dict:
    from datetime import datetime, timezone
    return {"adapter": adapter, "url_or_id": url_or_id,
            "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "sha256": sha256}
