# -*- coding: utf-8 -*-
"""DB 모델 — 유저 / 프로젝트 / 미디어(이미지·오디오·영상). DATABASE_URL(Postgres) 없으면 SQLite."""
import os
from sqlalchemy import (create_engine, Column, Integer, String, Text, LargeBinary,
                        DateTime, ForeignKey, func)
from sqlalchemy.orm import declarative_base, sessionmaker

BASE = os.path.dirname(os.path.abspath(__file__))
DATABASE_URL = os.environ.get("DATABASE_URL", "")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)
if not DATABASE_URL:
    os.makedirs(os.path.join(BASE, "data"), exist_ok=True)
    DATABASE_URL = "sqlite:///" + os.path.join(BASE, "data", "dsm.db")

_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, connect_args=_args, pool_pre_ping=True)
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
