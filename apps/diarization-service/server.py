#!/usr/bin/env python3
"""
HTTP-обвязка над diarize.py + merge_clusters.py для прод-пайплайна YaSpeech.

Статус задачи хранится в Object Storage (не в памяти процесса) — Serverless
Containers могут маршрутизировать запросы на разные инстансы, а GET-поллинг
статуса должен работать независимо от того, какой инстанс принял POST.

Эндпоинты:
  POST /jobs        {"meetingId", "audioKey", "minSpeakers"?, "maxSpeakers"?}
                     -> {"jobId", "status": "pending"}
  GET  /jobs/{jobId} -> {"status": "pending"|"running"|"done"|"failed", ...}
  GET  /health       -> {"status": "ok"}
"""
import json
import os
import tempfile
import threading
import traceback
from pathlib import Path

import boto3
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from diarize import run_diarize
from merge_clusters import run_merge

STORAGE_ENDPOINT = "https://storage.yandexcloud.net"
STATUS_PREFIX = "diarization-jobs"

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


class CreateJobRequest(BaseModel):
    meetingId: str
    audioKey: str
    minSpeakers: int | None = None
    maxSpeakers: int | None = None


def run_job(job_id: str, audio_key: str, min_speakers: int | None, max_speakers: int | None):
    s3 = get_s3_client()
    write_status(s3, job_id, {"status": "running"})

    with tempfile.TemporaryDirectory() as tmp:
        try:
            audio_path = str(Path(tmp) / "audio.wav")
            s3.download_file(bucket_name(), audio_key, audio_path)

            hyp_rttm_path = str(Path(tmp) / "hyp.rttm")
            run_diarize(
                audio_path, job_id, hyp_rttm_path,
                min_speakers=min_speakers, max_speakers=max_speakers,
            )

            merged_rttm_path = str(Path(tmp) / "merged.rttm")
            speakers = run_merge(audio_path, hyp_rttm_path, job_id, merged_rttm_path)

            s3.upload_file(merged_rttm_path, bucket_name(), rttm_key(job_id))
            write_status(s3, job_id, {
                "status": "done", "rttmKey": rttm_key(job_id), "speakers": speakers,
            })
        except Exception as e:
            traceback.print_exc()
            write_status(s3, job_id, {"status": "failed", "error": str(e)})


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/jobs")
def create_job(req: CreateJobRequest):
    job_id = req.meetingId
    s3 = get_s3_client()
    write_status(s3, job_id, {"status": "pending"})

    thread = threading.Thread(
        target=run_job, args=(job_id, req.audioKey, req.minSpeakers, req.maxSpeakers),
        daemon=True,
    )
    thread.start()

    return {"jobId": job_id, "status": "pending"}


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    s3 = get_s3_client()
    try:
        obj = s3.get_object(Bucket=bucket_name(), Key=status_key(job_id))
    except s3.exceptions.NoSuchKey:
        raise HTTPException(status_code=404, detail="job not found")
    return json.loads(obj["Body"].read().decode("utf-8"))
