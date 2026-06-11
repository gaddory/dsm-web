# -*- coding: utf-8 -*-
"""DSM Web API — 데스크톱 DSM의 엔진(engine.py)을 그대로 재활용한 백엔드 골격.
엔드포인트: 키검증 / 프롬프트추천 / AI이미지생성 / 이미지업로드 / 렌더(비동기) / 상태조회."""
import os, uuid, base64, shutil, threading
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import engine

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")
MEDIA = os.path.join(DATA, "media")       # 업로드 + AI생성 이미지
RENDERS = os.path.join(DATA, "renders")   # 완성 mp4
WORK = os.path.join(DATA, "work")         # 렌더 임시작업
for _d in (DATA, MEDIA, RENDERS, WORK):
    os.makedirs(_d, exist_ok=True)

app = FastAPI(title="DSM Web API", version="0.1")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/media", StaticFiles(directory=MEDIA), name="media")
app.mount("/renders", StaticFiles(directory=RENDERS), name="renders")

JOBS = {}   # job_id -> {status, progress, file, error}


def _media_path(mid):
    return os.path.join(MEDIA, os.path.basename(mid))   # 경로주입 방지: 파일명만


# ───────── 모델 ─────────
class KeyIn(BaseModel):
    api_key: str


class SuggestIn(BaseModel):
    api_key: str
    text: str


class GenIn(BaseModel):
    api_key: str
    prompt: str


class RenderIn(BaseModel):
    project: dict


# ───────── 엔드포인트 ─────────
@app.get("/api/health")
def health():
    return {"ok": True, "ffmpeg": engine.FFMPEG, "font_r": engine.FONT_R, "font_b": engine.FONT_B}


@app.post("/api/validate-key")
def validate_key(b: KeyIn):
    return {"valid": bool(engine.validate_key(b.api_key))}


@app.post("/api/suggest-prompt")
def suggest(b: SuggestIn):
    try:
        return {"prompt": engine.suggest_prompt(b.api_key, b.text)}
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/gen-image")
def gen_image(b: GenIn):
    mid = uuid.uuid4().hex + ".jpg"
    out = _media_path(mid)
    try:
        engine.gen_image(b.api_key, b.prompt, out)
    except Exception as e:
        raise HTTPException(400, str(e))
    with open(out, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    return {"id": mid, "url": f"/media/{mid}", "image_b64": "data:image/jpeg;base64," + b64}


@app.post("/api/upload-image")
async def upload_image(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower() or ".png"
    if ext not in (".png", ".jpg", ".jpeg", ".webp"):
        raise HTTPException(400, "이미지 파일만 업로드할 수 있습니다.")
    mid = uuid.uuid4().hex + ext
    with open(_media_path(mid), "wb") as f:
        shutil.copyfileobj(file.file, f)
    return {"id": mid, "url": f"/media/{mid}"}


@app.post("/api/upload-audio")
async def upload_audio(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename or "")[1].lower() or ".mp3"
    if ext not in (".mp3", ".wav", ".m4a", ".aac", ".ogg"):
        raise HTTPException(400, "오디오 파일만 업로드할 수 있습니다.")
    mid = uuid.uuid4().hex + ext
    with open(_media_path(mid), "wb") as f:
        shutil.copyfileobj(file.file, f)
    return {"id": mid, "url": f"/media/{mid}"}


def _resolve_media(project):
    """프론트가 보낸 project의 이미지 id → 서버 실제 경로로 치환."""
    p = dict(project)
    s = dict(p.get("settings", {}))
    cuts = []
    for c in p.get("cuts", []):
        c = dict(c)
        if c.get("image"):
            c["image"] = _media_path(c["image"])
        cuts.append(c)
    if s.get("ending_image"):
        s["ending_image"] = _media_path(s["ending_image"])
    if s.get("bgm_mode") == "file" and s.get("bgm_file"):
        s["bgm_file"] = _media_path(s["bgm_file"])
    p["cuts"] = cuts
    p["settings"] = s
    return p


@app.post("/api/render")
def render(b: RenderIn):
    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "running", "progress": "시작", "file": None, "error": None}
    proj = _resolve_media(b.project)
    proj.setdefault("settings", {})["out_path"] = os.path.join(RENDERS, job_id + ".mp4")
    work = os.path.join(WORK, job_id)
    os.makedirs(work, exist_ok=True)

    def job():
        try:
            engine.render_video(proj, work, progress=lambda m: JOBS[job_id].update(progress=m))
            JOBS[job_id].update(status="done", progress="완료", file=f"/renders/{job_id}.mp4")
        except Exception as e:
            JOBS[job_id].update(status="error", error=str(e))
        finally:
            shutil.rmtree(work, ignore_errors=True)

    threading.Thread(target=job, daemon=True).start()
    return {"job_id": job_id}


@app.get("/api/render/{job_id}")
def render_status(job_id: str):
    j = JOBS.get(job_id)
    if not j:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return j


# ───────── 프론트(React 빌드) 서빙 — 단일 URL 배포 ─────────
FRONT = os.path.abspath(os.path.join(BASE, "..", "frontend", "dist"))
if os.path.isdir(FRONT):
    app.mount("/", StaticFiles(directory=FRONT, html=True), name="frontend")
