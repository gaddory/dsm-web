# -*- coding: utf-8 -*-
"""DB 모델 — 유저 / 프로젝트 / 미디어(이미지·오디오·영상). DATABASE_URL(Postgres) 없으면 SQLite."""
import os
from sqlalchemy import (create_engine, Column, Integer, String, Text, LargeBinary,
                        DateTime, ForeignKey, Boolean, func)
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
    watermark = Column(Boolean, default=True)             # 영상 워터마크 표시 여부(관리자 제어)
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
    name = Column(String(256))                           # 원본 파일명(오디오 등 표시용)
    blob = Column(LargeBinary)
    created = Column(DateTime, server_default=func.now())


class Setting(Base):
    __tablename__ = "settings"
    key = Column(String(64), primary_key=True)
    value = Column(Text)


def init_db():
    Base.metadata.create_all(engine)
    # 기존 테이블 컬럼 추가(베스트에포트)
    try:
        with engine.begin() as conn:
            if DATABASE_URL.startswith("sqlite"):
                mcols = [r[1] for r in conn.exec_driver_sql("PRAGMA table_info(media)").fetchall()]
                if "name" not in mcols:
                    conn.exec_driver_sql("ALTER TABLE media ADD COLUMN name VARCHAR(256)")
                ucols = [r[1] for r in conn.exec_driver_sql("PRAGMA table_info(users)").fetchall()]
                if "watermark" not in ucols:
                    conn.exec_driver_sql("ALTER TABLE users ADD COLUMN watermark INTEGER DEFAULT 1")
            else:
                conn.exec_driver_sql("ALTER TABLE media ADD COLUMN IF NOT EXISTS name VARCHAR(256)")
                conn.exec_driver_sql("ALTER TABLE users ADD COLUMN IF NOT EXISTS watermark BOOLEAN DEFAULT TRUE")
    except Exception as e:
        print("⚠ 컬럼 마이그레이션 스킵:", e)


def get_db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()
