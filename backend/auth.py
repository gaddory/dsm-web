# -*- coding: utf-8 -*-
"""인증 — 구글 ID토큰 검증 → 우리 JWT 발급, OpenAI 키 암호화 저장."""
import os, time, base64, hashlib
import jwt
from fastapi import Header, Query, HTTPException
from google.oauth2 import id_token as g_id_token
from google.auth.transport import requests as g_requests
from cryptography.fernet import Fernet

JWT_SECRET = os.environ.get("JWT_SECRET", "dev-jwt-secret-change-me-please-0123456789abcdef")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
_kp = os.environ.get("KEY_SECRET", "dev-key-secret-change-me-please-0123456789abcdef")
_fernet = Fernet(base64.urlsafe_b64encode(hashlib.sha256(_kp.encode()).digest()))


def enc(s):
    return _fernet.encrypt(s.encode()).decode() if s else None


def dec(s):
    try:
        return _fernet.decrypt(s.encode()).decode() if s else None
    except Exception:
        return None


def verify_google(credential):
    """구글 ID 토큰 검증 → {sub,email,name}."""
    info = g_id_token.verify_oauth2_token(credential, g_requests.Request(),
                                          GOOGLE_CLIENT_ID or None)
    return info


def make_jwt(uid):
    return jwt.encode({"uid": uid, "exp": int(time.time()) + 60 * 60 * 24 * 30},
                      JWT_SECRET, algorithm="HS256")


def _parse(raw):
    try:
        return jwt.decode(raw, JWT_SECRET, algorithms=["HS256"]).get("uid")
    except Exception:
        return None


def current_uid(authorization: str = Header(None), token: str = Query(None)):
    """Authorization: Bearer <jwt>  또는  ?token=<jwt> (이미지 태그용)."""
    raw = None
    if authorization and authorization.startswith("Bearer "):
        raw = authorization.split(" ", 1)[1]
    elif token:
        raw = token
    uid = _parse(raw) if raw else None
    if not uid:
        raise HTTPException(401, "로그인이 필요합니다.")
    return uid
