"""
HTTP API for TData Cloner — called from the Mini App frontend.

Endpoints:
  POST /clone        — start a clone job (multipart: proxy + tdata_zip)
  GET  /status/{id}  — poll job status
  GET  /result/{id}  — download result zip

Jobs run in-process via asyncio tasks.
Data lives in memory + temp dirs (cleaned after download or timeout).
"""

import asyncio
import base64
import logging
import os
import shutil
import tempfile
import time
import uuid
import zipfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from src import TDataCloner, parse_proxy
from src.config import API_ID, API_HASH

logger = logging.getLogger(__name__)

app = FastAPI(title="TData Cloner API")

# Allow requests from GitHub Pages and local dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://vasiliyevilopov.github.io",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:3000",
    ],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# In-memory job store: job_id -> {status, result_path, work_dir, error, created_at}
jobs: dict[str, dict] = {}

JOB_TTL = 600  # seconds before job is cleaned up


def _cleanup_old_jobs():
    now = time.time()
    stale = [jid for jid, j in jobs.items() if now - j.get("created_at", 0) > JOB_TTL]
    for jid in stale:
        shutil.rmtree(jobs[jid].get("work_dir", ""), ignore_errors=True)
        del jobs[jid]


MAX_CONCURRENT = 5


def _expand_nested_zips(base_dir: str):
    changed = True
    while changed:
        changed = False
        for root, dirs, files in os.walk(base_dir):
            dirs[:] = [d for d in dirs if not d.startswith("__") and not d.startswith(".")]
            for fname in files:
                if not fname.lower().endswith(".zip"):
                    continue
                zip_p = os.path.join(root, fname)
                out_d = os.path.join(root, fname[:-4])
                if os.path.exists(out_d):
                    continue
                try:
                    os.makedirs(out_d, exist_ok=True)
                    with zipfile.ZipFile(zip_p, "r") as zf:
                        zf.extractall(out_d)
                    changed = True
                except Exception:
                    pass


def _find_all_tdata(base_dir: str) -> list[str]:
    result = []
    for root, dirs, files in os.walk(base_dir):
        dirs[:] = [d for d in dirs if not d.startswith("__") and not d.startswith(".")]
        to_remove = []
        for d in dirs:
            if d.lower() == "tdata":
                result.append(os.path.join(root, d))
                to_remove.append(d)
        for d in to_remove:
            dirs.remove(d)
    return result


async def _clone_one(idx: int, tdata_path: str, output_dir: str, proxy, semaphore, job_id: str):
    async with semaphore:
        acc_out = os.path.join(output_dir, f"slot_{idx:03d}")
        os.makedirs(acc_out, exist_ok=True)
        cloner = TDataCloner(api_id=API_ID, api_hash=API_HASH, proxy=proxy, code_timeout=90)
        try:
            phone, new_tdata = await cloner.clone(tdata_path, acc_out)
            return phone, new_tdata, None
        except Exception as e:
            logger.exception(f"Clone error account {idx} job {job_id}")
            return f"acc{idx:03d}", None, str(e)


async def _run_clone(job_id: str, proxy_str: str, zip_bytes_list: list[bytes]):
    work_dir = jobs[job_id]["work_dir"]
    try:
        proxy = parse_proxy(proxy_str) if proxy_str and proxy_str != "-" else None

        extract_dir = os.path.join(work_dir, "extracted")
        os.makedirs(extract_dir, exist_ok=True)

        # Save and extract every uploaded zip
        for i, zb in enumerate(zip_bytes_list):
            slot = os.path.join(extract_dir, f"zip_{i:03d}")
            os.makedirs(slot, exist_ok=True)
            try:
                import io
                with zipfile.ZipFile(io.BytesIO(zb)) as zf:
                    zf.extractall(slot)
            except zipfile.BadZipFile:
                pass

        _expand_nested_zips(extract_dir)
        tdata_paths = _find_all_tdata(extract_dir)

        if not tdata_paths:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = "Папка tdata не найдена ни в одном архиве"
            return

        jobs[job_id]["total"] = len(tdata_paths)

        output_dir = os.path.join(work_dir, "output")
        os.makedirs(output_dir, exist_ok=True)
        semaphore = asyncio.Semaphore(MAX_CONCURRENT)

        tasks = [
            _clone_one(i, tp, output_dir, proxy, semaphore, job_id)
            for i, tp in enumerate(tdata_paths, 1)
        ]
        results = await asyncio.gather(*tasks)

        ok     = [(phone, path) for phone, path, err in results if path]
        errors = [(phone, err)  for phone, path, err in results if err]

        jobs[job_id]["ok_count"] = len(ok)
        jobs[job_id]["errors"]   = errors

        if not ok:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"]  = "; ".join(f"{p}: {e}" for p, e in errors[:5])
            return

        zip_out = os.path.join(work_dir, "cloned_tdata.zip")
        with zipfile.ZipFile(zip_out, "w", zipfile.ZIP_DEFLATED) as zf:
            for phone, new_tdata in ok:
                for root, dirs, files in os.walk(new_tdata):
                    for fname in files:
                        abs_p = os.path.join(root, fname)
                        rel   = os.path.relpath(abs_p, os.path.dirname(new_tdata))
                        zf.write(abs_p, f"{phone}/{rel}")

        jobs[job_id]["result_path"] = zip_out
        jobs[job_id]["status"] = "done"

    except Exception as e:
        logger.exception(f"Clone error for job {job_id}")
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(e)


@app.get("/")
async def health():
    return {"ok": True, "service": "tdata-cloner-api"}


@app.post("/clone")
async def start_clone(
    proxy: str = Form(...),
    tdata_zip: list[UploadFile] = File(...),
):
    _cleanup_old_jobs()

    zip_bytes_list = []
    for f in tdata_zip:
        if not f.filename.lower().endswith(".zip"):
            raise HTTPException(400, f"Нужен .zip файл, получено: {f.filename}")
        zip_bytes_list.append(await f.read())

    if not zip_bytes_list:
        raise HTTPException(400, "Не передано ни одного файла")

    job_id = str(uuid.uuid4())
    work_dir = tempfile.mkdtemp(prefix=f"api_clone_{job_id[:8]}_")

    jobs[job_id] = {
        "status": "running",
        "work_dir": work_dir,
        "result_path": None,
        "error": None,
        "created_at": time.time(),
        "total": len(zip_bytes_list),
        "ok_count": 0,
        "errors": [],
    }

    asyncio.create_task(_run_clone(job_id, proxy, zip_bytes_list))
    return {"job_id": job_id, "status": "running", "files": len(zip_bytes_list)}


@app.get("/status/{job_id}")
async def get_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    resp = {
        "job_id": job_id,
        "status": job["status"],
        "total": job.get("total", 1),
        "ok_count": job.get("ok_count", 0),
    }
    if job.get("error"):
        resp["error"] = job["error"]
    if job.get("errors"):
        resp["errors"] = job["errors"][:10]
    return resp


@app.get("/result/{job_id}")
async def get_result(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] != "done":
        raise HTTPException(400, f"Job status: {job['status']}")
    path = job["result_path"]
    if not path or not os.path.exists(path):
        raise HTTPException(500, "Result file missing")
    return FileResponse(
        path,
        media_type="application/zip",
        filename="new_tdata.zip",
        headers={"Access-Control-Allow-Origin": "*"},
    )
