"""Bounded pure-string hot-path memoization, without business-data caches."""
import importlib.util
import re
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location(
    'text_cache_bridge', Path(__file__).resolve().parents[2] / 'src/wecom/risk/direct_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


def clean(value):
    return '' if value is None else re.sub(r'\s+', ' ', str(value).replace('\u3000', ' ').strip())


def normalize(value):
    text = clean(value)
    for suffix in ('集合资产管理产品', '资产管理产品', '专项产品', '资管产品', '产品'):
        if text.endswith(suffix):
            text = text[:-len(suffix)]
    return re.sub(r'\s+', '', text)


class TextMemoTests(unittest.TestCase):
    def test_preserves_values_and_exact_cache_keys(self):
        source = Mock(side_effect=normalize)
        cached = bridge.memoize_short_text(source)
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
        cached = bridge.memoize_short_text(clean)
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
        cached = bridge.memoize_short_text(source, max_chars=4)
        for raw in (String('A'), '12345'):
            cached(raw)
            cached(raw)
        self.assertEqual(source.call_count, 4)
        self.assertEqual(cached.cache_info().currsize, 0)

    def test_lru_bound_clear_and_disabled_cache(self):
        source = Mock(side_effect=clean)
        cached = bridge.memoize_short_text(source, max_entries=2)
        for value in ('A', 'B', 'C', 'A'):
            cached(value)
        self.assertEqual(source.call_count, 4)
        self.assertEqual(cached.cache_info().currsize, 2)
        cached.cache_clear()
        self.assertEqual(cached.cache_info().currsize, 0)
        uncached = bridge.memoize_short_text(clean, max_entries=0)
        uncached('A')
        self.assertEqual(uncached.cache_info().currsize, 0)

    def test_exceptions_are_not_cached(self):
        source = Mock(side_effect=[ValueError('temporary'), 'ok'])
        cached = bridge.memoize_short_text(source)
        with self.assertRaises(ValueError):
            cached('A')
        self.assertEqual(cached('A'), 'ok')
        self.assertEqual(cached('A'), 'ok')
        self.assertEqual(source.call_count, 2)

    def test_concurrent_conversion_preserves_results_and_bound(self):
        cached = bridge.memoize_short_text(normalize, max_entries=8)
        samples = [f'产品{i % 5}资产管理产品' for i in range(200)]
        with ThreadPoolExecutor(4) as pool:
            self.assertEqual(list(pool.map(cached, samples)), list(map(normalize, samples)))
        self.assertLessEqual(cached.cache_info().currsize, 8)

    def test_installer_is_idempotent_and_keeps_alias_resolution_live(self):
        aliases = {'A': 'original'}
        checker = SimpleNamespace(clean_text=clean, normalize_product_name=normalize)
        def canonical(value):
            return aliases.get(checker.normalize_product_name(value), '')
        checker.canonical_product_name_for_holding = canonical
        bridge.install_text_memoization(checker)
        first = checker.normalize_product_name
        self.assertEqual(checker.canonical_product_name_for_holding('A产品'), 'original')
        aliases['A'] = 'updated'
        self.assertEqual(checker.canonical_product_name_for_holding('A产品'), 'updated')
        bridge.install_text_memoization(checker)
        self.assertIs(checker.normalize_product_name, first)
        self.assertIs(checker.canonical_product_name_for_holding, canonical)

    def test_conversion_and_timing_preserve_callable_metadata(self):
        cached = bridge.memoize_short_text(normalize)
        self.assertEqual(cached.__name__, 'normalize')
        probe = bridge.CallTimingProbe()
        measured = probe.wrap('normalize', cached)
        self.assertEqual(measured.__name__, 'normalize')
        self.assertEqual(measured('A产品'), 'A')
        self.assertEqual(probe.snapshot()['normalize']['count'], 1)


if __name__ == '__main__':
    unittest.main()
