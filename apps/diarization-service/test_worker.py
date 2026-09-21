"""
Тесты pull-воркера диаризации (worker.py). Запуск: python -m unittest test_worker
Тяжёлые зависимости (boto3, fastapi) подменяются заглушками — тесты не ходят в сеть.
"""
import json
import sys
import time
import types
import unittest


def _install_stubs():
    if "boto3" not in sys.modules:
        boto3 = types.ModuleType("boto3")
        boto3.session = types.SimpleNamespace(Session=lambda **kw: None)
        sys.modules["boto3"] = boto3
    if "fastapi" not in sys.modules:
        class FastAPI:
            def get(self, *_a, **_k):
                return lambda f: f

            post = get

        fastapi = types.ModuleType("fastapi")
        fastapi.FastAPI, fastapi.Request, fastapi.Response = FastAPI, object, object
        sys.modules["fastapi"] = fastapi


_install_stubs()
import worker  # noqa: E402


class FakeSqs:
    def __init__(self, messages=None):
        self.messages = list(messages or [])
        self.deleted = []
        self.visibility = []

    def receive_message(self, **kwargs):
        return {"Messages": [self.messages.pop(0)]} if self.messages else {}

    def delete_message(self, QueueUrl, ReceiptHandle):
        self.deleted.append(ReceiptHandle)

    def change_message_visibility(self, QueueUrl, ReceiptHandle, VisibilityTimeout):
        self.visibility.append((ReceiptHandle, VisibilityTimeout))


def msg(receipt="r1", **job):
    body = {"meetingId": "m1", "audioKey": "a/m1.wav", **job}
    return {"ReceiptHandle": receipt, "Body": json.dumps(body)}


class HandleMessageTest(unittest.TestCase):
    def test_success_deletes_message(self):
        sqs, calls = FakeSqs(), []
        outcome = worker.handle_message(
            sqs, "s3", "q", msg(), process=lambda s3, job, t: calls.append((job["meetingId"], t)),
            timeout_seconds=123,
        )
        self.assertEqual(outcome, "done")
        self.assertEqual(calls, [("m1", 123)])
        self.assertEqual(sqs.deleted, ["r1"])

    def test_timeout_deletes_message(self):
        def process(*_):
            raise TimeoutError("too long")

        sqs = FakeSqs()
        self.assertEqual(worker.handle_message(sqs, "s3", "q", msg(), process=process), "timeout")
        self.assertEqual(sqs.deleted, ["r1"])

    def test_other_error_keeps_message_for_redelivery(self):
        def process(*_):
            raise RuntimeError("boom")

        sqs = FakeSqs()
        self.assertEqual(worker.handle_message(sqs, "s3", "q", msg(), process=process), "retry")
        self.assertEqual(sqs.deleted, [])
        self.assertEqual(sqs.visibility, [("r1", worker.RETRY_DELAY_SECONDS)])

    def test_malformed_body_is_dropped_without_processing(self):
        for body in ("not json", json.dumps({"meetingId": "m1"}), json.dumps([1])):
            sqs = FakeSqs()
            outcome = worker.handle_message(
                sqs, "s3", "q", {"ReceiptHandle": "r", "Body": body},
                process=lambda *_: self.fail("не должно вызываться"),
            )
            self.assertEqual(outcome, "dropped")
            self.assertEqual(sqs.deleted, ["r"])

    def test_heartbeat_extends_visibility_during_long_job(self):
        sqs = FakeSqs()
        worker.handle_message(
            sqs, "s3", "q", msg(), process=lambda *_: time.sleep(0.25), heartbeat_interval=0.05,
        )
        self.assertGreaterEqual(len(sqs.visibility), 2)
        self.assertTrue(all(v == ("r1", worker.VISIBILITY_SECONDS) for v in sqs.visibility))


class PollOnceTest(unittest.TestCase):
    def setUp(self):
        self._orig = worker.handle_message
        self.handled = []
        worker.handle_message = lambda sqs, s3, url, m, **kw: self.handled.append((url, m["ReceiptHandle"])) or "done"

    def tearDown(self):
        worker.handle_message = self._orig

    def test_empty_queues_return_none(self):
        self.assertIsNone(worker.poll_once(FakeSqs(), "s3", ["q1", "q2"]))
        self.assertEqual(self.handled, [])

    def test_takes_first_message_and_advances_round_robin(self):
        sqs = FakeSqs([msg("a"), msg("b")])
        self.assertEqual(worker.poll_once(sqs, "s3", ["q1", "q2", "q3"], start=2), 0)
        self.assertEqual(self.handled, [("q3", "a")])


class QueueUrlsTest(unittest.TestCase):
    def test_collects_numbered_and_comma_separated(self):
        import os
        env = {
            "DIARIZATION_QUEUE_URL": "q1", "DIARIZATION_QUEUE_URL_2": " q2 ",
            "DIARIZATION_QUEUE_URLS": "q3, ,q4",
        }
        saved = {k: os.environ.get(k) for k in (*env, "DIARIZATION_QUEUE_URL_3")}
        try:
            os.environ.pop("DIARIZATION_QUEUE_URL_3", None)
            os.environ.update(env)
            self.assertEqual(worker.get_queue_urls(), ["q1", "q2", "q3", "q4"])
        finally:
            for k, v in saved.items():
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)


if __name__ == "__main__":
    unittest.main()
