"""Daily PQ caching, without a live database."""
import importlib.util
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
import threading
from decimal import Decimal
from zoneinfo import ZoneInfo
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('daily_bridge', Path(__file__).resolve().parents[2] / 'src/wecom/risk/direct_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
SQL = 'SELECT * FROM PQ.IDB_VIEW_HOLDING WHERE REF_DATE=:day'


class DailyCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'cache.sqlite3'
        self.now = datetime(2026, 9, 8, 23, 59, tzinfo=ZoneInfo("Asia/Shanghai")).timestamp()
        self.rows = [{'amount': Decimal('1.234'), 'date': date(2026, 9, 8),
                      'time': datetime(2026, 9, 8, 1), 'missing': None}]
        self.read = Mock(return_value=self.rows)
        self.cache = self.make_cache()

    def make_cache(self, memory_max_entries=16):
        return bridge.DailyPQCache(
            self.path,
            self.read,
            lambda: self.now,
            memory_max_entries=memory_max_entries,
        )

    def test_shared_instances_concurrent_and_restart(self):
        caches = [self.make_cache() for _ in range(4)]
        with ThreadPoolExecutor(4) as pool:
            results = list(pool.map(lambda cache: cache('pqread', SQL, params={'day': date(2026, 9, 8)}), caches))
        self.assertEqual(results, [self.rows] * 4)
        results[0][0]['amount'] = 9
        self.assertEqual(self.make_cache()('pqread', SQL, params={'day': date(2026, 9, 8)}), self.rows)
        self.read.assert_called_once()

    def test_day_rollover_and_query_scope(self):
        self.cache('pqread', SQL)
        self.cache('pqread', SQL)
        self.now += 86400
        self.cache('pqread', SQL)
        self.cache('other', SQL)
        self.cache('pqread', SQL, params={'day': '2026-09-01'})
        self.cache('pqread', SQL + ' AND PTF_NAME=\'A\'')
        self.assertEqual(self.read.call_count, 5)

    def test_all_pq_tables_and_exact_expiry(self):
        for table in ('IDB_VIEW_TA_NAV', 'PTF', 'TRANSACTIONS'):
            sql = 'SELECT * FROM ' + table
            self.cache('pqread', sql)
            self.cache('pqread', sql)
        self.assertEqual(self.read.call_count, 3)
        self.now += 59
        self.cache('pqread', 'SELECT * FROM PTF')
        self.assertEqual(self.read.call_count, 3)
        self.now += 1
        self.cache('pqread', 'SELECT * FROM PTF')
        self.assertEqual(self.read.call_count, 4)

    def test_unrelated_slow_miss_does_not_block_warm_hit_or_other_cold_query(self):
        entered = threading.Event()
        release = threading.Event()
        other_entered = threading.Event()
        calls = []

        def read(_connection, sql, *args, **kwargs):
            calls.append(sql)
            if sql == 'slow':
                entered.set()
                release.wait(3)
            if sql == 'other':
                other_entered.set()
            return [{'sql': sql}]

        cache = bridge.DailyPQCache(self.path, read, lambda: self.now)
        self.assertEqual(cache('pqread', 'warm'), [{'sql': 'warm'}])
        with ThreadPoolExecutor(3) as pool:
            slow = pool.submit(cache, 'pqread', 'slow')
            self.assertTrue(entered.wait(1))
            warm = pool.submit(cache, 'pqread', 'warm')
            other = pool.submit(cache, 'pqread', 'other')
            self.assertEqual(warm.result(timeout=1), [{'sql': 'warm'}])
            self.assertTrue(other_entered.wait(1))
            release.set()
            self.assertEqual(slow.result(timeout=1), [{'sql': 'slow'}])
            self.assertEqual(other.result(timeout=1), [{'sql': 'other'}])
        self.assertEqual(calls.count('warm'), 1)

    def test_dataframe_roundtrip(self):
        try:
            import pandas as pd
        except ImportError:
            self.skipTest('pandas unavailable')
        frame = pd.DataFrame({'amount': [Decimal('1.23'), None], 'qty': [1, 2],
                              'date': [pd.Timestamp('2026-09-08'), pd.NaT],
                              'nullable': pd.Series([1, pd.NA], dtype='Int64')})
        self.read.return_value = frame
        encoded = bridge.DailyPQCache.encode(frame)
        self.assertEqual(encoded[0], 'dataframe_json_v2')
        pd.testing.assert_frame_equal(self.cache('pqread', SQL, lower_case=False), frame)
        pd.testing.assert_frame_equal(self.make_cache()('pqread', SQL, lower_case=False), frame)
        self.read.assert_called_once()

    def test_polars_dataframe_roundtrip_preserves_schema(self):
        try:
            import polars as pl
        except ImportError:
            self.skipTest('polars unavailable')
        frame = pl.DataFrame({
            'amount': [Decimal('1.23'), None],
            'qty': [1, 2],
            'date': [date(2026, 9, 8), None],
            'name': ['A', 'B'],
        })
        self.read.return_value = frame
        self.assertTrue(self.cache('pqread', SQL, lower_case=False).equals(frame))
        self.assertTrue(self.make_cache()('pqread', SQL, lower_case=False).equals(frame))
        self.read.assert_called_once()

    def test_legacy_polars_cache_decodes_late_non_null_columns(self):
        try:
            import polars as pl
        except ImportError:
            self.skipTest('polars unavailable')
        rows = [{'issuer': None} for _ in range(559)] + [{'issuer': '厦门金圆投资集团有限公司'}]
        legacy = ['polars_dataframe', bridge.DailyPQCache.encode(rows)]
        frame = bridge.DailyPQCache.decode(legacy)
        self.assertEqual(frame.schema['issuer'], pl.String)
        self.assertEqual(frame[-1, 'issuer'], '厦门金圆投资集团有限公司')

    def test_errors_retry_and_empty_success_is_cached(self):
        self.read.side_effect = [RuntimeError('PQ unavailable'), []]
        with self.assertRaises(RuntimeError):
            self.cache('pqread', SQL)
        self.assertEqual(self.cache('pqread', SQL), [])
        self.assertEqual(self.cache('pqread', SQL), [])
        self.assertEqual(self.read.call_count, 2)

    def test_metrics_distinguish_backend_miss_from_memory_and_persistent_hits(self):
        before = self.cache.snapshot_metrics()
        self.cache('pqread', SQL)
        self.cache('pqread', SQL)
        delta = self.cache.metrics_since(before)
        self.assertEqual(delta['miss']['count'], 1)
        self.assertEqual(delta['memory_hit']['count'], 1)
        self.assertGreaterEqual(delta['miss']['backend_ms'], 0)
        self.assertEqual(delta['memory_hit']['backend_ms'], 0)

        restarted = self.make_cache(memory_max_entries=0)
        before = restarted.snapshot_metrics()
        self.assertEqual(restarted('pqread', SQL), self.rows)
        delta = restarted.metrics_since(before)
        self.assertEqual(delta['hit']['count'], 1)
        self.assertEqual(delta['hit']['backend_ms'], 0)

    def test_memory_hit_returns_an_isolated_copy(self):
        first = self.cache('pqread', SQL)
        first[0]['amount'] = 9
        self.assertEqual(self.cache('pqread', SQL), self.rows)
        self.assertEqual(self.read.call_count, 1)

    def test_legacy_dataframe_payload_still_decodes(self):
        try:
            import pandas as pd
        except ImportError:
            self.skipTest('pandas unavailable')
        frame = pd.DataFrame({'amount': [Decimal('1.23')], 'date': [pd.Timestamp('2026-09-08')]})
        legacy = ['dataframe', bridge.DailyPQCache.encode({
            'split': frame.to_dict(orient='split'),
            'dtypes': [str(dtype) for dtype in frame.dtypes],
        })]
        pd.testing.assert_frame_equal(bridge.DailyPQCache.decode(legacy), frame)

    def test_non_pq_bypass(self):
        for _ in range(2):
            self.cache('jydb', 'SELECT * FROM BOND')
        self.assertEqual(self.read.call_count, 2)


if __name__ == '__main__':
    unittest.main()
