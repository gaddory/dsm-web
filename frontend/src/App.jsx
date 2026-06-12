import React, { useState, useEffect, useRef, useCallback } from 'react'
import { api, setToken, getToken, mediaUrl } from './api.js'
import { drawScene, drawTransition } from './canvas.js'
import {
  TRANSITIONS, TRANS_MAP, NAME2LABEL, BGM_OPTS, BGM_MAP, BGM_NAME2LABEL,
  POS_MAP, POS_LABELS, POS_CUT_LABELS, posToLabel, FW, FH, defaultProject, emptyCut,
} from './constants.js'

const LS_DRAFT = 'dsm_draft'
const hex2rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
const rgb2hex = (a) => '#' + a.map(x => x.toString(16).padStart(2, '0')).join('')

// 서버 저장용(토큰 url 제거) / 불러올 때 url 복원
function serialize(p) {
  const cuts = p.cuts.map(({ image_url, ...c }) => c)
  const { ending_url, ...settings } = p.settings
  return { settings, cuts }
}
function hydrate(p) {
  const base = defaultProject()
  const settings = { ...base.settings, ...(p.settings || {}) }
  settings.ending_url = settings.ending_image ? mediaUrl(settings.ending_image) : ''
  const cuts = (p.cuts && p.cuts.length ? p.cuts : base.cuts).map(c => ({
    ...emptyCut(), ...c, image_url: c.image ? mediaUrl(c.image) : '',
  }))
  return { settings, cuts }
}

function buildScenes(p) {
  const s = p.settings, gpos = s.sub_pos ?? 0.62
  const real = p.cuts.filter(c => (c.text && c.text.trim()) || c.image_url)
  const scenes = real.map((c, i) => ({
    imgUrl: c.image_url || '',
    lines: (c.text || '').split('\n').filter(l => l.trim() !== ''),
    center: c.sub_pos ?? gpos,
    header: (i === 0 && s.use_brand && s.brand) ? s.brand : null,
    footer: null, bright: s.brightness,
    font: (s.font_mode === 'each' ? c.font : null) || s.font || null, goldLast: true,
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

function useImages(urls) {
  const cache = useRef({}); const [, force] = useState(0)
  useEffect(() => {
    urls.filter(Boolean).forEach(u => {
      if (!cache.current[u]) {
        const img = new Image(); img.onload = () => force(v => v + 1); img.src = u; cache.current[u] = img
      }
    })
  }, [urls.join('|')])
  return cache.current
}

// ───────── 로그인 ─────────
function Login({ onUser }) {
  const btnRef = useRef(null); const [noGoogle, setNoGoogle] = useState(false)
  useEffect(() => {
    api.config().then(cfg => {
      const cid = cfg.google_client_id
      if (!cid) { setNoGoogle(true); return }
      const init = () => {
        window.google.accounts.id.initialize({
          client_id: cid, callback: async (resp) => {
            try { const r = await api.googleLogin(resp.credential); setToken(r.token); onUser(r.user) }
            catch (e) { alert(e.message) }
          },
        })
        window.google.accounts.id.renderButton(btnRef.current, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with' })
      }
      if (window.google?.accounts?.id) init()
      else { const sc = document.createElement('script'); sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true; sc.onload = init; document.body.appendChild(sc) }
    })
  }, [])
  const guest = async () => { try { const r = await api.devLogin(); setToken(r.token); onUser(r.user) } catch (e) { alert(e.message) } }
  useEffect(() => { if (window.location.hash === '#guest') guest() }, [])
  return (
    <div className="login">
      <div className="login-card">
        <div className="login-logo">DSM <span>DoryShortsMaker</span></div>
        <p className="muted">사진 + 자막 → 숏츠 한 방에</p>
        <div ref={btnRef} style={{ marginTop: 18 }} />
        {noGoogle && <button className="btn primary big" onClick={guest}>게스트로 시작 (로컬/체험)</button>}
        {noGoogle && <p className="muted" style={{ marginTop: 10 }}>구글 로그인은 GOOGLE_CLIENT_ID 설정 시 활성화돼요.</p>}
      </div>
    </div>
  )
}

// ───────── 미리보기 ─────────
function Preview({ scenes, images, settings, makeVideo, rendering, showMake = true, focus = null }) {
  const canvasRef = useRef(null); const offRef = useRef([])
  const stateRef = useRef({ idx: 0, phase: 'hold', start: 0, playing: false })
  const rafRef = useRef(0); const [playing, setPlaying] = useState(false); const [, setIdx] = useState(0)
  const cfg = useRef(settings); cfg.current = settings
  const scn = useRef(scenes); scn.current = scenes

  useEffect(() => {
    offRef.current = scenes.map(sc => {
      const cv = document.createElement('canvas'); cv.width = FW; cv.height = FH
      drawScene(cv, { ...sc, imgEl: sc.imgUrl ? images[sc.imgUrl] : null }); return cv
    })
    if (!stateRef.current.playing) {
      const i = (focus != null ? focus : stateRef.current.idx)
      stateRef.current.idx = Math.max(0, Math.min(i, scenes.length - 1))
      showStatic(stateRef.current.idx)
    }
  }, [scenes, images, focus])

  const showStatic = (i) => {
    const cv = canvasRef.current, off = offRef.current; if (!cv || !off.length) return
    const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, FW, FH); if (off[i]) ctx.drawImage(off[i], 0, 0)
  }
  const loop = useCallback((now) => {
    const st = stateRef.current, off = offRef.current, sc = scn.current, n = off.length
    if (!st.playing || !n) return
    const ctx = canvasRef.current.getContext('2d'), trans = cfg.current.transition, tr = cfg.current.trans_dur
    const dur = (sc[st.idx]?.dur || cfg.current.scene_dur) * 1000, useTr = trans !== 'none' && tr > 0.05
    if (st.phase === 'hold') {
      if (off[st.idx]) { ctx.clearRect(0, 0, FW, FH); ctx.drawImage(off[st.idx], 0, 0) }
      if (now - st.start >= dur - (useTr ? tr * 1000 : 0)) { st.phase = 'trans'; st.start = now }
    } else {
      const nxt = (st.idx + 1) % n
      if (!useTr) { st.idx = nxt; st.phase = 'hold'; st.start = now; setIdx(st.idx) }
      else { const t = (now - st.start) / (tr * 1000); if (t >= 1) { st.idx = nxt; st.phase = 'hold'; st.start = now; setIdx(st.idx) } else drawTransition(ctx, off[st.idx], off[nxt], trans, t) }
    }
    rafRef.current = requestAnimationFrame(loop)
  }, [])
  const play = () => { const st = stateRef.current; if (!offRef.current.length) return; st.playing = true; st.phase = 'hold'; st.start = performance.now(); setPlaying(true); rafRef.current = requestAnimationFrame(loop) }
  const pause = () => { stateRef.current.playing = false; setPlaying(false); cancelAnimationFrame(rafRef.current) }
  const jump = (d) => { const st = stateRef.current, n = offRef.current.length; if (!n) return; st.idx = (st.idx + d + n) % n; st.phase = 'hold'; st.start = performance.now(); setIdx(st.idx); showStatic(st.idx) }
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
      {showMake && <button className="btn primary big" disabled={rendering} onClick={makeVideo}>{rendering ? '만드는 중…' : '영상 만들기'}</button>}
    </div>
  )
}

// ───────── 컷 ─────────
function CutRow({ idx, cut, onChange, onMove, onDel, hasKey, busy, onAiResult, fontMode, onCutFont }) {
  const [loading, setLoading] = useState(''); const fileRef = useRef(null)
  const up = (patch) => onChange({ ...cut, ...patch })
  const pickFile = async (e) => {
    const f = e.target.files[0]; if (!f) return; setLoading('이미지 업로드 중…')
    try { const r = await api.upload(f); up({ image: r.id, image_url: mediaUrl(r.id) }) }
    catch (err) { alert(err.message) } finally { setLoading(''); e.target.value = '' }
  }
  const suggest = async () => {
    if (!hasKey) return alert('먼저 OpenAI API 키를 등록하세요.')
    const text = (cut.text || '').trim(); if (!text) return alert('자막을 먼저 입력하세요.')
    setLoading('프롬프트 추천 중…')
    try { const r = await api.suggest(text); up({ prompt: r.prompt }) } catch (err) { alert(err.message) } finally { setLoading('') }
  }
  const genAi = async () => {
    if (!hasKey) return alert('먼저 OpenAI API 키를 등록하세요.')
    const pr = (cut.prompt || '').trim(); if (!pr) return alert("프롬프트를 입력하거나 '추천'을 누르세요.")
    busy('AI 이미지 생성 중… (20초 내외)')
    try { const r = await api.genImage(pr); onAiResult(idx, r, cut) } catch (err) { alert(err.message) } finally { busy(null) }
  }
  return (
    <div className="cut">
      <div className="cut-head">
        <span className="cut-no">● 컷 {idx + 1}</span><span className="lbl">위치</span>
        <select value={cut.sub_pos == null ? '기본(전체)' : posToLabel(cut.sub_pos)}
          onChange={e => up({ sub_pos: e.target.value.startsWith('기본') ? null : POS_MAP[e.target.value] })}>
          {POS_CUT_LABELS.map(l => <option key={l}>{l}</option>)}
        </select>
        <button className="btn xs" onClick={() => onMove(-1)}>↑</button>
        <button className="btn xs" onClick={() => onMove(1)}>↓</button><span className="spacer" />
        <button className="btn ghost sm" disabled={fontMode !== 'each'} onClick={() => onCutFont(idx)}>폰트{cut.font ? ' ✓' : ''}</button>
        <button className="btn danger-o sm" onClick={onDel}>삭제</button>
      </div>
      <textarea className="cut-text" rows={2} placeholder="자막 (줄바꿈 = 화면 줄바꿈)" value={cut.text} onChange={e => up({ text: e.target.value })} />
      <div className="row">
        <span className="lbl">이미지</span>
        <input className="grow" readOnly value={cut.image ? '이미지 적용됨' : ''} placeholder="이미지 없음" />
        <button className="btn ghost sm" onClick={() => fileRef.current.click()}>찾기</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickFile} />
      </div>
      <div className="row">
        <span className="lbl">프롬프트</span>
        <input className="grow" value={cut.prompt} onChange={e => up({ prompt: e.target.value })} placeholder="영어 프롬프트(추천 가능)" />
        <button className="btn info-o sm" onClick={suggest}>추천</button>
        <button className="btn warn sm" onClick={genAi}>AI이미지 생성</button>
      </div>
      {loading && <div className="cut-foot">{loading}</div>}
    </div>
  )
}

function Modal({ title, children, onClose, wide }) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className={'modal' + (wide ? ' wide' : '')} onMouseDown={e => e.stopPropagation()}>
        {title && <div className="modal-title">{title}</div>}{children}
      </div>
    </div>
  )
}
function FontDialog({ init, onApply, onClose }) {
  const [size, setSize] = useState(init?.size || 58); const [color, setColor] = useState(rgb2hex(init?.color || [244, 234, 219]))
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
  const [sel, setSel] = useState(current || 'fade'); const cvRef = useRef(null); const rafRef = useRef(0)
  useEffect(() => {
    const mk = (t, bg) => { const c = document.createElement('canvas'); c.width = FW; c.height = FH; const x = c.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, FW, FH); x.fillStyle = '#fff'; x.font = '700 520px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(t, FW / 2, FH / 2); return c }
    const A = mk('A', '#2b3550'), B = mk('B', '#3a2b40'); let t = 0
    const tick = () => { const ctx = cvRef.current?.getContext('2d'); if (!ctx) return; drawTransition(ctx, A, B, sel, t); t += 0.02; if (t > 1.4) t = 0; rafRef.current = requestAnimationFrame(tick) }
    tick(); return () => cancelAnimationFrame(rafRef.current)
  }, [sel])
  return (
    <Modal title="씬 전환 미리보기" onClose={onClose} wide>
      <div className="thelp">
        <div className="thelp-list">{TRANSITIONS.map(([l, v]) => <div key={v} className={'thelp-item' + (v === sel ? ' on' : '')} onClick={() => setSel(v)}>{l}</div>)}</div>
        <div className="thelp-prev"><canvas ref={cvRef} width={FW} height={FH} className="pv-canvas" /><div className="thelp-name">{NAME2LABEL[sel]}</div></div>
      </div>
      <div className="modal-btns"><button className="btn ghost" onClick={onClose}>닫기</button></div>
    </Modal>
  )
}
function AiResult({ images, sel, setSel, cut, loading, onChoose, onOther, onClose }) {
  const [text, setText] = useState(cut.text || '')
  const cur = images[sel] || images[0]
  return (
    <Modal title="AI 이미지 생성 결과" onClose={onClose}>
      <div className="ai-img-wrap">
        <img className="ai-img" src={cur.image_b64} alt="ai" />
        {loading && <div className="ai-loading"><div className="spinner" /><div>새 이미지 생성 중…</div></div>}
      </div>
      <div className="form"><label>자막 (수정 가능)<textarea rows={2} value={text} onChange={e => setText(e.target.value)} /></label></div>
      <div className="modal-btns">
        <button className="btn success" disabled={loading} onClick={() => onChoose(text)}>이 이미지로 선택</button>
        <button className="btn warn" disabled={loading} onClick={onOther}>{loading ? '생성 중…' : '다른 이미지 생성'}</button>
        <button className="btn ghost" disabled={loading} onClick={onClose}>닫기</button>
      </div>
      {images.length > 1 && (
        <div className="ai-hist-wrap">
          <div className="ai-hist-label">지금까지 만든 이미지 {images.length}장 · 클릭하면 크게 보고 선택돼요</div>
          <div className="ai-hist">
            {images.map((im, i) =>
              <img key={i} src={im.image_b64} className={'ai-thumb' + (i === sel ? ' on' : '')}
                onClick={() => setSel(i)} alt={'후보 ' + (i + 1)} />)}
          </div>
        </div>
      )}
    </Modal>
  )
}

function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 700px)')
    const fn = e => setM(e.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])
  return m
}

// 모달이 열리면 히스토리에 한 칸 쌓고, 뒤로가기 → 앱을 벗어나지 않고 모달만 닫음
function useBackClose(open, close) {
  useEffect(() => {
    if (!open) return
    window.history.pushState({ dsmModal: true }, '')
    const onPop = () => close()
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      if (window.history.state && window.history.state.dsmModal) window.history.back()
    }
  }, [open])
}

function Collapse({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={'msec' + (open ? ' open' : '')}>
      <button className="msec-head" onClick={() => setOpen(o => !o)}>
        <span>{title}</span><span className="msec-arrow">▾</span>
      </button>
      {open && <div className="msec-body">{children}</div>}
    </div>
  )
}

function SceneList({ cuts, sel, onSelect, onAdd, onMove, strip }) {
  return (
    <div className={'scenes' + (strip ? ' strip' : '')}>
      {!strip && <div className="scenes-head">장면 {cuts.length}개</div>}
      <div className="scenes-list">
        {cuts.map((c, i) => {
          const line = (c.text || '').split('\n')[0].trim()
          return (
            <div key={i} className={'scene-card' + (i === sel ? ' on' : '')} onClick={() => onSelect(i)} role="button">
              <div className="scene-thumb">
                {c.image_url ? <img src={c.image_url} alt="" /> : <span>{i + 1}</span>}
                {strip && <span className="scene-badge">{i + 1}</span>}
              </div>
              {!strip && <div className="scene-info">
                <div className="scene-num">장면 {i + 1}</div>
                <div className="scene-line">{line || '(자막 없음)'}</div>
              </div>}
              {!strip && <div className="scene-ops">
                <span className="iconbtn" onClick={e => { e.stopPropagation(); onMove(i, -1) }}>↑</span>
                <span className="iconbtn" onClick={e => { e.stopPropagation(); onMove(i, 1) }}>↓</span>
              </div>}
            </div>
          )
        })}
        <div className="scene-add" onClick={onAdd} role="button">＋ 장면</div>
      </div>
    </div>
  )
}

// ───────── 메인 ─────────
export default function App() {
  const [user, setUser] = useState(null)
  const [booting, setBooting] = useState(true)
  const [project, setProject] = useState(() => { try { const j = localStorage.getItem(LS_DRAFT); if (j) return JSON.parse(j) } catch { } return defaultProject() })
  const [pid, setPid] = useState(null)
  const [pname, setPname] = useState('제목 없음')
  const [projList, setProjList] = useState([])
  const [busyMsg, setBusyMsg] = useState(null)
  const [fontDlg, setFontDlg] = useState(null)
  const [transHelp, setTransHelp] = useState(false)
  const [aiResult, setAiResult] = useState(null)
  const [render, setRender] = useState(null)
  const [videos, setVideos] = useState([])
  const [tab, setTab] = useState('edit')
  const [pvOpen, setPvOpen] = useState(false)
  const [sel, setSel] = useState(0)
  const [propTab, setPropTab] = useState('scene')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exitConfirm, setExitConfirm] = useState(false)
  const isMobile = useIsMobile()
  const endRef = useRef(null), audioRef = useRef(null), saveTimer = useRef(0)
  const exitRef = useRef({}); exitRef.current = { fontDlg: !!fontDlg, transHelp, aiResult: !!aiResult, settingsOpen, tab }
  const leavingRef = useRef(false)
  useEffect(() => {
    if (!user) return
    window.history.pushState({ g: 1 }, '')
    const onPop = () => {
      if (leavingRef.current) return
      window.history.pushState({ g: 1 }, '')            // 뒤로가기 트랩 재장전
      const m = exitRef.current
      if (m.fontDlg) setFontDlg(null)
      else if (m.transHelp) setTransHelp(false)
      else if (m.aiResult) setAiResult(null)
      else if (m.settingsOpen) setSettingsOpen(false)
      else if (m.tab === 'vids') setTab('edit')          // 내영상 → 메인(편집)
      else setExitConfirm(true)                           // 메인 → 종료 확인
    }
    const onBefore = (e) => { if (leavingRef.current) return; e.preventDefault(); e.returnValue = '' }
    window.addEventListener('popstate', onPop)
    window.addEventListener('beforeunload', onBefore)
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('beforeunload', onBefore) }
  }, [!!user])

  const s = project.settings
  const setS = (patch) => setProject(p => ({ ...p, settings: { ...p.settings, ...patch } }))
  const setCut = (i, c) => setProject(p => ({ ...p, cuts: p.cuts.map((x, j) => j === i ? c : x) }))

  // 부팅: 토큰 있으면 me
  useEffect(() => {
    (async () => {
      if (getToken()) { try { const u = await api.me(); setUser(u); await loadProjects() } catch { } }
      setBooting(false)
    })()
  }, [])

  // 드래프트 자동저장(브라우저) + 서버 자동저장(저장된 프로젝트면)
  useEffect(() => {
    localStorage.setItem(LS_DRAFT, JSON.stringify(project))
    if (user && pid) {
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => { api.updateProject(pid, pname, serialize(project)).catch(() => { }) }, 1200)
    }
  }, [project, pname])

  const loadProjects = async () => { try { setProjList(await api.projects()) } catch { } }
  const loadVideos = async () => { try { setVideos(await api.videos()) } catch { } }

  const scenes = buildScenes(project)
  const urls = [...project.cuts.map(c => c.image_url), s.ending_url].filter(Boolean)
  const images = useImages(urls)
  const sceneEls = scenes.map(sc => ({ ...sc, dur: sc.center === 0.55 ? (s.cta_dur || 4.6) : s.scene_dur }))

  // 키
  const inputKey = async () => {
    const k = (prompt('OpenAI API 키 (sk-...)') || '').replace(/\s+/g, ''); if (!k) return
    setBusyMsg('키 확인 중…')
    try { const r = await api.setKey(k); setUser(u => ({ ...u, has_key: r.valid })); alert(r.valid ? '인증됨 — 키가 저장됐어요.' : '올바르지 않은 키입니다.') }
    catch (e) { alert(e.message) } finally { setBusyMsg(null) }
  }
  const resetKey = async () => { try { await api.delKey(); setUser(u => ({ ...u, has_key: false })) } catch (e) { alert(e.message) } }

  // 컷(장면)
  useEffect(() => { if (sel >= project.cuts.length) setSel(Math.max(0, project.cuts.length - 1)) }, [project.cuts.length])
  const addCut = () => { setSel(project.cuts.length); setProject(p => ({ ...p, cuts: [...p.cuts, emptyCut()] })) }
  const delCut = (i) => setProject(p => ({ ...p, cuts: p.cuts.length > 1 ? p.cuts.filter((_, j) => j !== i) : p.cuts }))
  const moveCut = (i, d) => {
    const j = i + d
    if (j < 0 || j >= project.cuts.length) return
    setProject(p => { const cuts = [...p.cuts];[cuts[i], cuts[j]] = [cuts[j], cuts[i]]; return { ...p, cuts } })
    setSel(sv => (sv === i ? j : sv === j ? i : sv))
  }

  // 폰트
  const openFont = (target) => setFontDlg({ target, init: target === 'global' ? s.font : target === 'cta' ? s.cta_font : project.cuts[target]?.font })
  const applyFont = (f) => { const t = fontDlg.target; if (t === 'global') setS({ font: f }); else if (t === 'cta') setS({ cta_font: f }); else setCut(t, { ...project.cuts[t], font: f }); setFontDlg(null) }

  // 엔딩/오디오
  const pickEnding = async (e) => { const f = e.target.files[0]; if (!f) return; try { const r = await api.upload(f); setS({ ending_image: r.id, ending_url: mediaUrl(r.id) }) } catch (err) { alert(err.message) } finally { e.target.value = '' } }
  const pickAudio = async (e) => { const f = e.target.files[0]; if (!f) return; setBusyMsg('음악 업로드 중…'); try { const r = await api.uploadAudio(f); setS({ bgm_file: r.id, bgm_name: f.name }) } catch (err) { alert(err.message) } finally { setBusyMsg(null); e.target.value = '' } }

  // AI 결과 (생성 이미지 히스토리 누적 → 썸네일에서 골라 선택)
  const onAiResult = (idx, data, cut) => setAiResult({ idx, cut, images: [data], sel: 0 })
  const setAiSel = (i) => setAiResult(a => ({ ...a, sel: i }))
  const chooseAi = (text) => {
    const { idx, images, sel } = aiResult; const data = images[sel]
    setCut(idx, { ...project.cuts[idx], image: data.id, image_url: mediaUrl(data.id), text })
    setAiResult(null)
  }
  const otherAi = async () => {
    setAiResult(a => ({ ...a, loading: true }))
    try {
      const r = await api.genImage(aiResult.cut.prompt)
      setAiResult(a => ({ ...a, images: [...a.images, r], sel: a.images.length, loading: false }))
    } catch (err) { alert(err.message); setAiResult(a => a && { ...a, loading: false }) }
  }

  // 프로젝트
  const newProject = () => { if (!confirm('새 프로젝트를 시작할까요? (저장 안 한 변경은 사라져요)')) return; setProject(defaultProject()); setPid(null); setPname('제목 없음') }
  const saveProject = async () => {
    try {
      if (pid) { await api.updateProject(pid, pname, serialize(project)) }
      else { const r = await api.createProject(pname, serialize(project)); setPid(r.id) }
      await loadProjects(); setBusyMsg('저장됨'); setTimeout(() => setBusyMsg(null), 600)
    } catch (e) { alert(e.message) }
  }
  const openProject = async (id) => { if (!id) return; try { const r = await api.getProject(+id); setProject(hydrate(r.data)); setPid(r.id); setPname(r.name) } catch (e) { alert(e.message) } }
  const deleteProject = async () => { if (!pid || !confirm('이 프로젝트를 삭제할까요?')) return; try { await api.delProject(pid); setPid(null); setPname('제목 없음'); setProject(defaultProject()); await loadProjects() } catch (e) { alert(e.message) } }

  // 렌더
  const makeVideo = async () => {
    const proj = {
      settings: { ...serialize(project).settings, cta_lines: s.use_cta ? (s.cta || '').split(',').map(x => x.trim()).filter(Boolean) : [], brand: s.use_brand ? (s.brand || '') : '' },
      cuts: project.cuts.map(c => ({ text: c.text, image: c.image || '', font: c.font, sub_pos: c.sub_pos })),
    }
    setRender({ progress: '시작' })
    try {
      const { job_id } = await api.render(proj)
      while (true) {
        await new Promise(r => setTimeout(r, 1200))
        const st = await api.renderStatus(job_id)
        setRender({ progress: st.progress })
        if (st.status === 'done') { setRender(null); await loadVideos(); setTab('vids'); window.open(mediaUrl(st.media), '_blank'); break }
        if (st.status === 'error') { setRender(null); alert('렌더 오류: ' + st.error); break }
      }
    } catch (err) { setRender(null); alert(err.message) }
  }

  const logout = () => { setToken(''); setUser(null); setPid(null) }
  const leave = () => {
    setExitConfirm(false); leavingRef.current = true
    window.history.go(-2)
    // 못 빠져나갔으면(이전 사이트 없음) 가드 복구 — 트랩이 영구히 깨지지 않게
    setTimeout(() => { leavingRef.current = false; window.history.pushState({ g: 1 }, '') }, 700)
  }

  if (booting) return <div className="login"><div className="login-card"><div className="spinner" /></div></div>
  if (!user) return <Login onUser={(u) => { setUser(u); loadProjects() }} />

  const transLabel = NAME2LABEL[s.transition] || TRANSITIONS[0][0]
  const bgmLabel = BGM_NAME2LABEL[s.bgm_mode] || BGM_OPTS[1][0]

  const projBar = (
    <div className="projbar">
      <span className="lbl">프로젝트</span>
      <input className="grow" value={pname} onChange={e => setPname(e.target.value)} placeholder="프로젝트 이름" />
      <button className="btn success sm" onClick={saveProject}>저장</button>
      <button className="btn ghost sm" onClick={newProject}>새로</button>
      <select value={pid || ''} onChange={e => openProject(e.target.value)}>
        <option value="">내 프로젝트…</option>
        {projList.map(p => <option key={p.id} value={p.id}>{p.name} ({p.updated})</option>)}
      </select>
      <button className="btn danger-o sm" disabled={!pid} onClick={deleteProject}>삭제</button>
    </div>
  )
  const basicSettings = (<>
    <div className="row">
      <span className="lbl wide">OpenAI API 키</span>
      <span className={'keyst ' + (user.has_key ? 'valid' : '')}>{user.has_key ? '✅ 등록됨 (인증 완료)' : '미등록'}</span>
      <button className="btn info sm" onClick={inputKey}>{user.has_key ? '변경' : '입력'}</button>
      {user.has_key && <button className="btn danger-o sm" onClick={resetKey}>삭제</button>}
      <a className="link" href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">API 키가 없나요?</a>
    </div>
    <div className="row">
      <label className="toggle"><input type="checkbox" checked={s.use_brand} onChange={e => setS({ use_brand: e.target.checked })} /> 상단 브랜드</label>
      <input className="grow" disabled={!s.use_brand} value={s.brand} onChange={e => setS({ brand: e.target.value })} />
    </div>
    <div className="row"><span className="lbl wide">컷당 길이(초)</span><input type="number" step="0.1" min="1" value={s.scene_dur} onChange={e => setS({ scene_dur: +e.target.value })} /></div>
    <div className="row">
      <span className="lbl wide">엔딩 이미지(선택)</span>
      <input className="grow" readOnly value={s.ending_image ? '이미지 적용됨' : ''} placeholder="없음" />
      <button className="btn ghost sm" onClick={() => endRef.current.click()}>찾기</button>
      <input ref={endRef} type="file" accept="image/*" hidden onChange={pickEnding} />
    </div>
    <div className="row">
      <label className="toggle"><input type="checkbox" checked={s.use_cta} onChange={e => setS({ use_cta: e.target.checked })} /> 엔딩 문구(쉼표=줄)</label>
      <input className="grow" disabled={!s.use_cta} value={s.cta} onChange={e => setS({ cta: e.target.value })} />
      <button className="btn ghost sm" disabled={!s.use_cta} onClick={() => openFont('cta')}>폰트{s.cta_font ? ' ✓' : ''}</button>
    </div>
  </>)
  const screenSettings = (<>
    <div className="row">
      <span className="lbl">폰트</span>
      <label className="radio"><input type="radio" checked={s.font_mode === 'global'} onChange={() => setS({ font_mode: 'global' })} /> 전체</label>
      <label className="radio"><input type="radio" checked={s.font_mode === 'each'} onChange={() => setS({ font_mode: 'each' })} /> 각각</label>
      <button className="btn ghost sm" disabled={s.font_mode !== 'global'} onClick={() => openFont('global')}>폰트 설정{s.font ? ' ✓' : ''}</button>
    </div>
    <div className="row"><span className="lbl">자막 위치</span>
      <select value={posToLabel(s.sub_pos)} onChange={e => setS({ sub_pos: POS_MAP[e.target.value] })}>{POS_LABELS.map(l => <option key={l}>{l}</option>)}</select>
    </div>
    <div className="row"><span className="lbl">밝기</span>
      <input type="range" min="1" max="1.8" step="0.01" value={s.brightness} onChange={e => setS({ brightness: +e.target.value })} /><span className="muted">{s.brightness.toFixed(2)}</span>
    </div>
    <div className="row"><span className="lbl">씬 전환</span>
      <select value={transLabel} onChange={e => setS({ transition: TRANS_MAP[e.target.value] })}>{TRANSITIONS.map(([l]) => <option key={l}>{l}</option>)}</select>
      <button className="btn ghost sm" onClick={() => setTransHelp(true)}>?</button>
    </div>
    <div className="row"><span className="lbl">전환 길이</span><input type="number" step="0.05" min="0" value={s.trans_dur} onChange={e => setS({ trans_dur: +e.target.value })} /><span className="muted">초</span></div>
    <div className="row"><span className="lbl">배경음악</span>
      <select value={bgmLabel} onChange={e => setS({ bgm_mode: BGM_MAP[e.target.value] })}>{BGM_OPTS.map(([l]) => <option key={l}>{l}</option>)}</select>
      {s.bgm_mode === 'file' && <><button className="btn ghost sm" onClick={() => audioRef.current.click()}>파일</button><input ref={audioRef} type="file" accept="audio/*" hidden onChange={pickAudio} /><span className="muted">{s.bgm_name || ''}</span></>}
    </div>
  </>)
  const cutListBlock = (
    <div className="cutlist">
      <div className="m-title">✎ 컷 목록 · 장면 편집</div>
      <div className="cutbar"><button className="btn success sm" onClick={addCut}>＋ 컷 추가</button></div>
      <div className="cuts-scroll">
        {project.cuts.map((c, i) =>
          <CutRow key={i} idx={i} cut={c} onChange={(nc) => setCut(i, nc)} onMove={(d) => moveCut(i, d)} onDel={() => delCut(i)}
            hasKey={user.has_key} busy={setBusyMsg} onAiResult={onAiResult} fontMode={s.font_mode} onCutFont={openFont} />)}
      </div>
    </div>
  )

  return (
    <div className="app studio">
      <header className="topbar">
        <span className="logo">DSM</span><span className="logo-sub">Studio</span>
        <input className="proj-name" value={pname} onChange={e => setPname(e.target.value)} placeholder="제목 없음" />
        <select className="proj-pick" value={pid || ''} onChange={e => openProject(e.target.value)}>
          <option value="">내 프로젝트…</option>
          {projList.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="btn ghost sm" onClick={saveProject}>저장</button>
        <button className="btn ghost sm" onClick={newProject}>새로</button>
        <span className="spacer" />
        <button className={'btn sm ' + (tab === 'vids' ? 'info' : 'ghost')} onClick={() => { if (tab === 'vids') setTab('edit'); else { setTab('vids'); loadVideos() } }}>내 영상</button>
        <span className="muted acct">{user.name || user.email}</span>
        <button className="btn ghost sm" onClick={logout}>로그아웃</button>
        {tab !== 'vids' && <button className="btn primary" disabled={!!render} onClick={makeVideo}>{render ? '만드는 중…' : '영상 만들기'}</button>}
      </header>

      {tab === 'vids' ? (
        <div className="vids">
          {!videos.length && <p className="muted">아직 만든 영상이 없어요.</p>}
          {videos.map(v =>
            <div key={v.id} className="vid">
              <video src={mediaUrl(v.id)} controls width="180" />
              <div className="vid-meta"><div>{v.created}</div>
                <a className="btn ghost sm" href={mediaUrl(v.id)} download>다운로드</a>
                <button className="btn danger-o sm" onClick={async () => { await api.delVideo(v.id); loadVideos() }}>삭제</button>
              </div>
            </div>)}
        </div>
      ) : isMobile ? (
        <div className="studio-mobile">
          <div className="m-canvas">
            <Preview scenes={sceneEls} images={images} settings={s} focus={sel} rendering={!!render} showMake={false} />
          </div>
          <SceneList cuts={project.cuts} sel={sel} onSelect={setSel} onAdd={addCut} onMove={moveCut} strip />
          <div className="m-edit">
            {project.cuts[sel] && <CutRow idx={sel} cut={project.cuts[sel]} onChange={nc => setCut(sel, nc)} onMove={d => moveCut(sel, d)} onDel={() => delCut(sel)} hasKey={user.has_key} busy={setBusyMsg} onAiResult={onAiResult} fontMode={s.font_mode} onCutFont={openFont} />}
          </div>
          <div className="mbar">
            <button className="btn ghost" onClick={() => setSettingsOpen(true)}>전체 설정</button>
            <button className="btn primary" disabled={!!render} onClick={makeVideo}>{render ? '만드는 중…' : '영상 만들기'}</button>
          </div>
          {settingsOpen && <Modal title="전체 설정" onClose={() => setSettingsOpen(false)}>
            <div className="gset">{basicSettings}{screenSettings}</div>
          </Modal>}
        </div>
      ) : (
        <div className="studio-body">
          <aside className="panel scenes-panel">
            <SceneList cuts={project.cuts} sel={sel} onSelect={setSel} onAdd={addCut} onMove={moveCut} />
          </aside>
          <main className="panel canvas-panel">
            <Preview scenes={sceneEls} images={images} settings={s} focus={sel} rendering={!!render} showMake={false} />
          </main>
          <aside className="panel props-panel">
            <div className="prop-tabs">
              <button className={'pt' + (propTab === 'scene' ? ' on' : '')} onClick={() => setPropTab('scene')}>이 장면</button>
              <button className={'pt' + (propTab === 'global' ? ' on' : '')} onClick={() => setPropTab('global')}>전체 설정</button>
            </div>
            <div className="prop-body">
              {propTab === 'scene'
                ? (project.cuts[sel]
                  ? <CutRow idx={sel} cut={project.cuts[sel]} onChange={nc => setCut(sel, nc)} onMove={d => moveCut(sel, d)} onDel={() => delCut(sel)} hasKey={user.has_key} busy={setBusyMsg} onAiResult={onAiResult} fontMode={s.font_mode} onCutFont={openFont} />
                  : <p className="muted">장면을 선택하세요</p>)
                : <div className="gset">{basicSettings}{screenSettings}</div>}
            </div>
          </aside>
        </div>
      )}

      <footer className="foot">도리도리 · 대표 이상덕 · 010-5718-8624 · 대전 유성구 신성동 141-6 302 · twosd87@naver.com</footer>

      {busyMsg && <div className="overlay"><div className="busy"><div className="spinner" /><div>{busyMsg}</div></div></div>}
      {render && <div className="overlay"><div className="busy"><div className="spinner" /><div>{render.progress}</div></div></div>}
      {fontDlg && <FontDialog init={fontDlg.init} onApply={applyFont} onClose={() => setFontDlg(null)} />}
      {transHelp && <TransitionHelp current={s.transition} onClose={() => setTransHelp(false)} />}
      {aiResult && <AiResult images={aiResult.images} sel={aiResult.sel} setSel={setAiSel} loading={aiResult.loading} cut={aiResult.cut} onChoose={chooseAi} onOther={otherAi} onClose={() => setAiResult(null)} />}
      {exitConfirm && <Modal title="작업을 종료하시겠습니까?" onClose={() => setExitConfirm(false)}>
        <p className="muted" style={{ margin: '2px 0 8px' }}>지금까지 작업은 저장됩니다.</p>
        <div className="modal-btns">
          <button className="btn primary" onClick={() => setExitConfirm(false)}>아니오</button>
          <button className="btn danger-o" onClick={leave}>네</button>
        </div>
      </Modal>}
    </div>
  )
}
