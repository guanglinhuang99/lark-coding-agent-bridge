"""Credit batch bridge dispatch without database dependencies."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location(
    "credit_bridge", Path(__file__).resolve().parents[2] / "src/wecom/risk/direct_bridge.py"
)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class CreditDispatchTests(unittest.TestCase):
    def test_dispatches_one_batch_and_preserves_single_query(self):
        service = bridge.DirectRiskService.__new__(bridge.DirectRiskService)
        service.credit_query = SimpleNamespace(
            build_credit_reports=Mock(return_value={"reports": []}),
            build_credit_report=Mock(return_value={"entity": "甲"}),
        )
        self.assertEqual(service.call("get_credits", {"entities": ["甲", "乙"]}, lambda _: None), {"reports": []})
        service.credit_query.build_credit_reports.assert_called_once_with(["甲", "乙"])
        self.assertEqual(service.call("get_credit", {"entity": "甲"}, lambda _: None), {"entity": "甲"})
        service.credit_query.build_credit_report.assert_called_once_with("甲")


if __name__ == "__main__":
    unittest.main()
