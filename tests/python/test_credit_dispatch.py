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
        service.web = SimpleNamespace(
            pretrade_security_suggestions_payload=Mock(return_value={"suggestions": []}),
        )
        service.credit_query = SimpleNamespace(
            build_credit_reports=Mock(return_value={"reports": []}),
            build_credit_report=Mock(return_value={"entity": "甲"}),
        )
        self.assertEqual(service.call("get_credits", {"entities": ["甲", "乙"]}, lambda _: None), {"reports": []})
        service.credit_query.build_credit_reports.assert_called_once_with(["甲", "乙"])
        self.assertEqual(service.call("get_credit", {"entity": "甲"}, lambda _: None), {"entity": "甲"})
        service.credit_query.build_credit_report.assert_called_once_with("甲")

    def test_resolves_exact_security_name_to_jydb_issuer_before_credit_query(self):
        service = bridge.DirectRiskService.__new__(bridge.DirectRiskService)
        service.web = SimpleNamespace(pretrade_security_suggestions_payload=Mock(return_value={
            "suggestions": [{
                "security_code": "232580009.IB",
                "security_name": "25中信银行二级资本债01BC",
                "issuer_name": "中信银行股份有限公司",
            }],
        }))
        service.credit_query = SimpleNamespace(build_credit_report=Mock(return_value={
            "entity": "中信银行股份有限公司",
        }))

        result = service.call(
            "get_credit",
            {"entity": "25中信银行二级资本债01BC"},
            lambda _: None,
        )

        service.web.pretrade_security_suggestions_payload.assert_called_once_with("25中信银行二级资本债01BC")
        service.credit_query.build_credit_report.assert_called_once_with("中信银行股份有限公司")
        self.assertEqual(result["entity"], "中信银行股份有限公司")
        self.assertEqual(result["security_code"], "232580009.IB")
        self.assertEqual(result["matched_queries"], ["25中信银行二级资本债01BC"])

    def test_does_not_treat_issuer_only_suggestion_as_exact_security(self):
        service = bridge.DirectRiskService.__new__(bridge.DirectRiskService)
        service.web = SimpleNamespace(pretrade_security_suggestions_payload=Mock(return_value={
            "suggestions": [{
                "security_code": "232580009.IB",
                "security_name": "25中信银行二级资本债01BC",
                "issuer_name": "中信银行股份有限公司",
            }],
        }))
        service.credit_query = SimpleNamespace(build_credit_report=Mock(return_value={
            "entity": "中信银行股份有限公司",
        }))

        service.call("get_credit", {"entity": "中信银行股份有限公司"}, lambda _: None)

        service.credit_query.build_credit_report.assert_called_once_with("中信银行股份有限公司")


if __name__ == "__main__":
    unittest.main()
