import React, { useState, useEffect, useRef, useCallback } from 'react'
import { api } from './api.js'
import { drawScene, drawTransition } from './canvas.js'
import {
  TRANSITIONS, TRANS_MAP, NAME2LABEL, BGM_OPTS, BGM_MAP, BGM_NAME2LABEL,
  POS_MAP, POS_LABELS, POS_CUT_LABELS, posToLabel, FW, FH, defaultProject, emptyCut,
} from './constants.js'

const LS_KEY = 'dsm_apikey'
const LS_PROJ = 'dsm_project'
const LS_VIDS = 'dsm_videos'

// ───────── 유틸 ─────────
const hex2rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
const rgb2hex = (a) => '#' + a.map(x => x.toString(16).padStart(2, '0')).join('')

function buildScenes(p) {
  const s = p.settings
  const gpos = s.sub_pos ?? 0.62
  const real = p.cuts.filter(c => (c.text && c.text.trim()) || c.image_url)
  const scenes = real.map((c, i) => ({
    imgUrl: c.image_url || '',
    lines: (c.text || '').split('\n').filter(l => l.trim() !== ''),
    center: c.sub_pos ?? gpos,
    header: (i === 0 && s.use_brand && s.brand) ? s.brand : null,
    footer: null, bright: s.brightness,
    font: (s.font_mode === 'each' ? c.font : null) || s.font || null,
    goldLast: true,
  }))
  if (s.use_cta) {
    const cta = (s.cta || '').split(',').map(x => x.trim()).filter(Boolean)
    if (cta.length) scenes.push({
      imgUrl: s.ending_url || '', lines: cta, center: 0.55, header: null, footer: null,
      bright: 1.12, font: s.cta_font || s.font || null, goldLast: true,
    })
  }
  return scenes
}

// 이미지 프리로드 훅
function useImages(urls) {
  const cache = useRef({})
  const [, force] = useState(0)
  useEffect(() => {
    urls.filter(Boolean).forEach(u => {
      if (!cache.current[u]) {
        const img = new Image(); img.crossOrigin = 'anonymous'
        img.onload = () => force(v => v + 1); img.src = u
        cache.current[u] = img
      }
    })
  }, [urls.join('|')])
  return cache.current
}

// ───────── 미리보기 ─────────
function Preview({ scenes, images, settings, makeVideo, rendering }) {
  const canvasRef = useRef(null)
  const offRef = useRef([])
  const stateRef = useRef({ idx: 0, phase: 'hold', start: 0, playing: false })
  const rafRef = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [idx, setIdx] = useState(0)

  const cfg = useRef(settings); cfg.current = settings
  const scn = useRef(scenes); scn.current = scenes

  // 오프스크린 카드 갱신(실시간 반영)
  useEffect(() => {
    offRef.current = scenes.map(sc => {
      const cv = document.createElement('canvas'); cv.width = FW; cv.height = FH
      drawScene(cv, { ...sc, imgEl: sc.imgUrl ? images[sc.imgUrl] : null })
      return cv
    })
    if (stateRef.current.idx >= scenes.length) stateRef.current.idx = 0
    if (!stateRef.current.playing) showStatic(stateRef.current.idx)
  }, [scenes, images])

  const showStatic = (i) => {
    const cv = canvasRef.current, off = offRef.current
    if (!cv || !off.length) return
    const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, FW, FH)
    if (off[i]) ctx.drawImage(off[i], 0, 0)
  }

  const loop = useCallback((now) => {
    const st = stateRef.current, off = offRef.current, sc = scn.current
    const n = off.length
    if (!st.playing || !n) return
    const ctx = canvasRef.current.getContext('2d')
    const trans = cfg.current.transition, tr = cfg.current.trans_dur
    const dur = (sc[st.idx]?.dur || cfg.current.scene_dur) * 1000
    const useTr = trans !== 'none' && tr > 0.05
    if (st.phase === 'hold') {
      if (off[st.idx]) { ctx.clearRect(0, 0, FW, FH); ctx.drawImage(off[st.idx], 0, 0) }
      const hold = dur - (useTr ? tr * 1000 : 0)
      if (now - st.start >= hold) { st.phase = 'trans'; st.start = now }
    } else {
      const nxt = (st.idx + 1) % n
      if (!useTr) { st.idx = nxt; st.phase = 'hold'; st.start = now; setIdx(st.idx) }
      else {
        const t = (now - st.start) / (tr * 1000)
        if (t >= 1) { st.idx = nxt; st.phase = 'hold'; st.start = now; setIdx(st.idx) }
        else drawTransition(ctx, off[st.idx], off[nxt], trans, t)
      }
    }
    rafRef.current = requestAnimationFrame(loop)
  }, [])

  const play = () => {
    const st = stateRef.current
    if (!offRef.current.length) return
    st.playing = true; st.phase = 'hold'; st.start = performance.now()
    setPlaying(true); rafRef.current = requestAnimationFrame(loop)
  }
  const pause = () => { stateRef.current.playing = false; setPlaying(false); cancelAnimationFrame(rafRef.current) }
  const jump = (d) => {
    const st = stateRef.current, n = offRef.current.length
    if (!n) return
    st.idx = (st.idx + d + n) % n; st.phase = 'hold'; st.start = performance.now()
    setIdx(st.idx); showStatic(st.idx)
  }
  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  return (
    <div className="preview">
      <div className="pv-frame">
        <canvas ref={canvasRef} width={FW} height={FH} className="pv-canvas" />
        {!scenes.length && <div className="pv-empty">재생을 누르면<br />여기서 재생돼요</div>}
      </div>
      <div className="pv-ctrls">
        <button className="btn success" onClick={playing ? pause : play}>{playing ? '정지' : '재생'}</button>
        <button className="btn ghost" onClick={() => jump(-1)}>이전</button>
        <button className="btn ghost" onClick={() => jump(1)}>다음</button>
      </div>
      <button className="btn primary big" disabled={rendering} onClick={makeVideo}>
        {rendering ? '만드는 중…' : '영상 만들기'}
      </button>
    </div>
  )
}

// ───────── 컷 ─────────
function CutRow({ idx, total, cut, onChange, onMove, onDel, apiKey, busy, onAiResult, fontMode, onCutFont }) {
  const [loading, setLoading] = useState('')
  const fileRef = useRef(null)
  const up = (patch) => onChange({ ...cut, ...patch })

  const pickFile = async (e) => {
    const f = e.target.files[0]; if (!f) return
    setLoading('이미지 업로드 중…')
    try { const r = await api.upload(f); up({ image: r.id, image_url: r.url }) }
    catch (err) { alert(err.message) } finally { setLoading(''); e.target.value = '' }
  }
  const suggest = async () => {
    if (!apiKey) return alert('먼저 OpenAI API 키를 입력하세요.')
    const text = (cut.text || '').trim(); if (!text) return alert('자막을 먼저 입력하세요.')
    setLoading('프롬프트 추천 중…')
    try { const r = await api.suggest(apiKey, text); up({ prompt: r.prompt }) }
    catch (err) { alert(err.message) } finally { setLoading('') }
  }
  const genAi = async () => {
    if (!apiKey) return alert('먼저 OpenAI API 키를 입력하세요.')
    const pr = (cut.prompt || '').trim(); if (!pr) return alert("프롬프트를 입력하거나 '추천'을 누르세요.")
    busy('AI 이미지 생성 중… (20초 내외)')
    try { const r = await api.genImage(apiKey, pr); onAiResult(idx, r, cut) }
    catch (err) { alert(err.message) } finally { busy(null) }
  }

  return (
    <div className="cut">
      <div className="cut-head">
        <span className="cut-no">● 컷 {idx + 1}</span>
        <span className="lbl">위치</span>
        <select value={cut.sub_pos == null ? '기본(전체)' : posToLabel(cut.sub_pos)}
          onChange={e => up({ sub_pos: e.target.value.startsWith('기본') ? null : POS_MAP[e.target.value] })}>
          {POS_CUT_LABELS.map(l => <option key={l}>{l}</option>)}
        </select>
        <button className="btn xs" onClick={() => onMove(-1)}>↑</button>
        <button className="btn xs" onClick={() => onMove(1)}>↓</button>
        <span className="spacer" />
        <button className="btn ghost sm" disabled={fontMode !== 'each'} onClick={() => onCutFont(idx)}>
          폰트{cut.font ? ' ✓' : ''}
        </button>
        <button className="btn danger-o sm" onClick={onDel}>삭제</button>
      </div>
      <textarea className="cut-text" rows={2} placeholder="자막 (줄바꿈 = 화면 줄바꿈)"
        value={cut.text} onChange={e => up({ text: e.target.value })} />
      <div className="row">
        <span className="lbl">이미지</span>
        <input className="grow" readOnly value={cut.image_url ? cut.image_url.split('/').pop() : ''} placeholder="이미지 없음" />
        <button className="btn ghost sm" onClick={() => fileRef.current.click()}>찾기</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickFile} />
      </div>
      <div className="row">
        <span className="lbl">프롬프트</span>
        <input className="grow" value={cut.prompt} onChange={e => up({ prompt: e.target.value })} placeholder="영어 프롬프트(추천 가능)" />
        <button className="btn info-o sm" onClick={suggest}>추천</button>
        <button className="btn warn sm" onClick={genAi}>AI이미지 생성</button>
      </div>
      {(loading || cut.image_url) && <div className="cut-foot">{loading || '✓ 이미지 적용됨'}</div>}
    </div>
  )
}

// ───────── 모달들 ─────────
function Modal({ title, children, onClose, wide }) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className={'modal' + (wide ? ' wide' : '')} onMouseDown={e => e.stopPropagation()}>
        {title && <div className="modal-title">{title}</div>}
        {children}
      </div>
    </div>
  )
}

function FontDialog({ init, onApply, onClose }) {
  const [size, setSize] = useState(init?.size || 58)
  const [color, setColor] = useState(rgb2hex(init?.color || [244, 234, 219]))
  return (
    <Modal title="폰트 설정" onClose={onClose}>
      <div className="form">
        <label>크기 <input type="number" min={20} max={120} value={size} onChange={e => setSize(+e.target.value)} /></label>
        <label>색상 <input type="color" value={color} onChange={e => setColor(e.target.value)} /></label>
      </div>
      <div className="modal-btns">
        <button className="btn success" onClick={() => onApply({ size, color: hex2rgb(color) })}>적용</button>
        <button className="btn ghost" onClick={() => onApply(null)}>기본값</button>
        <button className="btn ghost" onClick={onClose}>닫기</button>
      </div>
    </Modal>
  )
}

function TransitionHelp({ current, onClose }) {
  const [sel, setSel] = useState(current || 'fade')
  const cvRef = useRef(null); const rafRef = useRef(0)
  useEffect(() => {
    const mk = (label, bg) => { const c = document.createElement('canvas'); c.width = FW; c.height = FH; const x = c.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, FW, FH); x.fillStyle = '#fff'; x.font = '700 520px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(label, FW / 2, FH / 2); return c }
    const A = mk('A', '#2b3550'), B = mk('B', '#3a2b40')
    let t = 0
    const tick = () => {
      const ctx = cvRef.current?.getContext('2d'); if (!ctx) return
      drawTransition(ctx, A, B, sel, t); t += 0.02; if (t > 1.4) t = 0
      rafRef.current = requestAnimationFrame(tick)
    }
    tick(); return () => cancelAnimationFrame(rafRef.current)
  }, [sel])
  return (
    <Modal title="씬 전환 미리보기" onClose={onClose} wide>
      <div className="thelp">
        <div className="thelp-list">
          {TRANSITIONS.map(([l, v]) =>
            <div key={v} className={'thelp-item' + (v === sel ? ' on' : '')} onClick={() => setSel(v)}>{l}</div>)}
        </div>
        <div className="thelp-prev">
          <canvas ref={cvRef} width={FW} height={FH} className="pv-canvas" />
          <div className="thelp-name">{NAME2LABEL[sel]}</div>
        </div>
      </div>
      <div className="modal-btns"><button className="btn ghost" onClick={onClose}>닫기</button></div>
    </Modal>
  )
}

function AiResult({ data, cut, onChoose, onOther, onClose }) {
  const [text, setText] = useState(cut.text || '')
  return (
    <Modal title="AI 이미지 생성 결과" onClose={onClose}>
      <img className="ai-img" src={data.image_b64 || data.url} alt="ai" />
      <div className="form"><label>자막 (수정 가능)
        <textarea rows={2} value={text} onChange={e => setText(e.target.value)} /></label></div>
      <div className="modal-btns">
        <button className="btn success" onClick={() => onChoose(text)}>선택</button>
        <button className="btn warn" onClick={onOther}>다른 이미지</button>
        <button className="btn ghost" onClick={onClose}>닫기</button>
      </div>
    </Modal>
  )
}

// ───────── 메인 ─────────
export default function App() {
  const [project, setProject] = useState(() => {
    try { const j = localStorage.getItem(LS_PROJ); if (j) return JSON.parse(j) } catch { }
    return defaultProject()
  })
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(LS_KEY) || '')
  const [keyStatus, setKeyStatus] = useState('')
  const [revealKey, setRevealKey] = useState(false)
  const [busyMsg, setBusyMsg] = useState(null)
  const [fontDlg, setFontDlg] = useState(null)   // {target:'global'|'cta'|cutIdx, init}
  const [transHelp, setTransHelp] = useState(false)
  const [aiResult, setAiResult] = useState(null) // {idx, data, cut}
  const [render, setRender] = useState(null)     // {progress} | null
  const [videos, setVideos] = useState(() => { try { return JSON.parse(localStorage.getItem(LS_VIDS) || '[]') } catch { return [] } })
  const [tab, setTab] = useState('edit')
  const audioRef = useRef(null)

  const s = project.settings
  const setS = (patch) => setProject(p => ({ ...p, settings: { ...p.settings, ...patch } }))
  const setCut = (i, c) => setProject(p => ({ ...p, cuts: p.cuts.map((x, j) => j === i ? c : x) }))

  // 자동저장
  useEffect(() => { localStorage.setItem(LS_PROJ, JSON.stringify(project)) }, [project])
  useEffect(() => { localStorage.setItem(LS_VIDS, JSON.stringify(videos)) }, [videos])

  const scenes = buildScenes(project)
  const urls = [...project.cuts.map(c => c.image_url), s.ending_url].filter(Boolean)
  const images = useImages(urls)
  const sceneEls = scenes.map(sc => ({ ...sc, dur: sc.center === 0.55 ? (s.cta_dur || 4.6) : s.scene_dur }))

  // ── API 키 ──
  const inputKey = async () => {
    const k = (prompt('OpenAI API 키 (sk-...)', apiKey) || '').replace(/\s+/g, '')
    if (!k) return
    setApiKey(k); localStorage.setItem(LS_KEY, k); setKeyStatus('checking')
    try { const r = await api.validateKey(k); setKeyStatus(r.valid ? 'valid' : 'invalid') }
    catch { setKeyStatus('invalid') }
  }
  const resetKey = () => { setApiKey(''); localStorage.removeItem(LS_KEY); setKeyStatus(''); setRevealKey(false) }
  const maskKey = (k) => k ? (revealKey ? k : k.slice(0, 6) + '•'.repeat(Math.max(4, k.length - 10)) + k.slice(-4)) : '키 없음'

  // ── 컷 조작 ──
  const addCut = () => setProject(p => ({ ...p, cuts: [...p.cuts, emptyCut()] }))
  const delCut = (i) => setProject(p => ({ ...p, cuts: p.cuts.length > 1 ? p.cuts.filter((_, j) => j !== i) : p.cuts }))
  const moveCut = (i, d) => setProject(p => {
    const j = i + d; if (j < 0 || j >= p.cuts.length) return p
    const cuts = [...p.cuts];[cuts[i], cuts[j]] = [cuts[j], cuts[i]]; return { ...p, cuts }
  })

  // ── 폰트 ──
  const openFont = (target) => {
    const init = target === 'global' ? s.font : target === 'cta' ? s.cta_font : project.cuts[target]?.font
    setFontDlg({ target, init })
  }
  const applyFont = (f) => {
    const t = fontDlg.target
    if (t === 'global') setS({ font: f }); else if (t === 'cta') setS({ cta_font: f })
    else setCut(t, { ...project.cuts[t], font: f })
    setFontDlg(null)
  }

  // ── 이미지 업로드(엔딩/오디오) ──
  const endRef = useRef(null)
  const pickEnding = async (e) => {
    const f = e.target.files[0]; if (!f) return
    try { const r = await api.upload(f); setS({ ending_image: r.id, ending_url: r.url }) }
    catch (err) { alert(err.message) } finally { e.target.value = '' }
  }
  const pickAudio = async (e) => {
    const f = e.target.files[0]; if (!f) return
    setBusyMsg('음악 업로드 중…')
    try { const r = await api.uploadAudio(f); setS({ bgm_file: r.id, bgm_name: f.name }) }
    catch (err) { alert(err.message) } finally { setBusyMsg(null); e.target.value = '' }
  }

  // ── AI 결과 ──
  const onAiResult = (idx, data, cut) => setAiResult({ idx, data, cut })
  const chooseAi = (text) => {
    const { idx, data } = aiResult
    setCut(idx, { ...project.cuts[idx], image: data.id, image_url: data.url, text })
    setAiResult(null)
  }
  const otherAi = async () => {
    const { idx, cut } = aiResult; setAiResult(null); setBusyMsg('AI 이미지 생성 중…')
    try { const r = await api.genImage(apiKey, cut.prompt); setAiResult({ idx, data: r, cut }) }
    catch (err) { alert(err.message) } finally { setBusyMsg(null) }
  }

  // ── 저장/열기 ──
  const saveProject = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = 'dsm_project.json'; a.click()
  }
  const openProject = (e) => {
    const f = e.target.files[0]; if (!f) return
    const r = new FileReader(); r.onload = () => { try { setProject(JSON.parse(r.result)) } catch { alert('잘못된 파일입니다.') } }
    r.readAsText(f); e.target.value = ''
  }

  // ── 렌더 ──
  const makeVideo = async () => {
    const proj = {
      settings: {
        ...s,
        cta_lines: s.use_cta ? (s.cta || '').split(',').map(x => x.trim()).filter(Boolean) : [],
        brand: s.use_brand ? (s.brand || '') : '',
        ending_image: s.ending_image || '',
      },
      cuts: project.cuts.map(c => ({ text: c.text, image: c.image || '', font: c.font, sub_pos: c.sub_pos })),
    }
    setRender({ progress: '시작' })
    try {
      const { job_id } = await api.render(proj)
      let done = false
      while (!done) {
        await new Promise(r => setTimeout(r, 1200))
        const st = await api.renderStatus(job_id)
        setRender({ progress: st.progress })
        if (st.status === 'done') {
          done = true; const v = { url: st.file, at: new Date().toLocaleString('ko-KR') }
          setVideos(vs => [v, ...vs]); setRender(null)
          window.open(st.file, '_blank')
        } else if (st.status === 'error') { done = true; setRender(null); alert('렌더 오류: ' + st.error) }
      }
    } catch (err) { setRender(null); alert(err.message) }
  }

  const transLabel = NAME2LABEL[s.transition] || TRANSITIONS[0][0]
  const bgmLabel = BGM_NAME2LABEL[s.bgm_mode] || BGM_OPTS[1][0]

  return (
    <div className="app">
      <header className="head">
        <span className="logo">DSM</span>
        <span className="logo-sub">DoryShortsMaker</span>
        <span className="tagline">사진 + 자막 → 숏츠 한 방에</span>
      </header>

      <div className="tabs">
        <button className={tab === 'edit' ? 'tab on' : 'tab'} onClick={() => setTab('edit')}>편집</button>
        <button className={tab === 'vids' ? 'tab on' : 'tab'} onClick={() => setTab('vids')}>내 영상</button>
      </div>

      {tab === 'vids' ? (
        <div className="vids">
          {!videos.length && <p className="muted">아직 만든 영상이 없어요.</p>}
          {videos.map((v, i) =>
            <div key={i} className="vid">
              <video src={v.url} controls width="180" />
              <div className="vid-meta"><div>{v.at}</div>
                <a className="btn ghost sm" href={v.url} download>다운로드</a>
                <button className="btn danger-o sm" onClick={() => setVideos(vs => vs.filter((_, j) => j !== i))}>삭제</button>
              </div>
            </div>)}
        </div>
      ) : (
        <div className="editor">
          <div className="settings">
            {/* 기본 설정 */}
            <fieldset className="box">
              <legend>기본 설정</legend>
              <div className="row">
                <span className="lbl wide">OpenAI API 키</span>
                <input className="grow mono" readOnly value={maskKey(apiKey)} />
                <button className="btn info sm" onClick={inputKey}>입력</button>
                <button className="btn ghost sm" onClick={() => setRevealKey(r => !r)}>{revealKey ? '가리기' : '전체 보기'}</button>
                <button className="btn danger-o sm" onClick={resetKey}>초기화</button>
                <span className={'keyst ' + keyStatus}>
                  {keyStatus === 'valid' ? '✅ 인증됨' : keyStatus === 'invalid' ? '❌ 올바르지 않은 키' : keyStatus === 'checking' ? '확인 중…' : ''}
                </span>
                <a className="link" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">API 키가 없나요?</a>
              </div>
              <div className="row">
                <label className="toggle"><input type="checkbox" checked={s.use_brand} onChange={e => setS({ use_brand: e.target.checked })} /> 상단 브랜드</label>
                <input className="grow" disabled={!s.use_brand} value={s.brand} onChange={e => setS({ brand: e.target.value })} />
              </div>
              <div className="row">
                <span className="lbl wide">컷당 길이(초)</span>
                <input type="number" step="0.1" min="1" value={s.scene_dur} onChange={e => setS({ scene_dur: +e.target.value })} />
              </div>
              <div className="row">
                <span className="lbl wide">엔딩 이미지(선택)</span>
                <input className="grow" readOnly value={s.ending_url ? s.ending_url.split('/').pop() : ''} placeholder="없음" />
                <button className="btn ghost sm" onClick={() => endRef.current.click()}>찾기</button>
                <input ref={endRef} type="file" accept="image/*" hidden onChange={pickEnding} />
              </div>
              <div className="row">
                <label className="toggle"><input type="checkbox" checked={s.use_cta} onChange={e => setS({ use_cta: e.target.checked })} /> 엔딩 문구(쉼표=줄)</label>
                <input className="grow" disabled={!s.use_cta} value={s.cta} onChange={e => setS({ cta: e.target.value })} />
                <button className="btn ghost sm" disabled={!s.use_cta} onClick={() => openFont('cta')}>폰트{s.cta_font ? ' ✓' : ''}</button>
              </div>
            </fieldset>

            {/* 화면·전환·음악 */}
            <fieldset className="box">
              <legend>화면 · 전환 · 음악</legend>
              <div className="row">
                <span className="lbl">폰트</span>
                <label className="radio"><input type="radio" checked={s.font_mode === 'global'} onChange={() => setS({ font_mode: 'global' })} /> 전체</label>
                <label className="radio"><input type="radio" checked={s.font_mode === 'each'} onChange={() => setS({ font_mode: 'each' })} /> 각각</label>
                <button className="btn ghost sm" disabled={s.font_mode !== 'global'} onClick={() => openFont('global')}>폰트 설정{s.font ? ' ✓' : ''}</button>
              </div>
              <div className="row">
                <span className="lbl">자막 위치</span>
                <select value={posToLabel(s.sub_pos)} onChange={e => setS({ sub_pos: POS_MAP[e.target.value] })}>
                  {POS_LABELS.map(l => <option key={l}>{l}</option>)}
                </select>
              </div>
              <div className="row">
                <span className="lbl">밝기</span>
                <input type="range" min="1" max="1.8" step="0.01" value={s.brightness} onChange={e => setS({ brightness: +e.target.value })} />
                <span className="muted">{s.brightness.toFixed(2)}</span>
              </div>
              <div className="row">
                <span className="lbl">씬 전환</span>
                <select value={transLabel} onChange={e => setS({ transition: TRANS_MAP[e.target.value] })}>
                  {TRANSITIONS.map(([l]) => <option key={l}>{l}</option>)}
                </select>
                <button className="btn ghost sm" onClick={() => setTransHelp(true)}>?</button>
              </div>
              <div className="row">
                <span className="lbl">전환 길이</span>
                <input type="number" step="0.05" min="0" value={s.trans_dur} onChange={e => setS({ trans_dur: +e.target.value })} /><span className="muted">초</span>
              </div>
              <div className="row">
                <span className="lbl">배경음악</span>
                <select value={bgmLabel} onChange={e => setS({ bgm_mode: BGM_MAP[e.target.value] })}>
                  {BGM_OPTS.map(([l]) => <option key={l}>{l}</option>)}
                </select>
                {s.bgm_mode === 'file' && <>
                  <button className="btn ghost sm" onClick={() => audioRef.current.click()}>파일</button>
                  <input ref={audioRef} type="file" accept="audio/*" hidden onChange={pickAudio} />
                  <span className="muted">{s.bgm_name || ''}</span>
                </>}
              </div>
            </fieldset>
          </div>

          <div className="work">
            <div className="cutlist">
              <div className="cutbar">
                <button className="btn success sm" onClick={addCut}>＋ 컷 추가</button>
                <button className="btn ghost sm" onClick={saveProject}>저장</button>
                <label className="btn ghost sm">열기<input type="file" accept=".json" hidden onChange={openProject} /></label>
              </div>
              <div className="cuts-scroll">
                {project.cuts.map((c, i) =>
                  <CutRow key={i} idx={i} total={project.cuts.length} cut={c}
                    onChange={(nc) => setCut(i, nc)} onMove={(d) => moveCut(i, d)} onDel={() => delCut(i)}
                    apiKey={apiKey} busy={setBusyMsg} onAiResult={onAiResult}
                    fontMode={s.font_mode} onCutFont={openFont} />)}
              </div>
            </div>
            <Preview scenes={sceneEls} images={images} settings={s} makeVideo={makeVideo} rendering={!!render} />
          </div>
        </div>
      )}

      <footer className="foot">
        도리도리 · 대표 이상덕 · 010-5718-8624 · 대전 유성구 신성동 141-6 302 · twosd87@naver.com
      </footer>

      {busyMsg && <div className="overlay"><div className="busy"><div className="spinner" /><div>{busyMsg}</div></div></div>}
      {render && <div className="overlay"><div className="busy"><div className="spinner" /><div>{render.progress}</div></div></div>}
      {fontDlg && <FontDialog init={fontDlg.init} onApply={applyFont} onClose={() => setFontDlg(null)} />}
      {transHelp && <TransitionHelp current={s.transition} onClose={() => setTransHelp(false)} />}
      {aiResult && <AiResult data={aiResult.data} cut={aiResult.cut} onChoose={chooseAi} onOther={otherAi} onClose={() => setAiResult(null)} />}
    </div>
  )
}
