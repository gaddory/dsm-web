# DSM Web (DoryShortsMaker 웹 버전)

데스크톱 DSM(`D:\lsdproject\ShortsMaker`)을 **건드리지 않고** 별도로 새로 만드는 웹앱.
렌더링 엔진(`engine.py`)은 데스크톱판을 그대로 재활용한다.

- **프론트**: React (PWA) — Canvas 실시간 미리보기  *(예정: `frontend/`)*
- **백엔드**: Python FastAPI — AI생성·프롬프트추천·영상 렌더(ffmpeg)  *(`backend/`)*
- **배포**: Render (Docker, ffmpeg + 나눔폰트 포함)

## 백엔드 로컬 실행
```bash
cd backend
python -m venv .venv && .venv\Scripts\activate      # (Windows)
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```
- 헬스체크: http://localhost:8000/api/health
- 자동 문서(Swagger): http://localhost:8000/docs

## API (v0.1)
| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | ffmpeg·폰트 경로 확인 |
| POST | `/api/validate-key` | `{api_key}` → `{valid}` |
| POST | `/api/suggest-prompt` | `{api_key,text}` → `{prompt}` |
| POST | `/api/gen-image` | `{api_key,prompt}` → `{id,url,image_b64}` |
| POST | `/api/upload-image` | (multipart file) → `{id,url}` |
| POST | `/api/render` | `{project}` → `{job_id}` (비동기) |
| GET | `/api/render/{job_id}` | 진행상태/완료 mp4 url |

### project 형식 (데스크톱 .dory의 settings/cuts와 동일)
```json
{
  "settings": { "brightness":1.34, "scene_dur":3.8, "transition":"fade",
                "trans_dur":0.45, "sub_pos":0.62, "brand":"", "use_brand":true,
                "cta_lines":["..."], "ending_image":"<media id>", "font":null },
  "cuts": [ { "text":"자막\\n둘째줄", "image":"<media id>", "sub_pos":null, "font":null } ]
}
```
- `image`/`ending_image` 값은 `/api/upload-image`·`/api/gen-image`가 돌려준 **id**.

## 프론트 로컬 실행
```bash
cd frontend
npm install
npm run dev          # http://localhost:5173 (API는 8011로 프록시 → 백엔드도 같이 켜둘 것)
```
배포/통합 실행은 프론트를 빌드(`npm run build`)하면 백엔드가 `frontend/dist`를 `/`로 서빙 → **단일 URL**.

## 배포 (Render) — 단일 URL
루트 `Dockerfile`(멀티스테이지: 프론트 빌드 → 백엔드+ffmpeg+나눔폰트)와 `render.yaml` 포함.
1. 이 repo를 GitHub에 push
2. Render → New → Blueprint(또는 Web Service) → repo 선택 → `render.yaml`/`Dockerfile` 자동 인식
3. 배포되면 한 URL에서 화면+API 모두 동작 (예: `https://dory-dcm.onrender.com`)
   - ※ 도메인엔 `_`(언더스코어) 못 써서 `dory-dcm`처럼 하이픈으로.
- ffmpeg·나눔폰트는 이미지에 포함. 폰트 교체는 `DSM_FONT_R/B` 환경변수.

## 멀티유저 (v0.2)
- **구글 로그인** + 유저별 **프로젝트/이미지/영상 저장**(DB) + 유저별 **OpenAI 키**(서버 암호화 보관)
- 미디어는 DB에 저장, `/api/media/{id}?token=` 으로 본인만 접근.
- `GOOGLE_CLIENT_ID` 미설정 시 **게스트 모드**(체험용 공용 계정)로 동작.

### 환경변수
| 변수 | 설명 |
|---|---|
| `GOOGLE_CLIENT_ID` | 구글 OAuth 클라이언트 ID(웹). 없으면 게스트 모드 |
| `JWT_SECRET` | 세션 서명 키(랜덤 고정) |
| `KEY_SECRET` | OpenAI 키 암호화 키(랜덤 고정 — 바뀌면 저장된 키 재입력 필요) |
| `DATABASE_URL` | Postgres 권장(Neon/Supabase/Render). 없으면 SQLite(컨테이너 재시작 시 휘발) |

### 구글 로그인 설정
1. Google Cloud Console → API/사용자 인증 정보 → **OAuth 클라이언트 ID(웹)** 생성
2. **승인된 자바스크립트 원본**에 배포 주소 추가 (예: `https://dory-dcm.onrender.com`)
3. 발급된 클라이언트 ID를 Render의 `GOOGLE_CLIENT_ID` 에 설정 → 재배포

### 영구 저장(중요)
무료/기본은 컨테이너 디스크가 휘발 → **`DATABASE_URL`(Postgres)** 를 꼭 설정해야 유저 데이터가 유지됨.
(이미지·영상도 DB에 저장되므로 용량 큰 서비스는 추후 S3/R2로 분리 권장.)

## TODO (다음 단계)
- [ ] 렌더 큐/동시성 제한 · 대용량 미디어 S3/R2 분리
- [ ] 폰트 패밀리 다중 지원(현재 크기·색상 + 단일 패밀리)
