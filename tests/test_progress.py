"""Progress snapshots preserve short-lived events without exposing internals."""
import threading
import unittest
from datetime import timedelta
from types import SimpleNamespace
from app import Application
from domain import now_cn


class ImmediateExecutor:
    def submit(self, callback):
        callback()


class ProgressEvents(unittest.TestCase):
    def test_snapshot_retains_sequenced_events_and_is_stable(self):
        application = Application.__new__(Application)
        application.lock = threading.RLock()
        application.jobs = {}
        application.executor = ImmediateExecutor()
        application.stations = SimpleNamespace(resolve=lambda value: None)
        snapshots = []

        def search(options, progress, cancel):
            for index in range(300):
                progress.event({'type': 'hub', 'station': 'NKH', 'city': '南京'})
                progress('正在组合经 南京南 的路线', 40)
                if index == 5:
                    snapshots.append(application.snapshot(next(iter(application.jobs))))
            progress.event({'type': 'verify', 'stops': ['IOQ', 'NKH']})
            return {'routes': []}

        application.planner = SimpleNamespace(search=search)
        start = now_cn() + timedelta(days=1)
        job_id = application.start({'origin': '深圳', 'destination': '南京',
            'earliest': start.isoformat(timespec='minutes'),
            'latest': (start+timedelta(days=1)).isoformat(timespec='minutes')})
        snapshot = application.snapshot(job_id)
        self.assertEqual(snapshot['status'], 'complete')
        self.assertEqual(len(snapshot['events']), 256)
        self.assertEqual(snapshot['events'][-1]['sequence'], 301)
        self.assertEqual(snapshot['events'][-1]['type'], 'verify')
        self.assertEqual(len(snapshots[0]['events']), 6)
        self.assertFalse(any(key.startswith('_') for key in snapshot))
        self.assertNotIn('created', snapshot)


if __name__ == '__main__':
    unittest.main()
