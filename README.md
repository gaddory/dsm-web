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

## TODO (다음 단계)
- [ ] 프로젝트 저장/불러오기(DB) · 로그인 · 키 서버측 암호화 보관
- [ ] 렌더 큐/동시성 제한 · 작업물 영구 저장(현재 서버 재시작 시 media/renders 휘발)
- [ ] 폰트 패밀리 다중 지원(현재 크기·색상 + 단일 패밀리)
