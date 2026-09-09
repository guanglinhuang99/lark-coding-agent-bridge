"""Test the configured credit module with database/framework dependencies isolated."""
import importlib.util
import os
from pathlib import Path
import re
import sys
from types import ModuleType
import unittest
from unittest.mock import Mock, patch
from datetime import date, timedelta


ROOT = Path(__file__).resolve().parents[2]
SERVICE = Path(os.environ.get("WECOM_RISK_SERVICE_DIR", ROOT / "risk-service"))


@unittest.skipUnless((SERVICE / "credit_query.py").is_file(), "local risk-service not configured")
class CreditBackendTests(unittest.TestCase):
    def setUp(self):
        # Only infrastructure dependencies are replaced. The complete production
        # credit_query.py is imported and all batch/date/report functions run.
        checker = ModuleType("check_portfolio_limits")
        checker.clean_text = lambda value: "" if value is None else str(value).strip()
        checker.field = lambda row, key: row.get(key)
        checker.run_db_read = Mock(return_value=[{"D": "2026-09-08"}])
        pretrade = ModuleType("pretrade_credit")
        pretrade._name_key = lambda value: re.sub(r"(?:股份有限公司|有限责任公司|有限公司)$", "", str(value).strip()).casefold()
        pretrade.RATING_CREDIT_PIN = "test_limits"
        pretrade.clear_credit_data_snapshot_cache = Mock()
        modules = {"check_portfolio_limits": checker, "pretrade_credit": pretrade,
                   "portfolio_restriction_checks": ModuleType("portfolio_restriction_checks"),
                   "pandas": ModuleType("pandas")}
        spec = importlib.util.spec_from_file_location("credit_under_test", SERVICE / "credit_query.py")
        self.query = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, modules):
            spec.loader.exec_module(self.query)
        self.names = {"测试银行甲": "测试银行甲有限公司", "测试银行乙": "测试银行乙有限公司"}
        self.limits = {key: {"group_internal": 100.0, "third_party": None} for key in self.names}
        self.used = {key: {"group_internal": 125.0, "third_party": 20.0} for key in self.names}
        self.query._load_credit_limits = Mock(return_value=(self.limits, self.names))
        self.query._load_used_credit = Mock(return_value=(self.used, self.names))

    def test_fuzzy_multi_match_dedup_unknown_and_shared_reads(self):
        result = self.query.build_credit_reports(["测试银行", "测试银行甲有限公司", "未知"], "2026-09-08")
        self.assertEqual({r["entity"] for r in result["reports"]}, set(self.names.values()))
        first = next(r for r in result["reports"] if r["entity"] == "测试银行甲有限公司")
        self.assertEqual(first["matched_queries"], ["测试银行", "测试银行甲有限公司"])
        self.assertEqual(result["unmatched"], ["未知"])
        self.query._load_credit_limits.assert_called_once_with()
        self.query._load_used_credit.assert_called_once_with("2026-09-08", self.names)

    def test_batch_amounts_equal_single_and_preserve_missing_and_excess(self):
        batch = self.query.build_credit_reports(["测试银行甲有限公司"], "2026-09-08")["reports"][0]
        single = self.query.build_credit_report("测试银行甲有限公司", "2026-09-08")
        for category in ("group_internal", "third_party", "total"):
            self.assertEqual(batch[category], single[category])
        self.assertEqual(batch["group_internal"]["remaining_credit_yuan"], 0)
        self.assertEqual(batch["group_internal"]["status"], "OVER_LIMIT")
        self.assertIsNone(batch["third_party"]["credit_limit_yuan"])
        self.assertIsNone(batch["third_party"]["remaining_credit_yuan"])
        self.assertEqual(batch["third_party"]["used_credit_yuan"], 20)

    def test_latest_date_includes_today_and_batch_refreshes_cached_date(self):
        self.query._LATEST_DATE_CACHE[date.today().isoformat()] = (self.query.monotonic(), "2026-09-07")
        result = self.query.build_credit_reports(["测试银行甲"])
        self.assertEqual(result["date"], "2026-09-08")
        self.query.checker.run_db_read.assert_called_once()
        args, kwargs = self.query.checker.run_db_read.call_args
        self.assertIn("SELECT REF_DATE", args[1])
        self.assertIn("REF_DATE = :check_date", args[1])
        self.assertEqual(kwargs["params"]["check_date"], date.today())

    def test_latest_date_walks_back_from_today_and_stops_on_first_available(self):
        self.query.checker.run_db_read.side_effect = [[], [{"D": "2026-09-07"}]]
        result = self.query._latest_credit_date(date(2026, 9, 8), force_refresh=True)
        self.assertEqual(result, "2026-09-07")
        calls = self.query.checker.run_db_read.call_args_list
        self.assertEqual([call.kwargs["params"]["check_date"] for call in calls],
                         [date(2026, 9, 8), date(2026, 9, 7)])
        self.assertTrue(all("MAX(" not in call.args[1] for call in calls))

    def test_older_holdings_remain_discoverable_after_recent_probes(self):
        self.query.checker.run_db_read.side_effect = [[]] * 7 + [[{"D": "2026-08-01"}]]
        self.assertEqual(self.query._latest_credit_date(date(2026, 9, 8)), "2026-08-01")
        final = self.query.checker.run_db_read.call_args
        self.assertIn("MAX(REF_DATE)", final.args[1])
        self.assertEqual(final.kwargs["params"]["as_of"], date(2026, 9, 1))

    def test_no_date_or_failed_holdings_never_becomes_zero_usage(self):
        self.query.checker.run_db_read.return_value = [{"D": None}]
        with self.assertRaises(ValueError):
            self.query.build_credit_reports(["测试银行甲"])
        self.query._load_used_credit.assert_not_called()
        self.query._load_used_credit.side_effect = RuntimeError("database unavailable")
        with self.assertRaises(RuntimeError):
            self.query.build_credit_reports(["测试银行甲"], "2026-09-08")

    def test_invalid_input_is_rejected_before_database_reads(self):
        for value in (None, "甲", [], [1], [""], ["x" * 201], ["甲"] * 51):
            with self.subTest(value=type(value).__name__), self.assertRaises(ValueError):
                self.query.build_credit_reports(value)
        self.query.checker.run_db_read.assert_not_called()
        self.query._load_credit_limits.assert_not_called()

    def test_too_many_matches_does_not_silently_truncate(self):
        names = {f"银行{i}": f"银行{i}有限公司" for i in range(51)}
        self.query._load_credit_limits.return_value = ({}, names)
        self.query._load_used_credit.return_value = ({}, {})
        result = self.query.build_credit_reports(["银行"], "2026-09-08")
        self.assertEqual(result["reports"], [])
        self.assertEqual(result["errors"], [{"query": "银行", "code": "too_many_matches", "count": 51}])

    def test_total_batch_cap_keeps_prior_successes(self):
        names = {f"银行{i}": f"银行{i}有限公司" for i in range(50)}
        names["保险甲"] = "保险甲有限公司"
        self.query._load_credit_limits.return_value = ({}, names)
        self.query._load_used_credit.return_value = ({}, {})
        result = self.query.build_credit_reports(["银行", "保险甲"], "2026-09-08")
        self.assertEqual(len(result["reports"]), 50)
        self.assertEqual(result["errors"][0]["query"], "保险甲")
        self.assertEqual(result["errors"][0]["code"], "too_many_matches")


if __name__ == "__main__":
    unittest.main()
