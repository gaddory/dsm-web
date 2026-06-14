# -*- coding: utf-8 -*-
"""ShortsMaker 엔진: 사진+자막 → 세로 숏츠. 장면합성/렌더/AI/미리보기/.lsd 암호화 번들."""
import os, sys, json, ssl, base64, wave, copy, hashlib, subprocess, urllib.request
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageEnhance

FW, FH = 1188, 2112
OUTW, OUTH = 1080, 1920
INK, GOLD, DIM = (244, 234, 219), (212, 172, 116), (200, 190, 176)
def _font_default(bold):
    # 1) 환경변수  2) 윈도우 맑은고딕  3) 번들 fonts/  4) 리눅스 나눔
    env = os.environ.get("DSM_FONT_B" if bold else "DSM_FONT_R")
    if env and os.path.exists(env):
        return env
    cands = [
        r"C:\Windows\Fonts\malgunbd.ttf" if bold else r"C:\Windows\Fonts\malgun.ttf",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts",
                     "Pretendard-Bold.ttf" if bold else "Pretendard-Regular.ttf"),
        "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf" if bold
        else "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    ]
    for c in cands:
        if os.path.exists(c):
            return c
    return cands[0]


FONT_R = _font_default(False)
FONT_B = _font_default(True)
_CTX = ssl.create_default_context(); _CTX.check_hostname = False; _CTX.verify_mode = ssl.CERT_NONE
_NOWIN = 0x08000000 if os.name == "nt" else 0


def app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def find_ffmpeg():
    cands = []
    mei = getattr(sys, "_MEIPASS", None)
    if mei:
        cands.append(os.path.join(mei, "ffmpeg.exe"))
    cands += [os.path.join(app_dir(), "ffmpeg.exe"), os.path.join(app_dir(), "bin", "ffmpeg.exe")]
    for c in cands:
        if os.path.exists(c):
            return c
    return "ffmpeg"


FFMPEG = find_ffmpeg()


def _run(args):
    p = subprocess.run(args, capture_output=True, creationflags=_NOWIN)
    if p.returncode != 0:
        err = (p.stderr or b"").decode("utf-8", "replace").strip()
        tail = "\n".join(err.splitlines()[-12:]) if err else "(stderr 없음)"
        raise RuntimeError(f"ffmpeg 실패(코드 {p.returncode}):\n{tail}")


def fnt(sz, b=False):
    return ImageFont.truetype(FONT_B if b else FONT_R, int(sz))


def _loadfont(path, sz):
    try:
        return ImageFont.truetype(path, int(sz))
    except Exception:
        return ImageFont.truetype(FONT_B, int(sz))


def cover(im, tw, th):
    w, h = im.size
    s = max(tw / w, th / h)
    im = im.resize((int(w * s + .5), int(h * s + .5)), Image.LANCZOS)
    nw, nh = im.size
    l, t = (nw - tw) // 2, (nh - th) // 2
    return im.crop((l, t, l + tw, t + th))


def grad_L(vals):
    col = Image.new("L", (1, FH)); cp = col.load()
    for y in range(FH):
        cp[0, y] = vals(y)
    return col.resize((FW, FH))


def bright_base(img_path, bright=1.34):
    base = cover(Image.open(img_path).convert("RGB"), FW, FH)
    base = ImageEnhance.Brightness(base).enhance(bright)
    base = ImageEnhance.Contrast(base).enhance(1.04)
    base = ImageEnhance.Color(base).enhance(1.08)
    sc = grad_L(lambda y: int(120 * max(0.0, (y / (FH - 1) - 0.42) / 0.58) ** 1.2))
    return Image.composite(Image.new("RGB", (FW, FH), (8, 6, 5)), base, sc)


def _basecanvas(img_path, bright):
    if img_path and os.path.exists(img_path):
        return bright_base(img_path, bright)
    return Image.new("RGB", (FW, FH), (44, 40, 36))


def _line(d, cx, y, text, f, fill, stroke):
    w = d.textlength(text, font=f); x = cx - w / 2
    d.text((x + 1, y + 3), text, font=f, fill=(0, 0, 0), stroke_width=stroke, stroke_fill=(0, 0, 0))
    d.text((x, y), text, font=f, fill=fill, stroke_width=stroke, stroke_fill=(0, 0, 0))


def _fit(text, base, bold, maxw=1010):
    s = base
    while s > 28 and fnt(s, bold).getlength(text) > maxw:
        s -= 3
    return s


def compose_card(img_path, lines, center=0.60, header=None, footer=None, bright=1.34,
                 base_size=58, gold_last=True, font=None):
    """장면 카드 PIL 이미지 반환. font={family, size, color} 주면 그 폰트/색/크기 적용."""
    base = _basecanvas(img_path, bright)
    d = ImageDraw.Draw(base)
    if header:
        _line(d, FW / 2, 150, header, fnt(38), DIM, 4)
    if footer:
        _line(d, FW / 2, FH - 230, footer, fnt(40), DIM, 4)
    lines = [l for l in (lines or []) if l != ""] or [" "]
    if font:
        fam = font.get("family") or FONT_B
        bsz = int(font.get("size", base_size))
        color = tuple(font.get("color", INK))
        s = bsz
        while s > 20 and max(_loadfont(fam, s).getlength(l) for l in lines) > 1010:
            s -= 3
        fo = _loadfont(fam, s)
        hs = [sum(fo.getmetrics()) for _ in lines]; gap = 16
        total = sum(hs) + gap * (len(lines) - 1); y = FH * center - total / 2
        for i, l in enumerate(lines):
            _line(d, FW / 2, y, l, fo, color, max(4, int(s) // 12)); y += hs[i] + gap
    else:
        sz = min(_fit(l, base_size, True) for l in lines)
        f = fnt(sz, True); hs = [sum(f.getmetrics()) for _ in lines]; gap = 16
        total = sum(hs) + gap * (len(lines) - 1); y = FH * center - total / 2
        for i, l in enumerate(lines):
            col = GOLD if (gold_last and i == len(lines) - 1) else INK
            _line(d, FW / 2, y, l, f, col, max(4, int(sz) // 12)); y += hs[i] + gap
    return base


def render_card(img_path, lines, out_png, **kw):
    compose_card(img_path, lines, **kw).save(out_png)
    return out_png


def ken_burns(png, dur, out_mp4):
    fr = int(dur * 30)
    vf = (f"zoompan=z='min(zoom+0.0004,1.07)':d={fr}:"
          f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={OUTW}x{OUTH}:fps=30,format=yuv420p")
    _run([FFMPEG, "-y", "-loop", "1", "-i", png, "-r", "30", "-vf", vf,
          "-frames:v", str(fr), "-c:v", "libx264", "-preset", "veryfast", "-threads", "1", "-pix_fmt", "yuv420p", out_mp4])


def xfade_concat(clips, durs, out, transition="fade", tr=0.45):
    n = len(clips)
    inputs = []
    for c in clips:
        inputs += ["-i", c]
    if n == 1:
        _run([FFMPEG, "-y", "-i", clips[0], "-vf",
              f"fade=t=out:st={max(0,durs[0]-0.5):.3f}:d=0.5", "-c:v", "libx264", "-preset", "veryfast", "-threads", "1", "-pix_fmt", "yuv420p", out])
        return durs[0]
    if transition == "none":   # 하드컷
        total = sum(durs)
        labels = "".join(f"[{i}:v]" for i in range(n))
        filt = f"{labels}concat=n={n}:v=1[c];[c]fade=t=out:st={total-0.5:.3f}:d=0.5[vout]"
        _run([FFMPEG, "-y"] + inputs + ["-filter_complex", filt, "-map", "[vout]",
              "-c:v", "libx264", "-preset", "veryfast", "-threads", "1", "-pix_fmt", "yuv420p", out])
        return total
    tr = max(0.1, min(tr, min(durs) - 0.1))   # 전환이 컷 길이보다 길면 깨짐 → 클램프
    parts, lab, cum = [], "0:v", durs[0]
    for i in range(1, n):
        parts.append(f"[{lab}][{i}:v]xfade=transition={transition}:duration={tr}:offset={cum-tr:.3f}[x{i}]")
        lab = f"x{i}"; cum = cum + durs[i] - tr
    parts.append(f"[{lab}]fade=t=out:st={cum-0.5:.3f}:d=0.5[vout]")
    _run([FFMPEG, "-y"] + inputs + ["-filter_complex", ";".join(parts),
          "-map", "[vout]", "-c:v", "libx264", "-preset", "veryfast", "-threads", "1", "-pix_fmt", "yuv420p", out])
    return cum


def make_thumb(video, out_jpg, t=1.5, w=200):
    try:
        _run([FFMPEG, "-y", "-ss", str(t), "-i", video, "-frames:v", "1", "-vf", f"scale={w}:-1", out_jpg])
        return out_jpg
    except Exception:
        return None


_CHORD = {
    'C':  ('C3', ['C4', 'E4', 'G4', 'C5']),
    'Dm': ('D3', ['D4', 'F4', 'A4', 'D5']),
    'Em': ('E3', ['E4', 'G4', 'B4', 'E5']),
    'F':  ('F2', ['F3', 'A3', 'C4', 'F4']),
    'G':  ('G2', ['G3', 'B3', 'D4', 'G4']),
    'Am': ('A2', ['A3', 'C4', 'E4', 'A4']),
}


def _prog(names):
    return [_CHORD[n] for n in names]


# 분위기별 합성 BGM 프리셋(피아노) — 진행/템포로 느낌 차이
_MOODS = {
    "auto":    {"ch": 2.8, "prog": _prog(['Am', 'F', 'C', 'G'])},   # 감성 피아노
    "calm":    {"ch": 3.6, "prog": _prog(['C', 'Am', 'F', 'G'])},   # 잔잔한 물결
    "bright":  {"ch": 2.3, "prog": _prog(['C', 'G', 'Am', 'F'])},   # 따뜻한 햇살
    "night":   {"ch": 3.9, "prog": _prog(['Am', 'Em', 'F', 'C'])},  # 밤하늘
    "flutter": {"ch": 2.0, "prog": _prog(['C', 'G', 'Am', 'F'])},   # 설렘
    "rain":    {"ch": 3.1, "prog": _prog(['Dm', 'Am', 'F', 'C'])},  # 빗속
    "walk":    {"ch": 2.4, "prog": _prog(['C', 'Em', 'F', 'G'])},   # 산책
    "memory":  {"ch": 3.2, "prog": _prog(['F', 'C', 'Dm', 'Am'])},  # 추억
    "dawn":    {"ch": 4.0, "prog": _prog(['C', 'G', 'Em', 'Am'])},  # 새벽
    "heart":   {"ch": 1.9, "prog": _prog(['Am', 'F', 'G', 'C'])},   # 두근두근
    "longing": {"ch": 3.4, "prog": _prog(['Em', 'C', 'G', 'Am'])},  # 그리움
    "peace":   {"ch": 3.0, "prog": _prog(['F', 'C', 'G', 'Am'])},   # 평온
    "cafe":    {"ch": 2.6, "prog": _prog(['Dm', 'G', 'C', 'Am'])},  # 카페
    "fairy":   {"ch": 2.2, "prog": _prog(['C', 'F', 'G', 'C'])},    # 동화
    "reflect": {"ch": 3.5, "prog": _prog(['Am', 'G', 'F', 'Em'])},  # 여운
    "snow":    {"ch": 3.0, "prog": _prog(['C', 'Am', 'Dm', 'G'])},  # 첫눈
}


def build_bgm(path, total, mood="auto"):
    SR = 44100; N = int(total * SR); buf = np.zeros((N, 2), dtype=np.float32)
    F = {'F2': 87.31, 'G2': 98, 'A2': 110, 'B2': 123.47, 'C3': 130.81, 'D3': 146.83, 'E3': 164.81,
         'F3': 174.61, 'G3': 196, 'A3': 220, 'B3': 246.94, 'C4': 261.63, 'D4': 293.66, 'E4': 329.63,
         'F4': 349.23, 'G4': 392, 'A4': 440, 'B4': 493.88, 'C5': 523.25, 'D5': 587.33, 'E5': 659.25}

    def voice(f, L, a, pan, dec, att=0.004, harm=(1, .5, .22)):
        n = int(L * SR); t = np.arange(n) / SR
        w = sum(h * np.sin(2 * np.pi * f * k * t) for k, h in enumerate(harm, 1)) / sum(harm)
        env = np.exp(-t / dec); aa = int(att * SR)
        if aa: env[:aa] *= np.linspace(0, 1, aa)
        s = a * w * env
        return s * np.cos((pan + 1) * np.pi / 4), s * np.sin((pan + 1) * np.pi / 4)

    def place(st, sl, sr):
        s = int(st * SR)
        if s >= N: return
        e = min(s + len(sl), N); buf[s:e, 0] += sl[:e - s]; buf[s:e, 1] += sr[:e - s]

    m = _MOODS.get(mood, _MOODS["auto"])
    prog = m["prog"]; CH = m["ch"]
    for i in range(int(np.ceil(total / CH)) + 1):
        t0 = i * CH; bass, arp = prog[i % 4]
        l, r = voice(F[bass], 3.0, 0.20, 0, 2.4, harm=(1, .4, .12)); place(t0, l, r)
        for j, nm in enumerate(arp):
            l, r = voice(F[nm], 2.4, 0.15, -0.35 if j % 2 else 0.35, 1.9, harm=(1, .55, .25))
            place(t0 + j * 0.55, l, r)
    mx = np.max(np.abs(buf)) or 1
    buf *= 0.72 / mx
    fi = min(int(1.6 * SR), N); buf[:fi] *= np.linspace(0, 1, fi)[:, None]
    fo = min(int(min(3.2, total / 2) * SR), N); buf[-fo:] *= np.linspace(1, 0, fo)[:, None]
    i16 = (np.clip(buf, -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'w') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(i16.tobytes())


# ───────── OpenAI ─────────
def gen_image(api_key, prompt, out_path, quality="medium"):
    suffix = (", photorealistic cinematic film still, Korean setting, soft natural light, "
              "shallow depth of field, vertical 9:16 composition, no text, no watermark, subtle film grain")
    payload = {"model": "gpt-image-1", "prompt": prompt + suffix, "size": "1024x1536", "quality": quality, "n": 1}
    req = urllib.request.Request("https://api.openai.com/v1/images/generations",
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, context=_CTX, timeout=180) as r:
        data = json.load(r)
    with open(out_path, "wb") as f:
        f.write(base64.b64decode(data["data"][0]["b64_json"]))
    return out_path


def validate_key(api_key):
    req = urllib.request.Request("https://api.openai.com/v1/models",
                                 headers={"Authorization": "Bearer " + api_key})
    try:
        urllib.request.urlopen(req, context=_CTX, timeout=20); return True
    except Exception:
        return False


def suggest_prompt(api_key, korean_text):
    sysmsg = ("You turn a Korean short-video subtitle line into a concise English image-generation prompt "
              "for a photorealistic, emotional, cinematic vertical photo. Korean people/setting. "
              "One sentence, scene only, no text in image. Reply with ONLY the prompt.")
    payload = {"model": "gpt-4o-mini", "messages": [
        {"role": "system", "content": sysmsg}, {"role": "user", "content": korean_text}],
        "temperature": 0.7, "max_tokens": 80}
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, context=_CTX, timeout=60) as r:
        data = json.load(r)
    return data["choices"][0]["message"]["content"].strip()


# ───────── 장면 구성 ─────────
def build_scenes(project):
    s = project.get("settings", {}); cuts = project.get("cuts", [])
    bright = float(s.get("brightness", 1.34)); sdur = float(s.get("scene_dur", 3.8))
    cta_dur = float(s.get("cta_dur", 4.6)); brand = s.get("brand", "")
    fmode = s.get("font_mode", "global"); gfont = s.get("font")
    gpos = float(s.get("sub_pos", 0.62))
    scenes = []
    real = [c for c in cuts if c.get("text") or c.get("image")]
    for i, c in enumerate(real):
        img = c.get("image", "")
        lines = [l for l in c.get("text", "").split("\n") if l.strip() != ""]
        font = (c.get("font") if fmode == "each" else None) or gfont
        cpos = c.get("sub_pos")
        center = float(cpos) if cpos is not None else gpos
        scenes.append({"img": img if img and os.path.exists(img) else None, "lines": lines,
                       "center": center, "header": (brand if (i == 0 and brand) else None),
                       "footer": None, "dur": sdur, "bright": bright, "font": font})
    cta = [l for l in s.get("cta_lines", []) if l.strip()]
    if cta:
        eimg = s.get("ending_image", "")
        scenes.append({"img": eimg if eimg and os.path.exists(eimg) else None, "lines": cta,
                       "center": 0.55, "header": s.get("cta_header") or None,
                       "footer": s.get("footer") or None, "dur": cta_dur, "bright": 1.12,
                       "font": s.get("cta_font") or gfont})
    return scenes


def make_watermark(out_png, lines=("DSM(DoryShortsMaker)", "-Dory-")):
    """반투명 워터마크 PNG(우하단 배치, 여러 줄 가운데정렬)."""
    fnt = ImageFont.truetype(FONT_B, 36)
    dummy = ImageDraw.Draw(Image.new("RGBA", (4, 4)))
    box = [dummy.textbbox((0, 0), ln, font=fnt) for ln in lines]
    hs = [b[3] - b[1] for b in box]
    gap, pad = 6, 14
    tw = max(b[2] - b[0] for b in box)
    th = sum(hs) + gap * (len(lines) - 1)
    img = Image.new("RGBA", (tw + pad * 2, th + pad * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    y = pad
    for ln, b, h in zip(lines, box, hs):
        x = pad + (tw - (b[2] - b[0])) / 2 - b[0]
        d.text((x + 2, y + 2 - b[1]), ln, font=fnt, fill=(0, 0, 0, 120))
        d.text((x, y - b[1]), ln, font=fnt, fill=(255, 255, 255, 160))
        y += h + gap
    img.save(out_png)
    return out_png


def render_video(project, workdir, progress=None):
    os.makedirs(workdir, exist_ok=True)
    scenes = build_scenes(project)
    if not scenes:
        raise RuntimeError("컷이 하나도 없습니다.")

    def log(m):
        if progress: progress(m)

    clips, durs = [], []
    for i, sc in enumerate(scenes):
        png = os.path.join(workdir, f"sc{i}.png")
        render_card(sc["img"], sc["lines"], png, center=sc["center"], header=sc["header"],
                    footer=sc["footer"], bright=sc["bright"], font=sc.get("font"),
                    base_size=(54 if sc["header"] and i == len(scenes) - 1 else 58))
        mp4 = os.path.join(workdir, f"sc{i}.mp4"); ken_burns(png, sc["dur"], mp4)
        clips.append(mp4); durs.append(sc["dur"]); log(f"컷 {i+1}/{len(scenes)} 렌더")

    s = project.get("settings", {})
    log("이어붙이는 중(씬 전환)…")
    silent = os.path.join(workdir, "_silent.mp4")
    total = xfade_concat(clips, durs, silent, transition=s.get("transition", "fade"),
                         tr=float(s.get("trans_dur", 0.45)))
    if s.get("watermark"):
        log("워터마크 적용 중…")
        wm = os.path.join(workdir, "_wm.png"); make_watermark(wm)
        sw = os.path.join(workdir, "_wmv.mp4")
        _run([FFMPEG, "-y", "-i", silent, "-i", wm, "-filter_complex",
              "[0:v][1:v]overlay=W-w-34:H-h-46", "-c:v", "libx264", "-preset", "veryfast",
              "-pix_fmt", "yuv420p", "-threads", "1", "-an", sw])
        silent = sw
    out = s.get("out_path") or os.path.join(app_dir(), "shorts_output.mp4")
    mode = s.get("bgm_mode") or ("auto" if s.get("bgm", True) else "none")
    bfile = s.get("bgm_file", "")
    if mode == "none":
        _run([FFMPEG, "-y", "-i", silent, "-c", "copy", out])
    elif mode == "file" and bfile and os.path.exists(bfile):
        log("내 음악 합치는 중…")
        _run([FFMPEG, "-y", "-i", silent, "-stream_loop", "-1", "-i", bfile,
              "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
              "-t", f"{total:.3f}", out])
    else:
        log("BGM 생성 + 합치는 중…")
        bgm = os.path.join(workdir, "_bgm.wav"); build_bgm(bgm, total, mood=mode if mode in _MOODS else "auto")
        _run([FFMPEG, "-y", "-i", silent, "-i", bgm, "-map", "0:v", "-map", "1:a",
              "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", out])
    log("완료!")
    return out


# ───────── .lsd 암호화 번들(사진 내장) ─────────
LSD_MAGIC = b"LSD1"
_LSD_SECRET = b"ShortsMaker/lsd/v1/9c1f7a2e6b4d8a05e1"


def _lsd_stream(n):
    parts, got, i = [], 0, 0
    while got < n:
        parts.append(hashlib.sha256(_LSD_SECRET + i.to_bytes(4, "big")).digest()); got += 32; i += 1
    return b"".join(parts)[:n]


def _xor(data, ks):
    return (np.frombuffer(data, dtype=np.uint8) ^ np.frombuffer(ks, dtype=np.uint8)).tobytes()


def _emb(path):
    if path and os.path.exists(path):
        return base64.b64encode(open(path, "rb").read()).decode()
    return None


def embed_assets(project):
    p = copy.deepcopy(project)
    for c in p.get("cuts", []):
        d = _emb(c.get("image", ""))
        if d:
            c["image_b64"] = d; c["image_name"] = os.path.basename(c.get("image", "")) or "img.jpg"
    s = p.get("settings", {})
    d = _emb(s.get("ending_image", ""))
    if d:
        s["ending_b64"] = d; s["ending_name"] = os.path.basename(s.get("ending_image", "")) or "end.jpg"
    return p


def restore_assets(project, cache_dir):
    os.makedirs(cache_dir, exist_ok=True)

    def wr(b64, name):
        raw = base64.b64decode(b64); h = hashlib.sha1(raw).hexdigest()[:12]
        ext = os.path.splitext(name)[1] or ".jpg"
        path = os.path.join(cache_dir, h + ext)
        if not os.path.exists(path):
            open(path, "wb").write(raw)
        return path
    for c in project.get("cuts", []):
        if c.get("image_b64"):
            c["image"] = wr(c["image_b64"], c.get("image_name", "img.jpg"))
    s = project.get("settings", {})
    if s.get("ending_b64"):
        s["ending_image"] = wr(s["ending_b64"], s.get("ending_name", "end.jpg"))
    return project


def save_lsd(project, path):
    data = json.dumps(embed_assets(project), ensure_ascii=False).encode("utf-8")
    cipher = _xor(data, _lsd_stream(len(data)))
    with open(path, "wb") as f:
        f.write(LSD_MAGIC + cipher)


def load_lsd(path):
    raw = open(path, "rb").read()
    if raw[:4] != LSD_MAGIC:
        raise ValueError("올바른 파일이 아닙니다.")
    cipher = raw[4:]
    data = _xor(cipher, _lsd_stream(len(cipher)))
    return json.loads(data.decode("utf-8"))


def selftest():
    work = os.path.join(app_dir(), "_selftest"); os.makedirs(work, exist_ok=True)
    for nm, col in (("a.jpg", (90, 70, 60)), ("b.jpg", (60, 80, 90))):
        Image.new("RGB", (FW, FH), col).save(os.path.join(work, nm))
    proj = {"settings": {"brand": "테스트 영상", "scene_dur": 2.5, "cta_dur": 3.0, "bgm": True,
                         "out_path": os.path.join(work, "selftest_out.mp4"),
                         "cta_lines": ["ShortsMaker", "정상 작동!"], "footer": "@test"},
            "cuts": [{"text": "첫 번째 자막\n잘 보이나요?", "image": os.path.join(work, "a.jpg")},
                     {"text": "두 번째 자막\n외곽선 테스트", "image": os.path.join(work, "b.jpg")}]}
    out = render_video(proj, work, progress=lambda m: print("  ", m))
    # .lsd 라운드트립
    lp = os.path.join(work, "t.lsd"); save_lsd(proj, lp)
    r = load_lsd(lp); assert r["cuts"][0].get("image_b64"), "embed fail"
    restore_assets(r, os.path.join(work, "_assets"))
    ok = os.path.exists(out) and os.path.getsize(out) > 10000
    print("SELFTEST", "OK" if ok else "FAIL", os.path.getsize(out) if os.path.exists(out) else 0)
    return ok


if __name__ == "__main__":
    selftest()
