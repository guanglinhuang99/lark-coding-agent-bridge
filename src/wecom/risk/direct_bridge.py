#!/usr/bin/env python3
"""Persistent JSON-lines bridge that calls risk-service Python code directly."""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import traceback
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


class DirectRiskService:
    def __init__(self, service_dir: Path, state_dir: Path) -> None:
        service_dir = service_dir.resolve()
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

        import check_portfolio_limits as checker
        import credit_query
        import portfolio_limits_web as web

        self.checker = checker
        self.credit_query = credit_query
        self.web = web
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
            return self.credit_query.build_credit_report(str(args.get("entity") or ""))
        if method == "calculate_pretrade":
            return self._calculate_pretrade(
                str(args.get("product") or ""),
                args.get("action"),
                progress,
            )
        raise ValueError(f"不支持的直接调用方法：{method}")

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
        if not isinstance(raw_action, dict):
            raise ValueError("测算场景必须是对象")
        run = self.web.start_pretrade_run({"product": product, "actions": [raw_action]})
        run_id = str(run["id"])
        last_progress = ""
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
                return current
            time.sleep(0.05)
        raise TimeoutError("risk-service 本地测算超过180秒")


def handle_request(service: DirectRiskService, request: dict[str, Any]) -> None:
    request_id = str(request.get("id") or "")
    try:
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
            }),
        )
        write_message({"id": request_id, "type": "result", "data": result})
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        write_message({
            "id": request_id,
            "type": "error",
            "error": f"{type(exc).__name__}: {exc}",
        })


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service-dir", required=True, type=Path)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    service = DirectRiskService(args.service_dir, args.state_dir)
    write_message({"type": "ready"})
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 8))) as executor:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("请求必须是 JSON 对象")
            except Exception as exc:
                write_message({"type": "error", "error": f"输入无效：{exc}"})
                continue
            executor.submit(handle_request, service, request)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
