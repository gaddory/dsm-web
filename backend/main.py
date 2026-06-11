# -*- coding: utf-8 -*-
"""DSM Web API v0.2 — 구글 로그인 + 유저별 저장(프로젝트/미디어) + 유저별 OpenAI 키.
미디어(이미지/오디오/영상)는 DB에 저장(유저별), /api/media/{id}?token= 으로 서빙."""
import os, uuid, base64, shutil, threading, json
from fastapi import FastAPI, UploadFile, File, HTTPException, Depends
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session
import engine, auth
from db import init_db, get_db, SessionLocal, User, Project, Media

BASE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(BASE, "data", "work")
os.makedirs(WORK, exist_ok=True)
init_db()

app = FastAPI(title="DSM Web API", version="0.2")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

JOBS = {}   # job_id -> {status, progress, media, error}


# ───────── 모델 ─────────
class GoogleIn(BaseModel):
    credential: str
class KeyIn(BaseModel):
    api_key: str
class SuggestIn(BaseModel):
    text: str
class GenIn(BaseModel):
    prompt: str
class RenderIn(BaseModel):
    project: dict
class ProjIn(BaseModel):
    name: str = "제목 없음"
    data: dict = {}


# ───────── 설정 / 인증 ─────────
@app.get("/api/health")
def health():
    return {"ok": True, "ffmpeg": engine.FFMPEG, "login": bool(auth.GOOGLE_CLIENT_ID)}


@app.get("/api/config")
def config():
    return {"google_client_id": auth.GOOGLE_CLIENT_ID}


@app.post("/api/auth/google")
def auth_google(b: GoogleIn, s: Session = Depends(get_db)):
    try:
        info = auth.verify_google(b.credential)
    except Exception:
        raise HTTPException(401, "구글 인증에 실패했습니다.")
    sub = info.get("sub")
    u = s.query(User).filter_by(sub=sub).first()
    if not u:
        u = User(sub=sub, email=info.get("email"), name=info.get("name")); s.add(u)
    else:
        u.email = info.get("email"); u.name = info.get("name")
    s.commit(); s.refresh(u)
    return {"token": auth.make_jwt(u.id),
            "user": {"email": u.email, "name": u.name, "has_key": bool(u.enc_key)}}


@app.post("/api/auth/dev")
def auth_dev(s: Session = Depends(get_db)):
    """구글 클라이언트ID 미설정(로컬/초기)일 때만 동작하는 게스트 로그인."""
    if auth.GOOGLE_CLIENT_ID:
        raise HTTPException(403, "비활성화되어 있습니다 (구글 로그인을 사용하세요).")
    u = s.query(User).filter_by(sub="dev-guest").first()
    if not u:
        u = User(sub="dev-guest", email="guest@dsm.local", name="게스트"); s.add(u); s.commit(); s.refresh(u)
    return {"token": auth.make_jwt(u.id),
            "user": {"email": u.email, "name": u.name, "has_key": bool(u.enc_key)}}


@app.get("/api/me")
def me(uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    u = s.get(User, uid)
    return {"email": u.email, "name": u.name, "has_key": bool(u.enc_key)}


@app.post("/api/key")
def set_key(b: KeyIn, uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    key = "".join(b.api_key.split())
    valid = engine.validate_key(key)
    if valid:
        u = s.get(User, uid); u.enc_key = auth.enc(key); s.commit()
    return {"valid": bool(valid)}


@app.delete("/api/key")
def del_key(uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    u = s.get(User, uid); u.enc_key = None; s.commit(); return {"ok": True}


def _user_key(uid, s):
    u = s.get(User, uid); k = auth.dec(u.enc_key) if u else None
    if not k:
        raise HTTPException(400, "OpenAI API 키를 먼저 등록하세요.")
    return k


# ───────── AI ─────────
@app.post("/api/suggest-prompt")
def suggest(b: SuggestIn, uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    try:
        return {"prompt": engine.suggest_prompt(_user_key(uid, s), b.text)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e))


@app.post("/api/gen-image")
def gen_image(b: GenIn, uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    key = _user_key(uid, s)
    tmp = os.path.join(WORK, uuid.uuid4().hex + ".jpg")
    try:
        engine.gen_image(key, b.prompt, tmp)
    except Exception as e:
        raise HTTPException(400, str(e))
    blob = open(tmp, "rb").read(); os.remove(tmp)
    mid = uuid.uuid4().hex + ".jpg"
    s.add(Media(id=mid, user_id=uid, kind="image", mime="image/jpeg", blob=blob)); s.commit()
    return {"id": mid, "image_b64": "data:image/jpeg;base64," + base64.b64encode(blob).decode()}


# ───────── 미디어 ─────────
def _store_upload(file, uid, kind, allow, s):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in allow:
        raise HTTPException(400, "허용되지 않는 파일 형식입니다.")
    blob = file.file.read()
    mid = uuid.uuid4().hex + ext
    mime = "audio/mpeg" if kind == "audio" else ("image/" + (ext[1:] or "png").replace("jpg", "jpeg"))
    s.add(Media(id=mid, user_id=uid, kind=kind, mime=mime, blob=blob)); s.commit()
    return {"id": mid}


@app.post("/api/upload-image")
async def upload_image(file: UploadFile = File(...), uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    return _store_upload(file, uid, "image", (".png", ".jpg", ".jpeg", ".webp"), s)


@app.post("/api/upload-audio")
async def upload_audio(file: UploadFile = File(...), uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    return _store_upload(file, uid, "audio", (".mp3", ".wav", ".m4a", ".aac", ".ogg"), s)


@app.get("/api/media/{mid}")
def get_media(mid: str, uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    m = s.get(Media, mid)
    if not m or m.user_id != uid:
        raise HTTPException(404, "없음")
    return Response(content=m.blob, media_type=m.mime or "application/octet-stream")


# ───────── 렌더 ─────────
@app.post("/api/render")
def render(b: RenderIn, uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    job_id = uuid.uuid4().hex
    work = os.path.join(WORK, job_id); os.makedirs(work, exist_ok=True)

    def fetch(mid):
        if not mid:
            return ""
        m = s.get(Media, mid)
        if not m or m.user_id != uid:
            return ""
        p = os.path.join(work, "m_" + mid)
        open(p, "wb").write(m.blob); return p

    p = b.project; st = dict(p.get("settings", {}))
    cuts = []
    for c in p.get("cuts", []):
        c = dict(c)
        if c.get("image"):
            c["image"] = fetch(c["image"])
        cuts.append(c)
    if st.get("ending_image"):
        st["ending_image"] = fetch(st["ending_image"])
    if st.get("bgm_mode") == "file" and st.get("bgm_file"):
        st["bgm_file"] = fetch(st["bgm_file"])
    out_file = os.path.join(work, "out.mp4"); st["out_path"] = out_file
    proj2 = {"settings": st, "cuts": cuts}
    JOBS[job_id] = {"status": "running", "progress": "시작", "media": None, "error": None}

    def job():
        try:
            engine.render_video(proj2, work, progress=lambda m: JOBS[job_id].update(progress=m))
            blob = open(out_file, "rb").read()
            vid = uuid.uuid4().hex + ".mp4"
            ss = SessionLocal()
            try:
                ss.add(Media(id=vid, user_id=uid, kind="video", mime="video/mp4", blob=blob)); ss.commit()
            finally:
                ss.close()
            JOBS[job_id].update(status="done", progress="완료", media=vid)
        except Exception as e:
            JOBS[job_id].update(status="error", error=str(e))
        finally:
            shutil.rmtree(work, ignore_errors=True)

    threading.Thread(target=job, daemon=True).start()
    return {"job_id": job_id}


@app.get("/api/render/{job_id}")
def render_status(job_id: str, uid: int = Depends(auth.current_uid)):
    j = JOBS.get(job_id)
    if not j:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return j


@app.get("/api/videos")
def list_videos(uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    rows = s.query(Media).filter_by(user_id=uid, kind="video").order_by(Media.created.desc()).all()
    return [{"id": m.id, "created": str(m.created)[:16]} for m in rows]


@app.delete("/api/media/{mid}")
def del_media(mid: str, uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    m = s.get(Media, mid)
    if m and m.user_id == uid:
        s.delete(m); s.commit()
    return {"ok": True}


# ───────── 프로젝트 CRUD ─────────
@app.get("/api/projects")
def list_projects(uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    rows = s.query(Project).filter_by(user_id=uid).order_by(Project.updated.desc()).all()
    return [{"id": p.id, "name": p.name, "updated": str(p.updated)[:16]} for p in rows]


@app.post("/api/projects")
def create_project(b: ProjIn, uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    p = Project(user_id=uid, name=b.name or "제목 없음", data=json.dumps(b.data, ensure_ascii=False))
    s.add(p); s.commit(); s.refresh(p); return {"id": p.id}


def _own(pid, uid, s):
    p = s.get(Project, pid)
    if not p or p.user_id != uid:
        raise HTTPException(404, "프로젝트를 찾을 수 없습니다.")
    return p


@app.get("/api/projects/{pid}")
def get_project(pid: int, uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    p = _own(pid, uid, s)
    return {"id": p.id, "name": p.name, "data": json.loads(p.data or "{}")}


@app.put("/api/projects/{pid}")
def update_project(pid: int, b: ProjIn, uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    p = _own(pid, uid, s)
    p.name = b.name or p.name; p.data = json.dumps(b.data, ensure_ascii=False); s.commit()
    return {"ok": True}


@app.delete("/api/projects/{pid}")
def delete_project(pid: int, uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    s.delete(_own(pid, uid, s)); s.commit(); return {"ok": True}


# ───────── 프론트(React 빌드) 서빙 — 단일 URL ─────────
FRONT = os.path.abspath(os.path.join(BASE, "..", "frontend", "dist"))
if os.path.isdir(FRONT):
    app.mount("/", StaticFiles(directory=FRONT, html=True), name="frontend")
