"""Daily PQ caching, without a live database."""
import importlib.util
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
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

    def make_cache(self):
        return bridge.DailyPQCache(self.path, self.read, lambda: self.now)

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

    def test_dataframe_roundtrip(self):
        try:
            import pandas as pd
        except ImportError:
            self.skipTest('pandas unavailable')
        frame = pd.DataFrame({'amount': [Decimal('1.23'), None], 'qty': [1, 2],
                              'date': [pd.Timestamp('2026-09-08'), pd.NaT],
                              'nullable': pd.Series([1, pd.NA], dtype='Int64')})
        self.read.return_value = frame
        pd.testing.assert_frame_equal(self.cache('pqread', SQL, lower_case=False), frame)
        pd.testing.assert_frame_equal(self.make_cache()('pqread', SQL, lower_case=False), frame)
        self.read.assert_called_once()

    def test_errors_retry_and_empty_success_is_cached(self):
        self.read.side_effect = [RuntimeError('PQ unavailable'), []]
        with self.assertRaises(RuntimeError):
            self.cache('pqread', SQL)
        self.assertEqual(self.cache('pqread', SQL), [])
        self.assertEqual(self.cache('pqread', SQL), [])
        self.assertEqual(self.read.call_count, 2)

    def test_non_pq_bypass(self):
        for _ in range(2):
            self.cache('jydb', 'SELECT * FROM BOND')
        self.assertEqual(self.read.call_count, 2)


if __name__ == '__main__':
    unittest.main()
