# -*- coding: utf-8 -*-
"""DSM Web API v0.2 — 구글 로그인 + 유저별 저장(프로젝트/미디어) + 유저별 OpenAI 키.
미디어(이미지/오디오/영상)는 DB에 저장(유저별), /api/media/{id}?token= 으로 서빙."""
import os, uuid, base64, shutil, threading, json
from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, Request
from fastapi.responses import Response, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session
import engine, auth
from db import init_db, get_db, SessionLocal, User, Project, Media, Setting

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


@app.get("/.well-known/assetlinks.json")
def assetlinks():
    """안드로이드 TWA 앱 검증(주소창 제거/풀스크린). 시크릿 ASSETLINKS_SHA256 설정 시 활성."""
    fp = (os.environ.get("ASSETLINKS_SHA256", "") or "").strip()
    if not fp:
        return []
    return [{
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": {"namespace": "android_app", "package_name": "com.dory.dsm",
                   "sha256_cert_fingerprints": [fp]},
    }]


@app.get("/api/bgm-preview")
def bgm_preview(mood: str = "auto"):
    """무드별 7초 미리듣기(합성, 캐시)."""
    m = mood if mood in engine._MOODS else "auto"
    path = os.path.join(WORK, f"prev_{m}.wav")
    if not os.path.exists(path):
        engine.build_bgm(path, 7.0, mood=m)
    return FileResponse(path, media_type="audio/wav")


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
    return {"token": auth.make_jwt(u.id), "user": _user_obj(u)}


@app.post("/api/auth/dev")
def auth_dev(s: Session = Depends(get_db)):
    """구글 클라이언트ID 미설정(로컬/초기)일 때만 동작하는 게스트 로그인."""
    if auth.GOOGLE_CLIENT_ID:
        raise HTTPException(403, "비활성화되어 있습니다 (구글 로그인을 사용하세요).")
    u = s.query(User).filter_by(sub="dev-guest").first()
    if not u:
        u = User(sub="dev-guest", email="guest@dsm.local", name="게스트"); s.add(u); s.commit(); s.refresh(u)
    return {"token": auth.make_jwt(u.id), "user": _user_obj(u)}


def _user_obj(u):
    return {"email": u.email, "name": u.name, "has_key": bool(u.enc_key),
            "watermark": (u.watermark is not False)}


@app.get("/api/me")
def me(uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    return _user_obj(s.get(User, uid))


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
_AUDIO_MIME = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
               ".aac": "audio/aac", ".ogg": "audio/ogg"}


def _store_upload(file, uid, kind, allow, s):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in allow:
        raise HTTPException(400, "허용되지 않는 파일 형식입니다.")
    blob = file.file.read()
    mid = uuid.uuid4().hex + ext
    if kind == "audio":
        mime = _AUDIO_MIME.get(ext, "audio/mpeg")
    else:
        mime = "image/" + (ext[1:] or "png").replace("jpg", "jpeg")
    nm = (file.filename or "")[:256]
    s.add(Media(id=mid, user_id=uid, kind=kind, mime=mime, name=nm, blob=blob)); s.commit()
    return {"id": mid, "name": nm}


@app.post("/api/upload-image")
async def upload_image(file: UploadFile = File(...), uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    return _store_upload(file, uid, "image", (".png", ".jpg", ".jpeg", ".webp"), s)


@app.post("/api/upload-audio")
async def upload_audio(file: UploadFile = File(...), uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    return _store_upload(file, uid, "audio", (".mp3", ".wav", ".m4a", ".aac", ".ogg"), s)


@app.get("/api/media/{mid}")
def get_media(mid: str, request: Request, uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    m = s.get(Media, mid)
    if not m or m.user_id != uid:
        raise HTTPException(404, "없음")
    blob = m.blob or b""
    mime = m.mime or "application/octet-stream"
    total = len(blob)
    rng = request.headers.get("range")
    if rng and rng.startswith("bytes="):      # 부분요청(오디오/영상 재생에 필요)
        try:
            a, b = rng[6:].split("-", 1)
            start = int(a) if a else 0
            end = int(b) if b else total - 1
            end = min(end, total - 1)
            if 0 <= start <= end:
                chunk = blob[start:end + 1]
                return Response(content=chunk, status_code=206, media_type=mime, headers={
                    "Content-Range": f"bytes {start}-{end}/{total}",
                    "Accept-Ranges": "bytes", "Content-Length": str(len(chunk))})
        except Exception:
            pass
    return Response(content=blob, media_type=mime,
                    headers={"Accept-Ranges": "bytes", "Content-Length": str(total)})


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
    _u = s.get(User, uid)
    st["watermark"] = bool(_u.watermark) if (_u and _u.watermark is not None) else True
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


@app.get("/api/audios")
def list_audios(uid: int = Depends(auth.current_uid), s: Session = Depends(get_db)):
    """유저가 올린 음악(불러온 순)."""
    rows = s.query(Media).filter_by(user_id=uid, kind="audio").order_by(Media.created.asc()).all()
    return [{"id": m.id, "name": m.name or m.id, "created": str(m.created)[:16]} for m in rows]


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


# ───────── 관리자 ─────────
_ADMIN_HTML = """<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>DSM 관리자</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0c0e13;color:#e8eaf0;font-family:system-ui,'Malgun Gothic',sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:24px 16px}h1{font-size:20px;color:#e3bd82}
.card{background:#161a22;border:1px solid #232838;border-radius:14px;padding:18px;margin:14px 0}
input{background:#0e1117;border:1px solid #2a3142;color:#fff;border-radius:8px;padding:10px;font-size:14px}
button{background:#5b7cfa;color:#fff;border:none;border-radius:8px;padding:9px 14px;font-weight:700;cursor:pointer}
button.ghost{background:#222838}table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:10px;border-bottom:1px solid #232838;text-align:left}th{cursor:pointer;user-select:none}
th:hover{color:#cfd6e6}.muted{color:#8b93a7;font-size:13px}.link{color:#7d97ff;font-size:13px;cursor:pointer;text-decoration:underline}.th-s{color:#7d97ff}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.err{color:#ff6b6b;font-size:13px;min-height:18px;margin:6px 0}
.sw{position:relative;width:46px;height:26px;display:inline-block}.sw input{display:none}
.sl{position:absolute;inset:0;background:#3a4256;border-radius:99px;cursor:pointer;transition:.2s}
.sl:before{content:'';position:absolute;width:20px;height:20px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
.sw input:checked+.sl{background:#29c081}.sw input:checked+.sl:before{transform:translateX(20px)}
.login-view{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.login-card{width:330px;max-width:100%;background:#161a22;border:1px solid #232838;border-radius:18px;padding:30px 26px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
.login-logo{text-align:center;font-size:23px;font-weight:800;background:linear-gradient(135deg,#5b7cfa,#e3bd82);-webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:24px}
.lrow{display:flex;align-items:center;gap:12px;margin-bottom:12px}.ll{width:34px;color:#8b93a7;font-weight:700;font-size:14px}
.lrow input{flex:1;width:100%}.login-btn{width:100%;margin-top:10px;padding:13px;font-size:15px}
</style></head><body>
<div id="loginView" class="login-view"><div class="login-card">
<div class="login-logo">DSM 관리자</div>
<div class="lrow"><span class="ll">ID :</span><input id="u" value="admin"></div>
<div class="lrow"><span class="ll">PW :</span><input id="p" type="password" onkeydown="if(event.key==='Enter')login()"></div>
<div id="lerr" class="err"></div>
<button class="login-btn" onclick="login()">로그인</button>
</div></div>
<div id="panel" class="wrap" style="display:none"><h1>DSM 관리자</h1>
<div class="card"><div class="row"><b>비밀번호 변경</b>
<input id="np" type="password" placeholder="새 비밀번호(4자+)" style="width:170px">
<button onclick="chpw()">변경</button>
<span class="row" style="margin-left:auto">
<button class="ghost" onclick="wmAll(true)">전체 ON</button>
<button class="ghost" onclick="wmAll(false)">전체 OFF</button>
<button class="ghost" onclick="logout()">로그아웃</button></span></div></div>
<div class="card">
<div class="row" style="margin-bottom:12px"><b>사용자 <span id="cnt" class="muted"></span></b>
<input id="q" placeholder="이름 · 아이디 검색" oninput="render()" autocomplete="off" style="width:200px;margin-left:8px">
<span class="link" onclick="clearFilter()" style="margin-left:auto">필터 해제</span></div>
<table><thead><tr>
<th onclick="sortBy('name')">이름 / 이메일<span id="s-name" class="th-s"></span></th>
<th onclick="sortBy('videos')">영상<span id="s-videos" class="th-s"></span></th>
<th onclick="sortBy('created')">가입<span id="s-created" class="th-s"></span></th>
<th onclick="sortBy('watermark')">워터마크<span id="s-watermark" class="th-s"></span></th>
</tr></thead><tbody id="rows"></tbody></table></div></div>
<script>
const T=()=>localStorage.getItem('dsm_adm')||'';
const H=()=>({'Authorization':'Bearer '+T(),'Content-Type':'application/json'});
async function login(){
 const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u.value,password:p.value})});
 const d=await r.json();if(!r.ok){lerr.textContent=d.detail||'실패';return}
 localStorage.setItem('dsm_adm',d.token);show();}
function logout(){localStorage.removeItem('dsm_adm');location.reload();}
async function chpw(){const r=await fetch('/api/admin/password',{method:'POST',headers:H(),body:JSON.stringify({password:np.value})});const d=await r.json();alert(r.ok?'비밀번호가 변경됐어요':(d.detail||'실패'));if(r.ok)np.value='';}
let ALL=[],sortKey='created',sortAsc=false;
async function wm(id,on){await fetch('/api/admin/user-watermark',{method:'POST',headers:H(),body:JSON.stringify({user_id:id,on:on})});var u=ALL.find(function(x){return x.id===id});if(u)u.watermark=on;}
async function wmAll(on){if(!confirm('모든 사용자 워터마크를 '+(on?'ON':'OFF')+' 할까요?'))return;await fetch('/api/admin/watermark-all',{method:'POST',headers:H(),body:JSON.stringify({on:on})});load();}
async function load(){
 const r=await fetch('/api/admin/users',{headers:H()});if(r.status===403||r.status===401){logout();return}
 ALL=await r.json();render();}
function sortBy(k){if(sortKey===k){sortAsc=!sortAsc}else{sortKey=k;sortAsc=true}render();}
function clearFilter(){q.value='';sortKey='created';sortAsc=false;render();}
function render(){
 const t=(q.value||'').trim().toLowerCase();
 let L=ALL.filter(function(x){return !t||(x.name||'').toLowerCase().includes(t)||(x.email||'').toLowerCase().includes(t);});
 L.sort(function(a,b){var av=a[sortKey],bv=b[sortKey];if(sortKey==='name'){av=(a.name||'').toLowerCase();bv=(b.name||'').toLowerCase();}if(av<bv)return sortAsc?-1:1;if(av>bv)return sortAsc?1:-1;return 0;});
 cnt.textContent='('+L.length+'명)';
 rows.innerHTML=L.map(function(x){return '<tr><td><div>'+(x.name||'')+'</div><div class="muted">'+(x.email||'')+'</div></td><td>'+x.videos+'</td><td class="muted">'+x.created+'</td><td><label class="sw"><input type="checkbox" '+(x.watermark?'checked':'')+' onchange="wm('+x.id+',this.checked)"><span class="sl"></span></label></td></tr>';}).join('');
 ['name','videos','created','watermark'].forEach(function(k){document.getElementById('s-'+k).textContent=(sortKey===k)?(sortAsc?' ▲':' ▼'):'';});}
function show(){document.getElementById('loginView').style.display='none';panel.style.display='';q.value='';load();}
if(T())show();
</script></body></html>"""


class AdminLogin(BaseModel):
    username: str = "admin"
    password: str
class WmIn(BaseModel):
    user_id: int
    on: bool
class WmAll(BaseModel):
    on: bool
class PwChange(BaseModel):
    password: str


def _admin_pw_hash(s):
    row = s.get(Setting, "admin_pw")
    return row.value if row else auth.pw_hash("1111")


@app.post("/api/admin/login")
def admin_login(b: AdminLogin, s: Session = Depends(get_db)):
    if b.username != "admin" or auth.pw_hash(b.password) != _admin_pw_hash(s):
        raise HTTPException(401, "아이디 또는 비밀번호가 올바르지 않습니다.")
    return {"token": auth.make_admin_jwt()}


@app.get("/api/admin/users")
def admin_users(_: bool = Depends(auth.require_admin), s: Session = Depends(get_db)):
    rows = s.query(User).order_by(User.created.desc()).all()
    out = []
    for u in rows:
        vc = s.query(Media).filter_by(user_id=u.id, kind="video").count()
        out.append({"id": u.id, "email": u.email, "name": u.name,
                    "watermark": (u.watermark is not False), "videos": vc,
                    "created": str(u.created)[:16]})
    return out


@app.post("/api/admin/user-watermark")
def admin_set_wm(b: WmIn, _: bool = Depends(auth.require_admin), s: Session = Depends(get_db)):
    u = s.get(User, b.user_id)
    if not u:
        raise HTTPException(404, "사용자 없음")
    u.watermark = bool(b.on); s.commit()
    return {"ok": True, "watermark": u.watermark}


@app.post("/api/admin/watermark-all")
def admin_wm_all(b: WmAll, _: bool = Depends(auth.require_admin), s: Session = Depends(get_db)):
    s.query(User).update({User.watermark: bool(b.on)}); s.commit()
    return {"ok": True}


@app.post("/api/admin/password")
def admin_pw(b: PwChange, _: bool = Depends(auth.require_admin), s: Session = Depends(get_db)):
    if len(b.password) < 4:
        raise HTTPException(400, "비밀번호는 4자 이상이어야 합니다.")
    row = s.get(Setting, "admin_pw")
    if row:
        row.value = auth.pw_hash(b.password)
    else:
        s.add(Setting(key="admin_pw", value=auth.pw_hash(b.password)))
    s.commit()
    return {"ok": True}


@app.get("/adm", response_class=HTMLResponse)
def admin_page():
    return _ADMIN_HTML


# ───────── 프론트(React 빌드) 서빙 — 단일 URL ─────────
FRONT = os.path.abspath(os.path.join(BASE, "..", "frontend", "dist"))
if os.path.isdir(FRONT):
    app.mount("/", StaticFiles(directory=FRONT, html=True), name="frontend")
