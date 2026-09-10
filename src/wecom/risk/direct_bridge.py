#!/usr/bin/env python3
"""Persistent JSON-lines bridge that calls risk-service Python code directly."""

from __future__ import annotations

import argparse
import base64
import copy
from collections import OrderedDict
from datetime import date, datetime, timedelta
from decimal import Decimal
from functools import lru_cache, wraps
import hashlib
from zoneinfo import ZoneInfo
import sqlite3
import json
import os
import secrets
import sys
import threading
import time
import traceback
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable


WRITE_LOCK = threading.Lock()


def write_message(message: dict[str, Any]) -> None:
    with WRITE_LOCK:
        print(
            json.dumps(message, ensure_ascii=False, default=json_default),
            flush=True,
        )


def json_default(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def memoize_short_text(function: Callable[[Any], str], max_entries: int = 4096,
                       max_chars: int = 256) -> Callable[[Any], str]:
    """Bound repeated pure string conversions, not data reads or risk decisions.

    Exact built-in strings only: mutable inputs, custom __str__ implementations
    and long strings retain the original behavior and are never stored.
    """
    if getattr(function, "__risk_text_memoized__", False) is True:
        return function
    cached = lru_cache(maxsize=max(0, max_entries))(function)

    @wraps(function)
    def convert(value: Any) -> str:
        if type(value) is str and len(value) <= max_chars:
            return cached(value)
        return function(value)

    convert.cache_info = cached.cache_info
    convert.cache_clear = cached.cache_clear
    convert.__risk_text_memoized__ = True
    return convert


def install_text_memoization(checker: Any) -> None:
    # These functions depend only on their input, not the alias table, holdings,
    # rating/market data, rules, date or settings. Do not cache canonical alias
    # resolution: its mapping can change while the process remains alive.
    for name in ("clean_text", "normalize_product_name"):
        function = getattr(checker, name, None)
        if callable(function):
            setattr(checker, name, memoize_short_text(function))


class CallTimingProbe:
    """Thread-safe aggregate timings for selected backend functions.

    The probe records only function labels, counts and durations; it never stores
    arguments, SQL, product names, securities or returned business data.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._totals: dict[str, dict[str, Any]] = {}

    def wrap(self, name: str, function: Callable[..., Any]) -> Callable[..., Any]:
        original = getattr(function, "__risk_timing_original__", function)

        @wraps(original)
        def measured(*args, **kwargs):
            started = time.perf_counter()
            try:
                return original(*args, **kwargs)
            finally:
                duration_ms = (time.perf_counter() - started) * 1000
                with self._lock:
                    row = self._totals.setdefault(name, {"count": 0, "total_ms": 0.0})
                    row["count"] += 1
                    row["total_ms"] += duration_ms

        measured.__risk_timing_original__ = original
        return measured

    def snapshot(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            return {name: dict(row) for name, row in self._totals.items()}

    def since(self, before: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        after = self.snapshot()
        result: dict[str, dict[str, Any]] = {}
        for name in set(before) | set(after):
            prior = before.get(name, {})
            current = after.get(name, {})
            count = int(current.get("count", 0)) - int(prior.get("count", 0))
            total_ms = float(current.get("total_ms", 0.0)) - float(prior.get("total_ms", 0.0))
            if count > 0:
                result[name] = {"count": count, "total_ms": round(total_ms, 3)}
        return result


class DailyPQCache:
    """Persist successful PQ reads per Shanghai calendar day and exact query.

    SQLite's write transaction joins readers across bridge processes. Query
    parameters and connection are part of the key; other database reads bypass it.
    """

    def __init__(
        self,
        path: Path,
        read: Callable[..., Any],
        clock=None,
        memory_max_entries: int = 16,
        memory_max_bytes: int = 64 * 1024 * 1024,
    ) -> None:
        self.path = path
        self.read = read
        self.clock = clock or time.time
        self._metrics_lock = threading.Lock()
        self._metrics: dict[str, dict[str, Any]] = {}
        self._memory_lock = threading.Lock()
        self._memory_max_entries = max(0, memory_max_entries)
        self._memory_max_bytes = max(0, memory_max_bytes)
        self._memory_bytes = 0
        self._memory: OrderedDict[str, tuple[float, int, Any]] = OrderedDict()
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as db:
            db.execute("CREATE TABLE IF NOT EXISTS pq_reads (key TEXT PRIMARY KEY, expires_at REAL, payload TEXT)")
            db.execute(
                "CREATE TABLE IF NOT EXISTS pq_inflight "
                "(key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at REAL NOT NULL)"
            )
        path.chmod(0o600)

    @staticmethod
    def encode(value):
        if type(value).__module__.startswith("pandas.") and type(value).__name__ in {"NAType", "NaTType"}:
            return ["pandas_null", type(value).__name__]
        try:
            import pandas as pd
            if isinstance(value, pd.DataFrame):
                # Keep scalar JSON encoding in the C encoder instead of recursively
                # wrapping every cell in Python. The old "dataframe" decoder stays
                # below so today's cache can be upgraded without invalidation.
                payload = json.dumps(
                    {
                        "split": value.to_dict(orient="split"),
                        "dtypes": [str(dtype) for dtype in value.dtypes],
                    },
                    ensure_ascii=False,
                    default=DailyPQCache._dataframe_json_default,
                )
                return ["dataframe_json_v2", payload]
        except ImportError:
            pass
        try:
            import polars as pl
            if isinstance(value, pl.DataFrame):
                payload = value.serialize(format="binary")
                return ["polars_dataframe_binary", base64.b64encode(payload).decode("ascii")]
        except ImportError:
            pass
        if isinstance(value, dict):
            return ["dict", [[key, DailyPQCache.encode(item)] for key, item in value.items()]]
        if isinstance(value, (list, tuple)):
            return ["list", [DailyPQCache.encode(item) for item in value]]
        if isinstance(value, datetime):
            return ["datetime", value.isoformat()]
        if isinstance(value, date):
            return ["date", value.isoformat()]
        if isinstance(value, Decimal):
            return ["decimal", str(value)]
        if isinstance(value, bytes):
            return ["bytes", base64.b64encode(value).decode("ascii")]
        if value is None or isinstance(value, (str, int, float, bool)):
            return ["value", value]
        raise TypeError(f"Unsupported PQ value: {type(value).__name__}")

    @staticmethod
    def _dataframe_json_default(value: Any) -> Any:
        tag = "__wecom_pq_cache_type_v2__"
        if type(value).__module__.startswith("pandas.") and type(value).__name__ in {"NAType", "NaTType"}:
            return {tag: "pandas_null", "value": type(value).__name__}
        if isinstance(value, datetime):
            return {tag: "datetime", "value": value.isoformat()}
        if isinstance(value, date):
            return {tag: "date", "value": value.isoformat()}
        if isinstance(value, Decimal):
            return {tag: "decimal", "value": str(value)}
        if isinstance(value, bytes):
            return {tag: "bytes", "value": base64.b64encode(value).decode("ascii")}
        item = getattr(value, "item", None)
        if callable(item):
            converted = item()
            if converted is not value:
                return converted
        raise TypeError(f"Unsupported pandas cache value: {type(value).__name__}")

    @staticmethod
    def _dataframe_json_object_hook(value: dict[str, Any]) -> Any:
        tag = value.get("__wecom_pq_cache_type_v2__")
        item = value.get("value")
        if tag == "pandas_null":
            import pandas as pd
            return pd.NA if item == "NAType" else pd.NaT
        if tag == "datetime":
            return datetime.fromisoformat(str(item))
        if tag == "date":
            return date.fromisoformat(str(item))
        if tag == "decimal":
            return Decimal(str(item))
        if tag == "bytes":
            return base64.b64decode(str(item))
        return value

    @staticmethod
    def decode(value):
        kind, item = value
        if kind == "pandas_null":
            import pandas as pd
            return pd.NA if item == "NAType" else pd.NaT
        if kind == "dataframe_json_v2":
            import pandas as pd
            data = json.loads(item, object_hook=DailyPQCache._dataframe_json_object_hook)
            frame = pd.DataFrame(**data["split"])
            for column, dtype in zip(frame.columns, data["dtypes"]):
                frame[column] = frame[column].astype(dtype)
            return frame
        if kind == "dataframe":
            import pandas as pd
            data = DailyPQCache.decode(item)
            frame = pd.DataFrame(**data["split"])
            for column, dtype in zip(frame.columns, data["dtypes"]):
                frame[column] = frame[column].astype(dtype)
            return frame
        if kind == "polars_dataframe_binary":
            import polars as pl
            return pl.DataFrame.deserialize(base64.b64decode(item), format="binary")
        if kind == "polars_dataframe":
            # Compatibility with the first release hotfix. Those cache rows did
            # not preserve schema, so inspect every row instead of Polars' first
            # 100 rows; production credit data has late non-null issuer columns.
            import polars as pl
            return pl.DataFrame(DailyPQCache.decode(item), infer_schema_length=None)
        if kind == "dict":
            return {key: DailyPQCache.decode(v) for key, v in item}
        if kind == "list":
            return [DailyPQCache.decode(v) for v in item]
        return {"datetime": datetime.fromisoformat, "date": date.fromisoformat,
                "decimal": Decimal, "bytes": base64.b64decode,
                "value": lambda v: v}[kind](item)

    def _memory_get(self, key: str, now: float) -> tuple[bool, Any]:
        with self._memory_lock:
            entry = self._memory.get(key)
            if entry is None:
                return False, None
            expires_at, size, value = entry
            if expires_at <= now:
                self._memory.pop(key, None)
                self._memory_bytes -= size
                return False, None
            self._memory.move_to_end(key)
            return True, copy.deepcopy(value)

    def _memory_put(self, key: str, expires_at: float, payload_bytes: int, value: Any) -> None:
        if (
            self._memory_max_entries <= 0
            or self._memory_max_bytes <= 0
            or payload_bytes > self._memory_max_bytes
        ):
            return
        stored = copy.deepcopy(value)
        with self._memory_lock:
            previous = self._memory.pop(key, None)
            if previous is not None:
                self._memory_bytes -= previous[1]
            self._memory[key] = (expires_at, payload_bytes, stored)
            self._memory_bytes += payload_bytes
            while (
                len(self._memory) > self._memory_max_entries
                or self._memory_bytes > self._memory_max_bytes
            ):
                _old_key, (_expires_at, size, _value) = self._memory.popitem(last=False)
                self._memory_bytes -= size

    def _record_metric(self, outcome: str, started: float, backend_ms: float = 0.0) -> None:
        total_ms = (time.perf_counter() - started) * 1000
        with self._metrics_lock:
            row = self._metrics.setdefault(
                outcome,
                {"count": 0, "total_ms": 0.0, "backend_ms": 0.0},
            )
            row["count"] += 1
            row["total_ms"] += total_ms
            row["backend_ms"] += backend_ms

    def snapshot_metrics(self) -> dict[str, dict[str, Any]]:
        with self._metrics_lock:
            return {name: dict(row) for name, row in self._metrics.items()}

    def metrics_since(self, before: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        after = self.snapshot_metrics()
        result: dict[str, dict[str, Any]] = {}
        for name in set(before) | set(after):
            prior = before.get(name, {})
            current = after.get(name, {})
            count = int(current.get("count", 0)) - int(prior.get("count", 0))
            if count <= 0:
                continue
            result[name] = {
                "count": count,
                "total_ms": round(
                    float(current.get("total_ms", 0.0)) - float(prior.get("total_ms", 0.0)),
                    3,
                ),
                "backend_ms": round(
                    float(current.get("backend_ms", 0.0)) - float(prior.get("backend_ms", 0.0)),
                    3,
                ),
            }
        return result

    def __call__(self, connection, sql, *args, **kwargs):
        if str(connection).strip().casefold() != "pqread":
            return self.read(connection, sql, *args, **kwargs)
        metric_started = time.perf_counter()
        # Preserve SQL literals exactly, including whitespace within names.
        key = hashlib.sha256(json.dumps(self.encode(
            [connection, sql, args, sorted(kwargs.items())]
        ), ensure_ascii=False).encode()).hexdigest()
        owner = secrets.token_hex(16)
        started_at = self.clock()
        memory_hit, memory_value = self._memory_get(key, started_at)
        if memory_hit:
            self._record_metric("memory_hit", metric_started)
            return memory_value
        poll_delay = 0.05
        waited = False
        while True:
            # Cache hits never acquire SQLite's write lock, so an unrelated slow
            # database miss cannot stall already-cached queries.
            with sqlite3.connect(self.path, timeout=180) as db:
                cached = db.execute(
                    "SELECT expires_at, payload FROM pq_reads WHERE key=? AND expires_at>?",
                    (key, self.clock()),
                ).fetchone()
            if cached:
                payload = cached[1]
                value = self.decode(json.loads(payload))
                self._memory_put(key, float(cached[0]), len(payload.encode("utf-8")), value)
                self._record_metric("joined" if waited else "hit", metric_started)
                return value

            # Claim only this exact key. The write transaction is intentionally
            # short; the remote database call happens after it has committed.
            with sqlite3.connect(self.path, timeout=180) as db:
                db.execute("BEGIN IMMEDIATE")
                now = self.clock()
                db.execute("DELETE FROM pq_reads WHERE expires_at <= ?", (now,))
                cached = db.execute("SELECT expires_at, payload FROM pq_reads WHERE key=?", (key,)).fetchone()
                if cached:
                    payload = cached[1]
                    value = self.decode(json.loads(payload))
                    self._memory_put(key, float(cached[0]), len(payload.encode("utf-8")), value)
                    self._record_metric("joined" if waited else "hit", metric_started)
                    return value
                db.execute("DELETE FROM pq_inflight WHERE expires_at <= ?", (now,))
                claimed = db.execute(
                    "INSERT OR IGNORE INTO pq_inflight VALUES (?, ?, ?)",
                    (key, owner, now + 190),
                ).rowcount == 1
            if claimed:
                break
            waited = True
            time.sleep(poll_delay)
            poll_delay = min(poll_delay * 2, 0.5)

        backend_started = time.perf_counter()
        try:
            rows = self.read(connection, sql, *args, **kwargs)
            backend_ms = (time.perf_counter() - backend_started) * 1000
            payload = json.dumps(self.encode(rows), ensure_ascii=False)
            # Expire at midnight of the day this read began, even if the
            # database response arrives after midnight.
            local_now = datetime.fromtimestamp(started_at, ZoneInfo("Asia/Shanghai"))
            midnight = datetime.combine(local_now.date() + timedelta(days=1),
                                        datetime.min.time(), tzinfo=ZoneInfo("Asia/Shanghai"))
            expires_at = midnight.timestamp()
            with sqlite3.connect(self.path, timeout=180) as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute(
                    "INSERT OR REPLACE INTO pq_reads VALUES (?, ?, ?)",
                    (key, expires_at, payload),
                )
                db.execute("DELETE FROM pq_inflight WHERE key=? AND owner=?", (key, owner))
            # Persist the encoded form as L2. The L1 holds an isolated decoded copy,
            # so repeated reads in this process avoid SQLite and dataframe rebuilds.
            value = copy.deepcopy(rows)
            self._memory_put(key, expires_at, len(payload.encode("utf-8")), value)
            self._record_metric("miss", metric_started, backend_ms)
            return value
        except Exception:
            self._record_metric("error", metric_started)
            with sqlite3.connect(self.path, timeout=180) as db:
                db.execute("DELETE FROM pq_inflight WHERE key=? AND owner=?", (key, owner))
            raise


class DirectRiskService:
    def __init__(self, service_dir: Path, state_dir: Path) -> None:
        service_dir = service_dir.resolve()
        state_dir = state_dir.resolve()
        portfolio_dir = service_dir / "linked_sources" / "portfolio_limits"
        related_dir = service_dir / "linked_sources" / "related_party_query"
        if not portfolio_dir.is_dir() or not related_dir.is_dir():
            raise RuntimeError(f"risk-service 目录结构不完整：{service_dir}")
        # azpy chooses ./.env before ~/.env. Running from wecom-bot would make it
        # miss the user's ICUBECONS remote-routing config and try direct Oracle.
        os.chdir(service_dir)
        state_dir.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault(
            "POST_TRADE_HISTORY_DB",
            str(state_dir / "related_party_runtime.sqlite3"),
        )
        os.environ.setdefault(
            "PORTFOLIO_MARKET_CACHE",
            str(state_dir / "portfolio_market_cache"),
        )
        os.environ.setdefault("PINS_CACHE_DIR", str(state_dir / "pins-cache"))
        os.environ.setdefault("PINS_DATA_DIR", str(state_dir / "pins-data"))
        no_proxy = {
            item.strip()
            for item in os.environ.get("NO_PROXY", "").split(",")
            if item.strip()
        }
        no_proxy.update({"localhost", "127.0.0.1", "10.8.11.57", "icube.allianziamc.com.cn"})
        bypass = ",".join(sorted(no_proxy))
        os.environ["NO_PROXY"] = bypass
        os.environ["no_proxy"] = bypass
        for source in (str(portfolio_dir), str(related_dir), str(service_dir)):
            if source not in sys.path:
                sys.path.insert(0, source)

        startup_started = time.perf_counter()
        startup_timings: dict[str, float] = {}

        stage_started = time.perf_counter()
        import azpy
        startup_timings["import_azpy_ms"] = (time.perf_counter() - stage_started) * 1000

        stage_started = time.perf_counter()
        self._pq_cache = DailyPQCache(
            state_dir / "pq-reads-daily.sqlite3", azpy.db_read,
        )
        azpy.db_read = self._pq_cache
        startup_timings["pq_cache_init_ms"] = (time.perf_counter() - stage_started) * 1000

        stage_started = time.perf_counter()
        import check_portfolio_limits as checker
        startup_timings["import_checker_ms"] = (time.perf_counter() - stage_started) * 1000
        stage_started = time.perf_counter()
        import credit_query
        startup_timings["import_credit_ms"] = (time.perf_counter() - stage_started) * 1000
        stage_started = time.perf_counter()
        import portfolio_limits_web as web
        startup_timings["import_web_ms"] = (time.perf_counter() - stage_started) * 1000

        self.checker = checker
        self.credit_query = credit_query
        self.web = web
        install_text_memoization(self.checker)
        self._timing_probe = CallTimingProbe()
        for owner, function_name, metric_name in (
            (self.web, "resolve_pretrade_product_name", "resolve_product"),
            (self.checker, "latest_holding_date_for_product", "latest_holding_date"),
            (self.checker, "fetch_holdings", "fetch_holdings"),
            (getattr(self.web, "pretrade_scenario", self.web),
             "run_pretrade_measurement", "run_pretrade_measurement"),
            (self.checker, "prepare_full_check_context", "limit_prepare"),
            (self.checker, "evaluate_full_check_context", "limit_evaluate"),
            (self.checker, "run_full_check_pair", "limit_pair"),
        ):
            function = getattr(owner, function_name, None)
            if callable(function):
                setattr(owner, function_name, self._timing_probe.wrap(metric_name, function))
        startup_timings["total_ms"] = (time.perf_counter() - startup_started) * 1000
        self.startup_timings = {
            name: round(duration_ms, 3) for name, duration_ms in startup_timings.items()
        }
        self._related_container: Any | None = None
        self._related_lock = threading.Lock()

    def call(
        self,
        method: str,
        args: dict[str, Any],
        progress: Callable[[str], None],
    ) -> dict[str, Any]:
        if method == "ping":
            return {"ok": True}
        if method == "list_products":
            return {"products": self.web.product_list("full")}
        if method == "search_securities":
            return self.web.pretrade_security_suggestions_payload(str(args.get("query") or ""))
        if method == "check_security":
            return self._related_query(
                str(args.get("product") or ""),
                str(args.get("security") or ""),
                is_counterparty=False,
            )
        if method == "check_counterparty":
            return self._related_query(
                str(args.get("product") or ""),
                str(args.get("counterparty") or ""),
                is_counterparty=True,
            )
        if method == "get_holdings":
            return self._product_holdings(str(args.get("product") or ""))
        if method == "get_restrictions":
            return self._product_restrictions(str(args.get("product") or ""))
        if method == "get_credit":
            requested = str(args.get("entity") or "")
            entity, security = self._resolve_credit_entity(requested)
            report = self.credit_query.build_credit_report(entity)
            if security is not None:
                report["requested_entity"] = requested
                report["security_name"] = security["security_name"]
                report["security_code"] = security["security_code"]
                report["matched_queries"] = [requested]
            return report
        if method == "get_credits":
            return self._credit_reports(args.get("entities"))
        if method == "calculate_pretrade":
            return self._calculate_pretrade(
                str(args.get("product") or ""),
                args.get("action"),
                progress,
            )
        raise ValueError(f"不支持的直接调用方法：{method}")

    @staticmethod
    def _credit_match_key(value: Any) -> str:
        return "".join(unicodedata.normalize("NFKC", str(value or "")).split()).casefold()

    def _resolve_credit_entity(self, requested: str) -> tuple[str, dict[str, str] | None]:
        """Resolve an exact JYDB security name/code to its issuer."""
        query_key = self._credit_match_key(requested)
        if not query_key:
            return requested, None
        try:
            payload = self.web.pretrade_security_suggestions_payload(requested)
        except Exception:
            # JYDB lookup must not make an ordinary entity query unavailable.
            return requested, None
        suggestions = payload.get("suggestions") if isinstance(payload, dict) else None
        exact: list[dict[str, str]] = []
        for raw in suggestions if isinstance(suggestions, list) else []:
            if not isinstance(raw, dict):
                continue
            code = str(raw.get("security_code") or "").strip()
            name = str(raw.get("security_name") or "").strip()
            code_key = self._credit_match_key(code)
            base_code_key = self._credit_match_key(code.partition(".")[0])
            if query_key not in {self._credit_match_key(name), code_key, base_code_key}:
                continue
            exact.append({
                "security_code": code,
                "security_name": name,
                "issuer_name": str(raw.get("issuer_name") or "").strip(),
            })
        if not exact:
            return requested, None
        issuers = {item["issuer_name"] for item in exact if item["issuer_name"]}
        if not issuers:
            raise ValueError(f"JYDB未返回证券“{requested}”的发行人")
        if len(issuers) != 1:
            raise ValueError(f"证券“{requested}”匹配到多个发行人，请使用证券代码查询")
        selected = next(item for item in exact if item["issuer_name"] in issuers)
        return selected["issuer_name"], selected

    def _credit_reports(self, entities: Any) -> dict[str, Any]:
        if (
            not isinstance(entities, list)
            or not entities
            or any(not isinstance(item, str) for item in entities)
        ):
            return self.credit_query.build_credit_reports(entities)

        resolved: list[str | None] = [None] * len(entities)
        resolution_errors: list[dict[str, str]] = []

        def resolve(index: int, requested: str) -> tuple[int, str, str | None]:
            try:
                entity, _security = self._resolve_credit_entity(requested)
                return index, entity, None
            except ValueError as exc:
                return index, requested, str(exc)

        # Bound JYDB concurrency so a long multi-name request stays well within
        # the bridge timeout without opening an unbounded number of connections.
        with ThreadPoolExecutor(max_workers=min(4, len(entities))) as pool:
            for index, entity, error in pool.map(
                lambda item: resolve(*item),
                enumerate(entities),
            ):
                if error:
                    resolution_errors.append({
                        "query": entities[index],
                        "code": "security_issuer_resolution",
                        "message": error,
                    })
                else:
                    resolved[index] = entity

        originals_by_entity: dict[str, list[str]] = {}
        unique_entities: list[str] = []
        for original, entity in zip(entities, resolved):
            if entity is None:
                continue
            key = self._credit_match_key(entity)
            originals = originals_by_entity.setdefault(key, [])
            if original not in originals:
                originals.append(original)
            if entity not in unique_entities:
                unique_entities.append(entity)

        if unique_entities:
            data = self.credit_query.build_credit_reports(unique_entities)
        else:
            data = {"date": "", "amount_unit": "CNY", "reports": [], "unmatched": [], "errors": []}

        def original_queries(value: Any) -> list[str]:
            key = self._credit_match_key(value)
            return originals_by_entity.get(key, [str(value or "")])

        reports = data.get("reports") if isinstance(data.get("reports"), list) else []
        for report in reports:
            if not isinstance(report, dict):
                continue
            matched = report.get("matched_queries")
            rewritten: list[str] = []
            for query in matched if isinstance(matched, list) else []:
                for original in original_queries(query):
                    if original not in rewritten:
                        rewritten.append(original)
            report["matched_queries"] = rewritten

        unmatched = data.get("unmatched") if isinstance(data.get("unmatched"), list) else []
        data["unmatched"] = [
            original
            for query in unmatched
            for original in original_queries(query)
        ]
        errors = data.get("errors") if isinstance(data.get("errors"), list) else []
        rewritten_errors: list[dict[str, Any]] = []
        for raw in errors:
            if not isinstance(raw, dict):
                continue
            originals = original_queries(raw.get("query"))
            rewritten_errors.extend(dict(raw, query=original) for original in originals)
        data["errors"] = rewritten_errors + resolution_errors
        return data

    def _container(self) -> Any:
        with self._related_lock:
            if self._related_container is None:
                from backend.container import ApplicationContainer

                self._related_container = ApplicationContainer()
            return self._related_container

    def _related_query(
        self,
        product: str,
        value: str,
        *,
        is_counterparty: bool,
    ) -> dict[str, Any]:
        response = self._container().related_party_query(
            ptf=product,
            security_name=value,
            is_cpty=is_counterparty,
            is_ipo=False,
            check_custodian=False,
        )
        return response.model_dump(mode="json")

    def _resolve_product(self, requested: str) -> tuple[str, float]:
        cleaned = self.checker.clean_text(requested)
        if not cleaned:
            raise ValueError("必须提供产品名称")
        product, score = self.web.resolve_pretrade_product_name(cleaned)
        if score < 0.35:
            raise ValueError(f"未找到与产品“{cleaned}”匹配的产品")
        return product, score

    def _product_holdings(self, requested: str) -> dict[str, Any]:
        product, score = self._resolve_product(requested)
        check_date = self.checker.latest_holding_date_for_product("pqread", product)
        if not check_date:
            raise ValueError(f"PQ未返回产品“{product}”的可用持仓日期")
        rows = self.checker.fetch_holdings(check_date, "pqread", product)
        holdings = []
        for row in rows:
            holdings.append({
                "date": check_date,
                "product_name": self.checker.clean_text(self.checker.field(row, "PTF_NAME_FULL"))
                or self.checker.clean_text(self.checker.field(row, "PTF_NAME"))
                or product,
                "security_code": self.checker.clean_text(self.checker.field(row, "SEC_CODE")),
                "security_name": self.checker.clean_text(self.checker.field(row, "SEC_NAME")),
                "quantity": self.checker.as_float(self.checker.field(row, "QTY")),
                "cost": self.checker.as_float(self.checker.field(row, "AMORTIZED_COST_LC")),
                "book_value": self.checker.as_float(self.checker.field(row, "AV_BV_LC")),
                "market_value": self.checker.as_float(self.checker.field(row, "AV_MV_LC")),
                "security_type": self.checker.clean_text(self.checker.field(row, "AC_CN"))
                or self.checker.clean_text(self.checker.field(row, "AC")),
            })
        return {
            "requested_product": requested,
            "product": product,
            "product_match_score": score,
            "date": check_date,
            "holdings": holdings,
            "total_rows": len(holdings),
        }

    def _product_restrictions(self, requested: str) -> dict[str, Any]:
        product, score = self._resolve_product(requested)
        scope = self.web.ledger_payload("full", "scope", product=product, limit=10_000)
        limits = self.web.ledger_payload("full", "limit", product=product, limit=10_000)
        scope_rows = scope.get("rows", [])
        limit_rows = limits.get("rows", [])
        if not scope_rows:
            raise ValueError(f"投资范围台账中没有产品“{product}”")
        return {
            "requested_product": requested,
            "product": product,
            "product_match_score": score,
            "investment_scope": scope_rows,
            "investment_restrictions": limit_rows,
            "scope_columns": scope.get("columns", []),
            "restriction_columns": limits.get("columns", []),
            "scope_total": scope.get("matched_rows", len(scope_rows)),
            "restriction_total": limits.get("matched_rows", len(limit_rows)),
        }

    def _calculate_pretrade(
        self,
        product: str,
        raw_action: Any,
        progress: Callable[[str], None],
    ) -> dict[str, Any]:
        if isinstance(raw_action, dict):
            actions = [raw_action]
        elif isinstance(raw_action, list):
            if not raw_action:
                raise ValueError("测算场景列表不能为空")
            for index, action in enumerate(raw_action):
                if not isinstance(action, dict):
                    raise ValueError(f"第{index + 1}个测算场景必须是 JSON 对象")
            actions = raw_action
        else:
            raise ValueError("测算场景必须是对象")

        total_started = time.perf_counter()
        timing_probe = getattr(self, "_timing_probe", None)
        pq_cache = getattr(self, "_pq_cache", None)
        function_before = timing_probe.snapshot() if timing_probe else {}
        pq_before = pq_cache.snapshot_metrics() if pq_cache else {}
        submit_started = time.perf_counter()
        run = self.web.start_pretrade_run({"product": product, "actions": actions})
        submit_ms = (time.perf_counter() - submit_started) * 1000
        run_id = str(run["id"])
        last_progress = ""
        poll_started = time.perf_counter()
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            with self.web.PRETRADE_RUNS_LOCK:
                current = dict(self.web.PRETRADE_RUNS.get(run_id, {}))
            if not current:
                raise RuntimeError(f"找不到投前测算任务：{run_id}")
            message = str(current.get("progress") or "")
            if message and message != last_progress:
                last_progress = message
                progress(message)
            if current.get("status") in {"success", "error"}:
                current.pop("traceback", None)
                bridge_timings: dict[str, Any] = {
                    "total_ms": round((time.perf_counter() - total_started) * 1000, 3),
                    "submit_ms": round(submit_ms, 3),
                    "poll_ms": round((time.perf_counter() - poll_started) * 1000, 3),
                    "attribution": "process_aggregate_window",
                }
                if timing_probe:
                    bridge_timings["functions"] = timing_probe.since(function_before)
                if pq_cache:
                    bridge_timings["pq"] = pq_cache.metrics_since(pq_before)
                current["bridge_timings"] = bridge_timings
                return current
            time.sleep(0.1)
        raise TimeoutError("risk-service 本地测算超过180秒")


def handle_request(service: DirectRiskService, request: dict[str, Any],
                   cancelled: threading.Event | None = None,
                   deadline: float | None = None) -> None:
    request_id = str(request.get("id") or "")
    try:
        if cancelled is not None and cancelled.is_set():
            return
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("请求在队列中已过期")
        method = str(request.get("method") or "")
        args = request.get("args")
        if not isinstance(args, dict):
            args = {}
        result = service.call(
            method,
            args,
            lambda message: write_message({
                "id": request_id,
                "type": "progress",
                "message": message,
            }) if cancelled is None or not cancelled.is_set() else None,
        )
        if cancelled is None or not cancelled.is_set():
            write_message({"id": request_id, "type": "result", "data": result})
    except Exception as exc:
        if cancelled is not None and cancelled.is_set():
            return
        traceback.print_exc(file=sys.stderr)
        write_message({
            "id": request_id,
            "type": "error",
            "error": f"{type(exc).__name__}: {exc}",
        })


class RequestDispatcher:
    """Bound admission and cancel queued requests without killing shared workers.

    A running risk-service call has no cooperative cancellation API. It keeps
    its slot until completion, and its late progress/result is suppressed.
    """
    def __init__(self, service: DirectRiskService, executor: ThreadPoolExecutor,
                 max_pending: int = 32) -> None:
        self.service = service
        self.executor = executor
        self.slots = threading.BoundedSemaphore(max_pending)
        self.lock = threading.RLock()
        self.requests: dict[str, tuple[threading.Event, Any]] = {}

    def submit(self, request: dict[str, Any]) -> None:
        request_id = str(request.get("id") or "")
        if not request_id:
            write_message({"type": "error", "error": "请求缺少id"})
            return
        if request.get("method") == "cancel":
            with self.lock:
                pending = self.requests.get(request_id)
                if pending:
                    pending[0].set()
                    pending[1].cancel()
            return
        with self.lock:
            if request_id in self.requests:
                write_message({"id": request_id, "type": "error", "error": "重复请求id"})
                return
            if not self.slots.acquire(blocking=False):
                write_message({"id": request_id, "type": "error",
                               "error": "risk-service 当前任务较多", "code": "direct-capacity"})
                return
            cancelled = threading.Event()
            try:
                timeout_ms = float(request.get("timeout_ms") or 180_000)
                if not 0 < timeout_ms <= 180_000:
                    timeout_ms = 180_000
                deadline = time.monotonic() + timeout_ms / 1000
                future = self.executor.submit(handle_request, self.service, request, cancelled, deadline)
            except Exception as exc:
                self.slots.release()
                write_message({"id": request_id, "type": "error", "error": str(exc)})
                return
            self.requests[request_id] = (cancelled, future)

            def completed(_future: Any) -> None:
                with self.lock:
                    self.requests.pop(request_id, None)
                    self.slots.release()
            future.add_done_callback(completed)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service-dir", required=True, type=Path)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    service = DirectRiskService(args.service_dir, args.state_dir)
    write_message({"type": "ready", "startup_timings": service.startup_timings})
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 8))) as executor:
        dispatcher = RequestDispatcher(service, executor)
        for line in sys.stdin:
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("请求必须是 JSON 对象")
            except Exception as exc:
                write_message({"type": "error", "error": f"输入无效：{exc}"})
                continue
            dispatcher.submit(request)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
