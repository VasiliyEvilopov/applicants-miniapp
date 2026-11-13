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
        "https://vasilyevilopov.github.io",
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


async def _run_clone(job_id: str, proxy_str: str, zip_bytes: bytes):
    work_dir = jobs[job_id]["work_dir"]
    try:
        proxy = parse_proxy(proxy_str)

        # Save and extract zip
        zip_path = os.path.join(work_dir, "tdata.zip")
        with open(zip_path, "wb") as f:
            f.write(zip_bytes)

        extract_dir = os.path.join(work_dir, "extracted")
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_dir)

        # Find tdata folder
        tdata_path = None
        for root, dirs, files in os.walk(extract_dir):
            for d in dirs:
                if d.lower() == "tdata":
                    tdata_path = os.path.join(root, d)
                    break
            if tdata_path:
                break

        if not tdata_path:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = "Папка tdata не найдена в архиве"
            return

        output_dir = os.path.join(work_dir, "output")
        cloner = TDataCloner(
            api_id=API_ID,
            api_hash=API_HASH,
            proxy=proxy,
            code_timeout=90,
        )

        new_tdata_path = await cloner.clone(tdata_path, output_dir)

        # Zip result
        zip_out = os.path.join(work_dir, "new_tdata.zip")
        with zipfile.ZipFile(zip_out, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(new_tdata_path):
                for file in files:
                    abs_path = os.path.join(root, file)
                    arc_name = os.path.relpath(abs_path, os.path.dirname(new_tdata_path))
                    zf.write(abs_path, arc_name)

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
    tdata_zip: UploadFile = File(...),
):
    _cleanup_old_jobs()

    if not tdata_zip.filename.endswith(".zip"):
        raise HTTPException(400, "Нужен .zip файл")

    job_id = str(uuid.uuid4())
    work_dir = tempfile.mkdtemp(prefix=f"api_clone_{job_id[:8]}_")
    zip_bytes = await tdata_zip.read()

    jobs[job_id] = {
        "status": "running",
        "work_dir": work_dir,
        "result_path": None,
        "error": None,
        "created_at": time.time(),
    }

    asyncio.create_task(_run_clone(job_id, proxy, zip_bytes))
    return {"job_id": job_id, "status": "running"}


@app.get("/status/{job_id}")
async def get_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    resp = {"job_id": job_id, "status": job["status"]}
    if job["error"]:
        resp["error"] = job["error"]
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
