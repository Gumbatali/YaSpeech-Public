#!/usr/bin/env python3
"""
HTTP-обвязка над diarize.py + merge_clusters.py для прод-пайплайна YaSpeech.

Вызывается YMQ-триггером (--invoke-container-*), который держит соединение
открытым на всё время обработки ОДНОГО сообщения (до 3600с) — необходимо,
так как диаризация длится время, сравнимое с длиной встречи (RTF ~1x на CPU).

  meeting-pipeline-service.js (Node, таймаут 60с) --SendMessage--> YMQ queue
  YMQ trigger --POST /process (держит соединение до 3600с)--> этот сервис
  этот сервис --статус/результат--> S3 (Node читает оттуда, не отсюда)

Эндпоинты:
  POST /process  — вызывается ТОЛЬКО YMQ-триггером, синхронно делает всю
                   работу (диаризация + слияние кластеров), пишет статус/RTTM
                   в S3, отвечает 200 когда готово (или неготово из очереди
                   удаляется, ошибка — HTTP 500, триггер положит сообщение
                   обратно по istekшему visibility timeout).
  GET  /health   — проверка живости.
"""
import json
import multiprocessing as mp
import os
import tempfile
import traceback
from pathlib import Path

import boto3
from fastapi import FastAPI, Request, Response

from diarize import run_diarize
from merge_clusters import run_merge

STORAGE_ENDPOINT = "https://storage.yandexcloud.net"
STATUS_PREFIX = "diarization-jobs"
# Держим запас под 3600с жёсткий лимит контейнера (--execution-timeout) —
# без этого platform kill убивает процесс без обновления статуса, и джоба
# висит "running" в S3 вечно (реальный инцидент: 2+ часа без апдейта).
JOB_TIMEOUT_SECONDS = int(os.environ.get("DIARIZE_JOB_TIMEOUT_SECONDS", "3300"))

app = FastAPI()


def get_s3_client():
    return boto3.session.Session(
        aws_access_key_id=os.environ["STORAGE_KEY_ID"],
        aws_secret_access_key=os.environ["STORAGE_SECRET"],
        region_name="ru-central1",
    ).client("s3", endpoint_url=STORAGE_ENDPOINT)


def bucket_name() -> str:
    return os.environ["STORAGE_BUCKET"]


def status_key(job_id: str) -> str:
    return f"{STATUS_PREFIX}/{job_id}/status.json"


def rttm_key(job_id: str) -> str:
    return f"{STATUS_PREFIX}/{job_id}/diarization.rttm"


def write_status(s3, job_id: str, status: dict):
    s3.put_object(
        Bucket=bucket_name(), Key=status_key(job_id),
        Body=json.dumps(status, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
    )


def extract_job_payloads(envelope: dict) -> list[dict]:
    """YMQ-триггер шлёт {"messages": [{"details": {"message": {"body": "<json>"}}}]}.
    Разбираем защитно — на случай отличий в форме конверта."""
    payloads = []
    for msg in envelope.get("messages", []):
        body = (
            msg.get("details", {}).get("message", {}).get("body")
            or msg.get("body")
        )
        if body:
            payloads.append(json.loads(body))
    return payloads


def _run_job_body(job: dict, conn: "mp.connection.Connection"):
    """Выполняется в отдельном процессе, чтобы его можно было надёжно
    убить по таймауту (Python-потоки нельзя принудительно прервать).

    Передача результата через Pipe, а не Queue/Lock — в этом контейнере нет
    /dev/shm, и любой POSIX-семафор (Queue, Lock, Semaphore) падает с
    FileNotFoundError при создании. Pipe — голый os.pipe()/socketpair(),
    семафоров не требует (реальный инцидент: сломало вообще все джобы)."""
    try:
        job_id = job["meetingId"]
        audio_key = job["audioKey"]
        s3 = get_s3_client()

        with tempfile.TemporaryDirectory() as tmp:
            audio_path = str(Path(tmp) / "audio.wav")
            s3.download_file(bucket_name(), audio_key, audio_path)

            hyp_rttm_path = str(Path(tmp) / "hyp.rttm")
            run_diarize(
                audio_path, job_id, hyp_rttm_path,
                min_speakers=job.get("minSpeakers"), max_speakers=job.get("maxSpeakers"),
            )

            merged_rttm_path = str(Path(tmp) / "merged.rttm")
            speakers = run_merge(audio_path, hyp_rttm_path, job_id, merged_rttm_path)

            s3.upload_file(merged_rttm_path, bucket_name(), rttm_key(job_id))
        conn.send(("done", speakers))
    except Exception as e:
        traceback.print_exc()
        conn.send(("failed", str(e)))
    finally:
        conn.close()


def process_one(s3, job: dict, timeout_seconds: int = JOB_TIMEOUT_SECONDS):
    job_id = job["meetingId"]
    write_status(s3, job_id, {"status": "running"})

    ctx = mp.get_context("fork")
    parent_conn, child_conn = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_run_job_body, args=(job, child_conn))
    proc.start()
    child_conn.close()  # только читающий конец нужен родителю
    proc.join(timeout_seconds)

    if proc.is_alive():
        proc.terminate()
        proc.join(5)
        if proc.is_alive():
            proc.kill()
            proc.join()
        parent_conn.close()
        write_status(s3, job_id, {
            "status": "failed", "error": f"timeout after {timeout_seconds}s",
        })
        raise TimeoutError(f"diarization job {job_id} exceeded {timeout_seconds}s, killed")

    if parent_conn.poll():
        outcome, payload = parent_conn.recv()
    else:
        outcome, payload = "failed", "worker process died unexpectedly"
    parent_conn.close()

    if outcome == "failed":
        write_status(s3, job_id, {"status": "failed", "error": payload})
        raise RuntimeError(payload)

    write_status(s3, job_id, {"status": "done", "rttmKey": rttm_key(job_id), "speakers": payload})


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/process")
async def process(request: Request):
    envelope = await request.json()
    jobs = extract_job_payloads(envelope)
    s3 = get_s3_client()

    for job in jobs:
        job_id = job.get("meetingId", "unknown")
        try:
            process_one(s3, job)
        except Exception as e:
            traceback.print_exc()
            write_status(s3, job_id, {"status": "failed", "error": str(e)})
            # 500 → триггер не удаляет сообщение из очереди, будет повтор
            # после visibility timeout (полезно для транзиентных сбоев вроде
            # временной недоступности S3; не полезно для детерминированных
            # ошибок вроде битого аудио — но лучше повтор, чем тихая потеря).
            return Response(status_code=500, content=str(e))

    return {"processed": len(jobs)}
