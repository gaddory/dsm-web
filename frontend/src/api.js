// 백엔드 호출 헬퍼 (상대경로 → 어떤 URL에 배포해도 동작)
async function jpost(path, body) {
  const r = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.detail || ('오류 ' + r.status))
  return data
}

export const api = {
  health: () => fetch('/api/health').then(r => r.json()),
  validateKey: (api_key) => jpost('/api/validate-key', { api_key }),
  suggest: (api_key, text) => jpost('/api/suggest-prompt', { api_key, text }),
  genImage: (api_key, prompt) => jpost('/api/gen-image', { api_key, prompt }),
  async upload(file) {
    const fd = new FormData(); fd.append('file', file)
    const r = await fetch('/api/upload-image', { method: 'POST', body: fd })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.detail || '업로드 실패')
    return data // {id, url}
  },
  async uploadAudio(file) {
    const fd = new FormData(); fd.append('file', file)
    const r = await fetch('/api/upload-audio', { method: 'POST', body: fd })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.detail || '업로드 실패')
    return data // {id, url}
  },
  render: (project) => jpost('/api/render', { project }),
  renderStatus: (jobId) => fetch('/api/render/' + jobId).then(r => r.json()),
}
