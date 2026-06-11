# -*- coding: utf-8 -*-
"""DB 모델 — 유저 / 프로젝트 / 미디어(이미지·오디오·영상). DATABASE_URL(Postgres) 없으면 SQLite."""
import os
from sqlalchemy import (create_engine, Column, Integer, String, Text, LargeBinary,
                        DateTime, ForeignKey, func)
from sqlalchemy.orm import declarative_base, sessionmaker

BASE = os.path.dirname(os.path.abspath(__file__))
_SQLITE = "sqlite:///" + os.path.join(BASE, "data", "dsm.db")


def _norm(url):
    # 공백·따옴표·줄바꿈 제거 (HF/Render Secret에 섞인 보이지 않는 문자 방지)
    url = (url or "").strip().strip('"').strip("'").strip()
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    return url


DATABASE_URL = _norm(os.environ.get("DATABASE_URL", ""))
if not DATABASE_URL:
    os.makedirs(os.path.join(BASE, "data"), exist_ok=True)
    DATABASE_URL = _SQLITE


def _make_engine(url):
    args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    return create_engine(url, connect_args=args, pool_pre_ping=True)


try:
    engine = _make_engine(DATABASE_URL)
except Exception as e:
    print("⚠ DATABASE_URL 파싱 실패 → SQLite 폴백:", repr(DATABASE_URL[:25]), e)
    os.makedirs(os.path.join(BASE, "data"), exist_ok=True)
    DATABASE_URL = _SQLITE
    engine = _make_engine(_SQLITE)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    sub = Column(String(64), unique=True, index=True)   # google subject
    email = Column(String(256))
    name = Column(String(256))
    enc_key = Column(Text)                                # 암호화된 OpenAI 키
    created = Column(DateTime, server_default=func.now())


class Project(Base):
    __tablename__ = "projects"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True)
    name = Column(String(256), default="제목 없음")
    data = Column(Text)                                  # 프로젝트 JSON
    updated = Column(DateTime, server_default=func.now(), onupdate=func.now())


class Media(Base):
    __tablename__ = "media"
    id = Column(String(48), primary_key=True)            # uuid+ext
    user_id = Column(Integer, ForeignKey("users.id"), index=True)
    kind = Column(String(16))                            # image / audio / video
    mime = Column(String(64))
    blob = Column(LargeBinary)
    created = Column(DateTime, server_default=func.now())


def init_db():
    Base.metadata.create_all(engine)


def get_db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()
