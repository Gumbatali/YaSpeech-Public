#!/usr/bin/env python3
"""
Pull-воркер диаризации: сам опрашивает YMQ-очереди и обрабатывает задачи,
без HTTP-обвязки и без YMQ-триггера.

Зачем: триггер держит HTTP-вызов контейнера открытым на всё время обработки
(server.py), а Serverless Container ограничен 3600с — час аудио на CPU туда не
влезает. Воркер живёт на обычной ВМ (или в любом Docker-хосте), потолка нет.
Контракт задачи тот же: {"meetingId", "audioKey", "minSpeakers", "maxSpeakers"},
результат и статус пишутся в S3 теми же ключами, Node-сторона не меняется.

  Node worker --SendMessage--> YMQ queue (одна из DIARIZATION_QUEUE_URL[_2|_3])
  этот воркер --ReceiveMessage--> обрабатывает через server.process_one
  этот воркер --статус/RTTM--> S3; сообщение удаляется только после успеха

Одна задача за раз на процесс (pyannote занимает все ядра); для параллелизма
запускайте несколько процессов, каждый со своим набором очередей.
Перед запуском на ВМ удалите YMQ-триггеры этих очередей, иначе контейнер и
воркер будут забирать одни и те же сообщения.

Окружение: STORAGE_KEY_ID/STORAGE_SECRET/STORAGE_BUCKET, HF_TOKEN,
DIARIZATION_QUEUE_URL[_2|_3] (или DIARIZATION_QUEUE_URLS через запятую),
YMQ_KEY_ID/YMQ_SECRET (по умолчанию те же ключи, что для S3),
DIARIZE_JOB_TIMEOUT_SECONDS (по умолчанию 14400).
"""
import json
import os
import signal
import threading
import time
import traceback

import boto3

from server import get_s3_client, process_one

YMQ_ENDPOINT = "https://message-queue.api.cloud.yandex.net"
YMQ_REGION = "ru-central1"

JOB_TIMEOUT_SECONDS = int(os.environ.get("DIARIZE_JOB_TIMEOUT_SECONDS", "14400"))
POLL_WAIT_SECONDS = int(os.environ.get("DIARIZE_POLL_WAIT_SECONDS", "2"))
IDLE_SLEEP_SECONDS = int(os.environ.get("DIARIZE_IDLE_SLEEP_SECONDS", "3"))
VISIBILITY_SECONDS = 900
HEARTBEAT_SECONDS = 300
RETRY_DELAY_SECONDS = 30

_stop = threading.Event()


def get_queue_urls() -> list[str]:
    urls = [
        os.environ.get("DIARIZATION_QUEUE_URL"),
        os.environ.get("DIARIZATION_QUEUE_URL_2"),
        os.environ.get("DIARIZATION_QUEUE_URL_3"),
    ]
    urls += (os.environ.get("DIARIZATION_QUEUE_URLS") or "").split(",")
    return [u.strip() for u in urls if u and u.strip()]


def get_sqs_client():
    key_id = os.environ.get("YMQ_KEY_ID") or os.environ["STORAGE_KEY_ID"]
    secret = os.environ.get("YMQ_SECRET") or os.environ["STORAGE_SECRET"]
    return boto3.session.Session(
        aws_access_key_id=key_id,
        aws_secret_access_key=secret,
        region_name=YMQ_REGION,
    ).client("sqs", endpoint_url=YMQ_ENDPOINT)


class Heartbeat:
    """Продлевает visibility timeout сообщения, пока задача считается.

    Первый вызов — только через interval секунд: процесс диаризации
    форкается сразу после старта задачи, и поток не должен в этот момент
    держать блокировки boto3/logging (форк унаследовал бы их залипшими)."""

    def __init__(self, sqs, queue_url: str, receipt_handle: str, interval: float = HEARTBEAT_SECONDS):
        self._sqs = sqs
        self._queue_url = queue_url
        self._receipt = receipt_handle
        self._interval = interval
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self._done.wait(self._interval):
            try:
                self._sqs.change_message_visibility(
                    QueueUrl=self._queue_url,
                    ReceiptHandle=self._receipt,
                    VisibilityTimeout=VISIBILITY_SECONDS,
                )
            except Exception as e:
                print(f"heartbeat: не удалось продлить сообщение: {e}", flush=True)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._done.set()
        self._thread.join(timeout=5)


def handle_message(sqs, s3, queue_url: str, message: dict,
                   process=process_one, timeout_seconds: int = JOB_TIMEOUT_SECONDS,
                   heartbeat_interval: float = HEARTBEAT_SECONDS) -> str:
    """Обрабатывает одно сообщение, возвращает исход: done / dropped / timeout / retry.

    Удаляем при успехе, при битом теле и при таймауте (повтор таймаута
    бесполезен — тот же результат ещё через N часов). Прочие ошибки оставляем
    в очереди: после maxReceiveCount очередь сама отправит их в DLQ."""
    receipt = message["ReceiptHandle"]

    def delete():
        sqs.delete_message(QueueUrl=queue_url, ReceiptHandle=receipt)

    try:
        job = json.loads(message["Body"])
        job["meetingId"], job["audioKey"]
    except (ValueError, KeyError, TypeError):
        print(f"Битое сообщение, удаляю: {str(message.get('Body'))[:200]}", flush=True)
        delete()
        return "dropped"

    with Heartbeat(sqs, queue_url, receipt, heartbeat_interval):
        try:
            process(s3, job, timeout_seconds)
        except TimeoutError:
            traceback.print_exc()
            delete()
            return "timeout"
        except Exception:
            traceback.print_exc()
            sqs.change_message_visibility(
                QueueUrl=queue_url, ReceiptHandle=receipt, VisibilityTimeout=RETRY_DELAY_SECONDS,
            )
            return "retry"

    delete()
    return "done"


def poll_once(sqs, s3, queue_urls: list[str], start: int = 0) -> int | None:
    """Обходит очереди по кругу, начиная со start; берёт первое найденное
    сообщение. Возвращает индекс следующей очереди или None, если пусто."""
    for i in range(len(queue_urls)):
        idx = (start + i) % len(queue_urls)
        url = queue_urls[idx]
        resp = sqs.receive_message(
            QueueUrl=url,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=POLL_WAIT_SECONDS,
            VisibilityTimeout=VISIBILITY_SECONDS,
        )
        for message in resp.get("Messages", []):
            outcome = handle_message(sqs, s3, url, message)
            print(f"Сообщение обработано: {outcome}", flush=True)
            return (idx + 1) % len(queue_urls)
    return None


def main():
    queue_urls = get_queue_urls()
    if not queue_urls:
        raise SystemExit("Не задана ни одна очередь: DIARIZATION_QUEUE_URL[_2|_3] или DIARIZATION_QUEUE_URLS")

    signal.signal(signal.SIGTERM, lambda *_: _stop.set())
    signal.signal(signal.SIGINT, lambda *_: _stop.set())

    sqs, s3 = get_sqs_client(), get_s3_client()
    print(f"Воркер диаризации запущен, очередей: {len(queue_urls)}", flush=True)

    cursor = 0
    while not _stop.is_set():
        try:
            nxt = poll_once(sqs, s3, queue_urls, cursor)
        except Exception:
            traceback.print_exc()
            nxt = None
        if nxt is None:
            _stop.wait(IDLE_SLEEP_SECONDS)
        else:
            cursor = nxt
    print("Воркер остановлен", flush=True)


if __name__ == "__main__":
    main()
