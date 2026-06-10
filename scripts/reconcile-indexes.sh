#!/bin/bash
# Сверка и восстановление индексов в Object Storage.
#
# В S3 нет транзакций: save() пишет meeting.json, проектный индекс и глобальный
# индекс тремя запросами. Если что-то упало между записями — индексы расходятся,
# и встречи «пропадают» из UI, хотя данные на месте.
#
# ВАЖНО про семантику: delete() в этой системе удаляет ТОЛЬКО записи индексов,
# файлы остаются в бакете. Поэтому «файл есть, в индексах нет» — чаще всего
# намеренное удаление, и автоматически такое НЕ восстанавливаем (только отчёт).
# Автопочинка (--apply) применяется только к перекрёстным расхождениям между
# проектным и глобальным индексами встреч — это истинный признак гонки записи.
#
# Usage:
#   ./scripts/reconcile-indexes.sh           # dry-run: показать все расхождения
#   ./scripts/reconcile-indexes.sh --apply   # синхронизировать индексы встреч
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/scripts/.env.deploy"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌  Файл $ENV_FILE не найден." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"

: "${BUCKET:?Не задана переменная BUCKET в .env.deploy}"
: "${KEY_ID:?Не задана переменная KEY_ID в .env.deploy}"
: "${SECRET:?Не задана переменная SECRET в .env.deploy}"

APPLY="${1:-}"

python3 - "$KEY_ID" "$SECRET" "$BUCKET" "$APPLY" <<'PYEOF'
import sys, json, boto3

key_id, secret, bucket, apply_flag = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
APPLY = apply_flag == "--apply"

s3 = boto3.Session(
    aws_access_key_id=key_id,
    aws_secret_access_key=secret,
    region_name="ru-central1"
).client("s3", endpoint_url="https://storage.yandexcloud.net")

def read_json(key):
    try:
        body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
        return json.loads(body)
    except s3.exceptions.NoSuchKey:
        return None

def write_json(key, value):
    s3.put_object(
        Bucket=bucket, Key=key,
        Body=json.dumps(value, ensure_ascii=False, indent=2).encode(),
        ContentType="application/json; charset=utf-8"
    )

def list_keys(prefix):
    keys = []
    token = None
    while True:
        kw = dict(Bucket=bucket, Prefix=prefix, MaxKeys=1000)
        if token:
            kw["ContinuationToken"] = token
        page = s3.list_objects_v2(**kw)
        keys += [o["Key"] for o in page.get("Contents", [])]
        if not page.get("IsTruncated"):
            return keys
        token = page["NextContinuationToken"]

fixed = 0
reported = 0

# ── 1. Отчёт: проекты с файлами, но вне projects/index.json ──────────────────
manifest_keys = [k for k in list_keys("projects/") if k.endswith("/project.json")]
actual_projects = {}
for key in manifest_keys:
    project = read_json(key)
    if project and project.get("id"):
        actual_projects[project["id"]] = project

project_index = read_json("projects/index.json") or []
indexed_project_ids = {p["id"] for p in project_index}
unindexed = [pid for pid in actual_projects if pid not in indexed_project_ids]
if unindexed:
    reported += len(unindexed)
    print(f"ℹ️  Проекты с файлами, но вне индекса (вероятно, удалены пользователем): {unindexed}")
    print("    Автовосстановление не выполняется. Если проект пропал из-за сбоя —")
    print("    верните его вручную, добавив запись в projects/index.json.")

# ── 2. Индексы встреч: проектные ↔ глобальный ────────────────────────────────
global_index = read_json("meetings/index.json") or []
global_by_id = {m["id"]: m for m in global_index}

per_project = {}
for pid in sorted(indexed_project_ids):
    per_project[pid] = read_json(f"projects/{pid}/meetings/index.json") or []

project_meeting_ids = {m["id"]: pid for pid, idx in per_project.items() for m in idx}

# 2a. Встреча в проектном индексе, но не в глобальном → дописать в глобальный
missing_in_global = [mid for mid in project_meeting_ids if mid not in global_by_id]
if missing_in_global:
    fixed += len(missing_in_global)
    print(f"⚠️  В глобальном meetings/index.json нет {len(missing_in_global)} встреч из проектных индексов: {missing_in_global}")
    if APPLY:
        for mid in missing_in_global:
            pid = project_meeting_ids[mid]
            # baseKey достаём из манифеста, проверяя оба layout-а
            manifest = (read_json(f"projects/{pid}/meetings/{mid}/meeting.json")
                        or next((read_json(k) for k in list_keys(f"projects/{pid}/")
                                 if k.endswith(f"_{mid}/meeting.json")), None))
            base_key = ((manifest or {}).get("artifacts") or {}).get("baseKey")
            entry = {"id": mid, "projectId": pid}
            if base_key:
                entry["baseKey"] = base_key
            global_index.append(entry)
        write_json("meetings/index.json", global_index)
        print("   ✓ meetings/index.json дополнен")

# 2b. Встреча в глобальном, но не в проектном индексе → дописать в проектный
for pid, idx in per_project.items():
    ids_here = {m["id"] for m in idx}
    lost = [m for mid, m in global_by_id.items()
            if m.get("projectId") == pid and mid not in ids_here]
    if not lost:
        continue
    fixed += len(lost)
    print(f"⚠️  {pid}: в проектном индексе нет {len(lost)} встреч из глобального: {[m['id'] for m in lost]}")
    if APPLY:
        for m in lost:
            base_key = m.get("baseKey")
            manifest = read_json(f"{base_key}/meeting.json") if base_key else \
                       read_json(f"projects/{pid}/meetings/{m['id']}/meeting.json")
            manifest = manifest or {}
            idx.append({
                "id": m["id"],
                "projectId": pid,
                "date": manifest.get("date"),
                "status": manifest.get("status"),
                "currentStage": manifest.get("currentStage"),
                "updatedAt": manifest.get("updatedAt"),
                "summaryTitle": ((manifest.get("protocol") or {}).get("summary") or {}).get("title")
                                 or manifest.get("titleDraft")
            })
        write_json(f"projects/{pid}/meetings/index.json", idx)
        print(f"   ✓ projects/{pid}/meetings/index.json дополнен")

# ── Итог ─────────────────────────────────────────────────────────────────────
if fixed == 0 and reported == 0:
    print("✅ Индексы консистентны, расхождений нет.")
elif fixed and not APPLY:
    print(f"\nАвтопочинимых расхождений: {fixed}. Запустите с --apply, чтобы синхронизировать.")
elif fixed:
    print(f"\n✅ Синхронизировано расхождений: {fixed}.")
else:
    print("\n✅ Автопочинимых расхождений нет (выше — только информационные).")
PYEOF
