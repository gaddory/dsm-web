// 백엔드 호출 (JWT 토큰 인증). 상대경로 → 어떤 URL에 배포해도 동작.
let TOKEN = localStorage.getItem('dsm_token') || ''
export function setToken(t) { TOKEN = t || ''; if (t) localStorage.setItem('dsm_token', t); else localStorage.removeItem('dsm_token') }
export function getToken() { return TOKEN }
export function mediaUrl(id) { return id ? `/api/media/${id}?token=${encodeURIComponent(TOKEN)}` : '' }

function authHeaders(json) {
  const h = {}
  if (json) h['Content-Type'] = 'application/json'
  if (TOKEN) h['Authorization'] = 'Bearer ' + TOKEN
  return h
}
async function req(method, path, body, isForm) {
  const opt = { method, headers: authHeaders(!isForm && body != null) }
  if (body != null) opt.body = isForm ? body : JSON.stringify(body)
  const r = await fetch(path, opt)
  if (r.status === 401) { setToken(''); throw new Error('로그인이 필요합니다.') }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.detail || ('오류 ' + r.status))
  return data
}

export const api = {
  config: () => fetch('/api/config').then(r => r.json()),
  googleLogin: (credential) => req('POST', '/api/auth/google', { credential }),
  devLogin: () => req('POST', '/api/auth/dev'),
  me: () => req('GET', '/api/me'),
  setKey: (api_key) => req('POST', '/api/key', { api_key }),
  delKey: () => req('DELETE', '/api/key'),
  suggest: (text) => req('POST', '/api/suggest-prompt', { text }),
  genImage: (prompt) => req('POST', '/api/gen-image', { prompt }),
  upload: (file) => { const fd = new FormData(); fd.append('file', file); return req('POST', '/api/upload-image', fd, true) },
  uploadAudio: (file) => { const fd = new FormData(); fd.append('file', file); return req('POST', '/api/upload-audio', fd, true) },
  render: (project) => req('POST', '/api/render', { project }),
  renderStatus: (jobId) => req('GET', '/api/render/' + jobId),
  // 프로젝트
  projects: () => req('GET', '/api/projects'),
  getProject: (id) => req('GET', '/api/projects/' + id),
  createProject: (name, data) => req('POST', '/api/projects', { name, data }),
  updateProject: (id, name, data) => req('PUT', '/api/projects/' + id, { name, data }),
  delProject: (id) => req('DELETE', '/api/projects/' + id),
  // 영상
  videos: () => req('GET', '/api/videos'),
  delVideo: (id) => req('DELETE', '/api/media/' + id),
  // 음악(유저 업로드)
  audios: () => req('GET', '/api/audios'),
  delAudio: (id) => req('DELETE', '/api/media/' + id),
}
