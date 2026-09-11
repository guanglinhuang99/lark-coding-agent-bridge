"""Bounded pure-string hot-path memoization, without business-data caches."""
import importlib.util
import json
import os
import re
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location(
    'text_cache_bridge', Path(__file__).resolve().parents[2] / 'src/wecom/risk/direct_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

configured_service = os.environ.get('RISK_SERVICE_DIR')
service_dir = Path(
    configured_service if configured_service is not None
    else Path(__file__).resolve().parents[2] / 'risk-service'
).resolve()
portfolio_dir = service_dir / 'linked_sources' / 'portfolio_limits'
checker = None
if (portfolio_dir / 'check_portfolio_limits.py').is_file():
    sys.path.insert(0, str(portfolio_dir))
    import check_portfolio_limits as checker
elif configured_service is not None:
    raise RuntimeError('RISK_SERVICE_DIR does not contain the shared portfolio checker')


def clean(value):
    return '' if value is None else re.sub(r'\s+', ' ', str(value).replace('\u3000', ' ').strip())


def normalize(value):
    text = clean(value)
    for suffix in ('集合资产管理产品', '资产管理产品', '专项产品', '资管产品', '产品'):
        if text.endswith(suffix):
            text = text[:-len(suffix)]
    return re.sub(r'\s+', '', text)


@unittest.skipIf(checker is None, 'Shared backend unavailable; set RISK_SERVICE_DIR for integration tests')
class TextMemoTests(unittest.TestCase):
    def test_preserves_values_and_exact_cache_keys(self):
        source = Mock(side_effect=normalize)
        cached = checker.memoize_short_text(source)
        samples = ['产品甲资产管理产品', '产品甲 产品', ' 产品甲\u3000资产管理产品 ', '', '\n\t', '甲集合资产管理产品']
        for value in samples:
            self.assertEqual(cached(value), normalize(value))
            self.assertEqual(cached(value), normalize(value))
        self.assertEqual(source.call_count, len(samples))
        self.assertEqual(cached.cache_info().currsize, len(samples))

    def test_bypasses_mutable_values_and_custom_string_conversion(self):
        class Mutable:
            value = 'A'
            def __str__(self):
                return self.value
        value = Mutable()
        cached = checker.memoize_short_text(clean)
        self.assertEqual(cached(value), 'A')
        value.value = 'B'
        self.assertEqual(cached(value), 'B')
        for raw in (None, 1, 1.0, ['A'], {'name': 'A'}):
            self.assertEqual(cached(raw), clean(raw))
        self.assertEqual(cached.cache_info().currsize, 0)

    def test_bypasses_string_subclasses_and_large_strings(self):
        class String(str):
            pass
        source = Mock(side_effect=clean)
        cached = checker.memoize_short_text(source, max_chars=4)
        for raw in (String('A'), '12345'):
            cached(raw)
            cached(raw)
        self.assertEqual(source.call_count, 4)
        self.assertEqual(cached.cache_info().currsize, 0)

    def test_lru_bound_clear_and_disabled_cache(self):
        source = Mock(side_effect=clean)
        cached = checker.memoize_short_text(source, max_entries=2)
        for value in ('A', 'B', 'C', 'A'):
            cached(value)
        self.assertEqual(source.call_count, 4)
        self.assertEqual(cached.cache_info().currsize, 2)
        cached.cache_clear()
        self.assertEqual(cached.cache_info().currsize, 0)
        uncached = checker.memoize_short_text(clean, max_entries=0)
        uncached('A')
        self.assertEqual(uncached.cache_info().currsize, 0)

    def test_exceptions_are_not_cached(self):
        source = Mock(side_effect=[ValueError('temporary'), 'ok'])
        cached = checker.memoize_short_text(source)
        with self.assertRaises(ValueError):
            cached('A')
        self.assertEqual(cached('A'), 'ok')
        self.assertEqual(cached('A'), 'ok')
        self.assertEqual(source.call_count, 2)

    def test_concurrent_conversion_preserves_results_and_bound(self):
        cached = checker.memoize_short_text(normalize, max_entries=8)
        samples = [f'产品{i % 5}资产管理产品' for i in range(200)]
        with ThreadPoolExecutor(4) as pool:
            self.assertEqual(list(pool.map(cached, samples)), list(map(normalize, samples)))
        self.assertLessEqual(cached.cache_info().currsize, 8)

    def test_shared_install_is_idempotent_and_keeps_alias_resolution_live(self):
        self.assertNotIn('install_text_memoization', vars(bridge))
        for function in (checker.clean_text, checker.normalize_product_name):
            self.assertIs(checker.memoize_short_text(function), function)
            self.assertIs(getattr(function, '__risk_text_memoized__', False), True)
            self.assertIs(getattr(function.__wrapped__, '__risk_text_memoized__', False), False)

        canonical = 'Codex缓存规范名'
        previous = checker.PRODUCT_HOLDING_NAME_ALIASES.get(canonical)
        try:
            checker.PRODUCT_HOLDING_NAME_ALIASES[canonical] = {'Codex缓存测试产品'}
            self.assertEqual(
                checker.canonical_product_name_for_holding('Codex缓存测试产品'), canonical)
            checker.PRODUCT_HOLDING_NAME_ALIASES[canonical] = {'另一个动态别名产品'}
            self.assertEqual(checker.canonical_product_name_for_holding('Codex缓存测试产品'), '')
            self.assertEqual(
                checker.canonical_product_name_for_holding('另一个动态别名产品'), canonical)
        finally:
            if previous is None:
                checker.PRODUCT_HOLDING_NAME_ALIASES.pop(canonical, None)
            else:
                checker.PRODUCT_HOLDING_NAME_ALIASES[canonical] = previous

    def test_conversion_and_timing_preserve_callable_metadata(self):
        cached = checker.memoize_short_text(normalize)
        self.assertEqual(cached.__name__, 'normalize')
        probe = bridge.CallTimingProbe()
        measured = probe.wrap('normalize', cached)
        self.assertEqual(measured.__name__, 'normalize')
        self.assertEqual(measured('A产品'), 'A')
        self.assertEqual(probe.snapshot()['normalize']['count'], 1)

    def test_authoritative_functions_match_original_pure_functions(self):
        samples = [
            None, '', 'A', ' A\u3000 B ', '\nA\tB\n',
            '产品甲集合资产管理产品', '产品甲资产管理产品',
            '产品甲专项产品', '产品甲资管产品', '产品甲产品',
            '产品甲资产管理产品附加', 1, 1.0, ['A'], {'name': 'A'},
        ]
        for value in samples:
            self.assertEqual(checker.clean_text(value), clean(value))
            self.assertEqual(checker.normalize_product_name(value), normalize(value))

    def test_bridge_capability_reports_optimized_and_old_backend_fallback(self):
        capability = bridge.shared_text_capability(checker)
        self.assertEqual(capability['shared_text_memoization'], 'optimized')
        self.assertEqual(capability['functions']['clean_text']['max_entries'], 4096)
        old_checker = SimpleNamespace(clean_text=clean, normalize_product_name=normalize)
        old_capability = bridge.shared_text_capability(old_checker)
        self.assertEqual(old_capability['shared_text_memoization'], 'unoptimized')
        self.assertIsNone(old_capability['functions']['clean_text']['max_entries'])

    def test_backend_and_bridge_imports_are_independent_processes(self):
        common = (
            "import json, os, sys; from pathlib import Path; "
            "root=Path(os.environ['RISK_SERVICE_DIR']); "
            "sys.path[:0]=[str(root/'linked_sources'/'portfolio_limits'),str(root)]; "
        )
        scripts = [
            common +
            "import check_portfolio_limits as c; "
            "print(json.dumps({'optimized':c.clean_text.__risk_text_memoized__,"
            "'value':c.normalize_product_name(' 产品甲 资产管理产品 '),"
            "'maxsize':c.clean_text.cache_info().maxsize}))",
            common +
            "import importlib.util; "
            f"s=importlib.util.spec_from_file_location('bridge',{str(Path(bridge.__file__))!r}); "
            "b=importlib.util.module_from_spec(s); s.loader.exec_module(b); "
            "import check_portfolio_limits as c; print(json.dumps(b.shared_text_capability(c)))",
        ]
        outputs = []
        environment = {**os.environ, 'RISK_SERVICE_DIR': str(service_dir)}
        for script in scripts:
            result = subprocess.run(
                [sys.executable, '-c', script],
                cwd=service_dir,
                env=environment,
                check=True,
                capture_output=True,
                text=True,
            )
            outputs.append(json.loads(result.stdout))
        self.assertEqual(outputs[0], {'optimized': True, 'value': '产品甲', 'maxsize': 4096})
        self.assertEqual(outputs[1]['shared_text_memoization'], 'optimized')


class PortableCapabilityTests(unittest.TestCase):
    """Run on a clean checkout without the optional risk-service installation."""

    def marked(self, bound=4096):
        function = Mock(side_effect=clean)
        function.__risk_text_memoized__ = True
        function.cache_info = Mock(return_value=SimpleNamespace(maxsize=bound))
        return function

    def test_legacy_backend_remains_unmodified(self):
        legacy = SimpleNamespace(clean_text=clean, normalize_product_name=normalize)
        actual = bridge.shared_text_capability(legacy)
        self.assertEqual(actual['shared_text_memoization'], 'unoptimized')
        self.assertIs(legacy.clean_text, clean)
        self.assertIs(legacy.normalize_product_name, normalize)

    def test_broken_cache_info_is_non_fatal_and_not_exposed(self):
        function = self.marked()
        function.cache_info.side_effect = RuntimeError('private diagnostic')
        actual = bridge.shared_text_capability(SimpleNamespace(
            clean_text=function, normalize_product_name=function))
        self.assertEqual(actual['shared_text_memoization'], 'unoptimized')
        self.assertNotIn('private diagnostic', json.dumps(actual))
        function.assert_not_called()

    def test_attribute_inspection_failure_is_non_fatal(self):
        class Broken:
            def __getattr__(self, name):
                raise RuntimeError('metadata unavailable')
        actual = bridge.shared_text_capability(Broken())
        self.assertEqual(actual['shared_text_memoization'], 'unoptimized')

    def test_disabled_or_invalid_cache_bounds_are_not_reported_as_optimized(self):
        for bound in (0, -1, True, None, float('inf'), '4096'):
            with self.subTest(bound=bound):
                function = self.marked(bound)
                actual = bridge.shared_text_capability(SimpleNamespace(
                    clean_text=function, normalize_product_name=function))
                self.assertEqual(actual['shared_text_memoization'], 'unoptimized')
                self.assertIsNone(actual['functions']['clean_text']['max_entries'])

    def test_only_fixed_metadata_is_returned_without_calling_business_functions(self):
        function = self.marked()
        actual = bridge.shared_text_capability(SimpleNamespace(
            clean_text=function, normalize_product_name=function, secret='not returned'))
        self.assertEqual(actual['shared_text_memoization'], 'optimized')
        self.assertEqual(set(actual['functions']), {'clean_text', 'normalize_product_name'})
        self.assertEqual(actual['functions']['clean_text']['max_entries'], 4096)
        self.assertNotIn('not returned', json.dumps(actual))
        function.assert_not_called()


if __name__ == '__main__':
    unittest.main()
