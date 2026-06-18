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
function Preview({ scenes, images, settings, makeVideo, rendering, showMake = true, focus = null, active = true, bgmUrl = null, watermark = false, onInquiry = null }) {
  const canvasRef = useRef(null); const offRef = useRef([])
  const stateRef = useRef({ idx: 0, phase: 'hold', start: 0, playing: false })
  const rafRef = useRef(0); const [playing, setPlaying] = useState(false); const [, setIdx] = useState(0)
  const autoRef = useRef(false)
  const musicRef = useRef(null); const [withMusic, setWithMusic] = useState(false)
  const cfg = useRef(settings); cfg.current = settings
  const scn = useRef(scenes); scn.current = scenes

  useEffect(() => {
    offRef.current = scenes.map(sc => {
      const cv = document.createElement('canvas'); cv.width = FW; cv.height = FH
      drawScene(cv, { ...sc, imgEl: sc.imgUrl ? images[sc.imgUrl] : null, watermark }); return cv
    })
    if (!stateRef.current.playing) {
      const i = (focus != null ? focus : stateRef.current.idx)
      stateRef.current.idx = Math.max(0, Math.min(i, scenes.length - 1))
      showStatic(stateRef.current.idx)
    }
  }, [scenes, images, focus, watermark])

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
  // 기본값: 콘텐츠 준비되면 자동 재생(1회)
  useEffect(() => {
    if (autoRef.current || !offRef.current.length) return
    autoRef.current = true
    const t = setTimeout(() => { if (!stateRef.current.playing) play() }, 200)
    return () => clearTimeout(t)
  }, [scenes])
  // 모달이 위에 뜨면 미리보기 애니메이션 정지(뒤 화면 깜빡임 방지) → 닫히면 재개
  useEffect(() => {
    if (active === false) cancelAnimationFrame(rafRef.current)
    else if (stateRef.current.playing) { stateRef.current.start = performance.now(); rafRef.current = requestAnimationFrame(loop) }
  }, [active])
  // 배경음악 바뀌면 오디오 리셋
  useEffect(() => { if (musicRef.current) { musicRef.current.pause(); musicRef.current = null } }, [bgmUrl])
  // 배경음악 같이 듣기 (재생+체크+활성+곡 있을 때만)
  useEffect(() => {
    if (withMusic && playing && active !== false && bgmUrl) {
      if (!musicRef.current) { const a = new Audio(bgmUrl); a.loop = true; musicRef.current = a }
      musicRef.current.play().catch(() => { })
    } else if (musicRef.current) { musicRef.current.pause() }
  }, [withMusic, playing, active, bgmUrl])
  useEffect(() => () => { if (musicRef.current) musicRef.current.pause() }, [])

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
      <label className={'pv-music' + (bgmUrl ? '' : ' off')}>
        <input type="checkbox" checked={withMusic} disabled={!bgmUrl} onChange={e => setWithMusic(e.target.checked)} />
        배경음악 같이 듣기
      </label>
      {watermark && onInquiry && <button className="wm-inquiry" onClick={onInquiry}>워터마크 제거(AI사용포함) 및 사용문의</button>}
      {showMake && <button className="btn primary big" disabled={rendering} onClick={makeVideo}>{rendering ? '만드는 중…' : '영상 만들기'}</button>}
    </div>
  )
}

// ───────── 컷 ─────────
function CutRow({ idx, cut, onChange, onMove, onDel, hasKey, busy, onAiResult, fontMode, onCutFont, onImage, onHelp, watermark = false, onInquiry = null }) {
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
        <input className={'grow' + (cut.image_url ? ' clickable' : '')} readOnly
          value={cut.image_url ? '이미지 적용됨 (클릭해서 보기)' : ''} placeholder="이미지 없음"
          onClick={() => cut.image_url && onImage && onImage(cut.image_url)} />
        <button className="btn ghost sm" onClick={() => fileRef.current.click()}>찾기</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickFile} />
      </div>
      <div className="prompt-block">
        <div className="prompt-top"><span className="lbl">프롬프트</span><button className="qmark" onClick={onHelp} title="작성법">?</button></div>
        <textarea className="prompt-ta" rows={3} value={cut.prompt} onChange={e => up({ prompt: e.target.value })} placeholder={'AI 프롬프트를 작성하세요\n(이미지가 없을경우 AI생성)\n* 추천을 클릭하면 자막에 맞는 이미지를 생성합니다.'} />
        <div className="prompt-actions">
          <span className="lock-wrap" title={watermark ? '워터마크 해제하면 쓸 수 있어요' : undefined}>
            <button className="btn info-o sm" disabled={watermark} onClick={suggest}>추천</button></span>
          <span className="lock-wrap" title={watermark ? '워터마크 해제하면 쓸 수 있어요' : undefined}>
            <button className="btn warn sm" disabled={watermark} onClick={genAi}>AI이미지 생성</button></span>
          {watermark && onInquiry && <button className="wm-inquiry" onClick={onInquiry}>워터마크 제거(AI사용포함) 및 사용문의</button>}
        </div>
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

function Contact({ email, onClose }) {
  const [subject, setSubject] = useState('워터마크 제거 문의')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(false)
  const send = async () => {
    if (!body.trim()) return alert('내용을 입력해주세요.')
    setSending(true)
    try {
      const r = await fetch('https://formsubmit.co/ajax/twosd87@naver.com', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ _subject: '[DSM 문의] ' + subject, _template: 'table', 사용자ID: email, 제목: subject, 내용: body })
      })
      if (!r.ok) throw new Error()
      setDone(true)
    } catch (e) { alert('전송에 실패했어요. 잠시 후 다시 시도해주세요.') }
    finally { setSending(false) }
  }
  return (
    <Modal title="DSM · 사용 문의" onClose={onClose} wide>
      {done ? (
        <div className="contact-done">
          <div className="cd-mark">접수 완료</div>
          <div className="cd-title">문의가 정상적으로 접수됐어요</div>
          <div className="muted">내용을 확인하고 빠르게 답변드릴게요.</div>
          <button className="btn primary" onClick={onClose}>닫기</button>
        </div>
      ) : (
        <div className="contact">
          <div className="contact-id">
            <div className="ci-row"><span className="ci-label">사용자 ID</span><span className="ci-val">{email || '게스트'}</span></div>
            <div className="ci-note">기본 설정값 · 수정 불가</div>
          </div>
          <label className="contact-field"><span>제목</span>
            <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="제목을 입력하세요" /></label>
          <label className="contact-field"><span>내용</span>
            <textarea rows={6} value={body} onChange={e => setBody(e.target.value)} placeholder="문의 내용을 자세히 적어주세요. (워터마크 제거, 요금, 기능 등)" /></label>
          <div className="modal-btns">
            <button className="btn primary" disabled={sending} onClick={send}>{sending ? '보내는 중…' : '문의 보내기'}</button>
            <button className="btn ghost" disabled={sending} onClick={onClose}>닫기</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Guide({ onClose }) {
  const steps = [
    { title: '환영해요', desc: 'DSM은 자막과 이미지로 세로 숏츠 영상을 만드는 도구예요. 차근차근 알려드릴게요.' },
    { title: '장면에 자막 쓰기', desc: '왼쪽에서 장면을 고르고, 오른쪽 [이 장면]에서 자막을 입력해요. ＋장면으로 추가하고 ↑↓로 순서를 바꿔요.' },
    { title: '이미지 넣기', desc: '[찾기]로 내 사진을 넣거나, 프롬프트를 적고 [AI이미지 생성]으로 만들 수 있어요. 프롬프트 옆 ? 를 누르면 작성법이 나와요.' },
    { title: '미리보기', desc: '가운데 화면에서 바로 재생돼요. “배경음악 같이 듣기”를 켜면 음악까지 들으면서 확인할 수 있어요.' },
    { title: '전체 설정', desc: '폰트, 자막 위치, 화면 전환, 배경음악, 엔딩 문구까지 [전체 설정]에서 한 번에 조절해요.' },
    { title: '영상 만들기', desc: '오른쪽 위 [영상 만들기]를 누르면 완성! 잠시 뒤 [내 영상]에서 다운로드하고 관리할 수 있어요.' },
    { title: '저장은 자동', desc: '작업은 자동 저장돼요. 프로젝트 이름을 짓고 [저장]을 누르면 계정에 보관돼요. 이제 시작해볼까요?' },
  ]
  const [i, setI] = useState(0)
  const last = i === steps.length - 1
  const st = steps[i]
  return (
    <Modal title="사용 도움말" onClose={onClose}>
      <div className="guide">
        <div className="guide-num" key={i}>{i + 1}</div>
        <div className="guide-title" key={'t' + i}>{st.title}</div>
        <div className="guide-desc" key={'d' + i}>{st.desc}</div>
        <div className="guide-dots">{steps.map((_, k) => <span key={k} className={'gdot' + (k === i ? ' on' : '')} onClick={() => setI(k)} />)}</div>
      </div>
      <div className="modal-btns">
        <button className="btn ghost" disabled={i === 0} onClick={() => setI(i - 1)}>이전</button>
        {last
          ? <button className="btn primary" onClick={onClose}>시작하기</button>
          : <button className="btn primary" onClick={() => setI(i + 1)}>다음</button>}
      </div>
    </Modal>
  )
}

function Splash() {
  const [dots, setDots] = useState(1)
  const [step, setStep] = useState(0)
  useEffect(() => {
    const seq = [1, 2, 3, 2]; let i = 0
    const td = setInterval(() => { i = (i + 1) % seq.length; setDots(seq[i]) }, 380)
    const ts = setTimeout(() => setStep(1), 1100)
    return () => { clearInterval(td); clearTimeout(ts) }
  }, [])
  const d = '.'.repeat(dots)
  return (
    <div className="splash">
      <div className="splash-box">
        <div className="splash-logo">DSM</div>
        <div className="spinner" />
        <div className="splash-lines">
          <div className="splash-line on">DSM(DoryShortsMaker) Engine을 실행중입니다{step === 0 ? d : '...'}</div>
          <div className={'splash-line' + (step >= 1 ? ' on' : '')}>사용자 환경을 불러오고 있습니다{step >= 1 ? d : ''}</div>
        </div>
      </div>
    </div>
  )
}

function PromptHelp({ onClose }) {
  return (
    <Modal title="프롬프트, 어떻게 쓸까?" onClose={onClose}>
      <div className="phelp">
        <p>그리고 싶은 장면을 <b>그냥 말하듯이</b> 적으면 돼요. 한국어도 되고 영어도 돼요.</p>
        <p className="phelp-eg">예) <i>비 오는 새벽 골목, 우산 쓰고 혼자 걷는 뒷모습, 쓸쓸한 분위기</i></p>
        <ul>
          <li><b>뭐가 보이나</b> — 인물·사물·배경 (혼자/둘, 낮/밤, 안/밖)</li>
          <li><b>분위기</b> — 따뜻한, 쓸쓸한, 설레는, 차분한…</li>
          <li><b>느낌</b> — 영화 한 장면처럼, 수채화풍, 빛바랜 사진…</li>
        </ul>
        <p className="phelp-tip"><b>AI 티 덜 나게</b> — “실제 사진처럼, 자연광, 필름 감성, 살짝 흐릿하게” 같은 말을 붙이면 훨씬 자연스러워요. 너무 매끈·완벽하면 오히려 AI 같아 보이거든요.</p>
        <p className="phelp-tip">자막을 먼저 쓰고 <b>추천</b>을 누르면 알아서 만들어주기도 해요.</p>
      </div>
      <div className="modal-btns"><button className="btn primary" onClick={onClose}>알겠어요</button></div>
    </Modal>
  )
}

function MusicPicker({ current, onPick, onClose }) {
  const [audios, setAudios] = useState([])
  const [sel, setSel] = useState(current)        // mood | 'none' | 업로드 음악 id
  const [playing, setPlaying] = useState(null)
  const [uploading, setUploading] = useState(false)
  const audioRef = useRef(null)
  const fileRef = useRef(null)
  const load = () => api.audios().then(setAudios).catch(() => { })
  useEffect(() => { load() }, [])
  useEffect(() => () => { if (audioRef.current) audioRef.current.pause() }, [])
  const stop = () => { if (audioRef.current) { audioRef.current.pause(); audioRef.current = null } setPlaying(null) }
  const play = (key, url, e) => {
    e.stopPropagation()
    if (playing === key) { stop(); return }
    stop()
    const a = new Audio(url); a.loop = true; audioRef.current = a
    a.play().catch(err => { alert('재생할 수 없는 형식이거나 불러오기에 실패했어요.'); setPlaying(null) })
    setPlaying(key)
  }
  const upload = async (e) => {
    const f = e.target.files[0]; e.target.value = ''
    if (!f) return
    setUploading(true)
    try { const r = await api.uploadAudio(f); await load(); setSel(r.id) }
    catch (err) { alert(err.message) } finally { setUploading(false) }
  }
  const del = async (id, e) => {
    e.stopPropagation()
    if (!confirm('이 음악을 목록에서 삭제할까요?')) return
    if (playing === id) stop()
    setAudios(prev => prev.filter(x => x.id !== id))   // 즉시 제거(낙관적)
    if (sel === id) setSel('none')
    try { await api.delAudio(id) } catch (err) { alert(err.message); load() }
  }
  const close = () => { stop(); onClose() }
  const done = () => {
    stop()
    const a = audios.find(x => x.id === sel)
    onPick(a ? { bgm_mode: 'file', bgm_file: a.id, bgm_name: a.name } : { bgm_mode: sel, bgm_file: '', bgm_name: '' })
  }
  return (
    <Modal title="배경음악 선택" onClose={close} wide>
      <input ref={fileRef} type="file" accept="audio/*" hidden onChange={upload} />
      {uploading && <div className="modal-loading"><div className="spinner" /><div>음악 불러오는 중…</div></div>}
      <div className="music-head">
        <span className="music-sec">내 음악</span>
        <button className="btn info xs" disabled={uploading} onClick={() => fileRef.current.click()}>＋ 불러오기</button>
      </div>
      <div className="music-list">
        {audios.length === 0 && <div className="music-empty">불러온 음악이 없어요. ＋불러오기로 추가하세요.</div>}
        {audios.map(a => (
          <div key={a.id} className={'music-row' + (sel === a.id ? ' on' : '')} onClick={() => setSel(a.id)}>
            <span className="music-name">{a.name}</span>
            <button className="btn ghost xs" onClick={(e) => play(a.id, mediaUrl(a.id), e)}>{playing === a.id ? '■ 정지' : '▶ 듣기'}</button>
            <button className="btn danger-o xs" onClick={(e) => del(a.id, e)}>삭제</button>
            {sel === a.id && <span className="music-check">✓</span>}
          </div>
        ))}
      </div>
      <div className="music-head" style={{ marginTop: '14px' }}><span className="music-sec">무료 음악 <span className="muted">· 합성, 삭제 불가</span></span></div>
      <div className="music-list">
        {BGM_OPTS.filter(([, v]) => v !== 'file').map(([label, val]) => (
          <div key={val} className={'music-row' + (sel === val ? ' on' : '')} onClick={() => setSel(val)}>
            <span className="music-name">{label}</span>
            {val !== 'none' && <button className="btn ghost xs" onClick={(e) => play(val, `/api/bgm-preview?mood=${val}`, e)}>{playing === val ? '■ 정지' : '▶ 듣기'}</button>}
            {sel === val && <span className="music-check">✓</span>}
          </div>
        ))}
      </div>
      <div className="modal-btns">
        <button className="btn success" onClick={done}>완료</button>
        <button className="btn ghost" onClick={close}>닫기</button>
      </div>
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

// 모달이 열리면 히스토리에 한 칸 쌓고, 뒤로가기 → 가장 위 모달만 닫음(중첩 지원)
let _mStack = []      // 열린 레이어 id 스택
let _mSeq = 0
let _mClosing = 0     // 프로그램적 닫기로 인한 history.back() 무시용
function useBackClose(open, close) {
  const closeRef = useRef(close); closeRef.current = close
  useEffect(() => {
    if (!open) return
    const id = ++_mSeq
    _mStack.push(id)
    window.history.pushState({ m: id }, '')
    const onPop = () => {
      if (_mClosing) return
      if (_mStack[_mStack.length - 1] !== id) return   // 최상단만 반응
      _mStack.pop(); closeRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      const i = _mStack.lastIndexOf(id); if (i >= 0) _mStack.splice(i, 1)
      // 버튼 등으로 닫힘 → 우리가 push한 히스토리 한 칸 정리(다른 모달은 건드리지 않음)
      if (window.history.state && window.history.state.m === id) {
        _mClosing++; window.history.back()
        setTimeout(() => { _mClosing = Math.max(0, _mClosing - 1) }, 80)
      }
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
  const [splash] = useState(() => !sessionStorage.getItem('dsm_booted'))   // 이 탭에서 처음 접속할 때만 true
  const [minDone, setMinDone] = useState(false)
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
  const [vidsLoading, setVidsLoading] = useState(false)
  const [selVids, setSelVids] = useState(() => new Set())
  const [lightbox, setLightbox] = useState(null)
  const [musicOpen, setMusicOpen] = useState(false)
  const [promptHelp, setPromptHelp] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)
  const [tab, setTab] = useState('edit')
  const [pvOpen, setPvOpen] = useState(false)
  const [sel, setSel] = useState(0)
  const [propTab, setPropTab] = useState('scene')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const isMobile = useIsMobile()
  const endRef = useRef(null), audioRef = useRef(null), saveTimer = useRef(0)
  // 열릴 때 히스토리 한 칸 push → 뒤로가기로 닫힘 (삼성 등 모바일에서도 신뢰성↑)
  useBackClose(settingsOpen, () => setSettingsOpen(false))
  useBackClose(!!aiResult, () => setAiResult(null))
  useBackClose(!!fontDlg, () => setFontDlg(null))
  useBackClose(transHelp, () => setTransHelp(false))
  useBackClose(tab === 'vids', () => setTab('edit'))      // 내영상 → 뒤로가기 → 메인(편집)
  useBackClose(!!lightbox, () => setLightbox(null))
  useBackClose(musicOpen, () => setMusicOpen(false))
  useBackClose(promptHelp, () => setPromptHelp(false))
  useBackClose(guideOpen, () => setGuideOpen(false))
  useBackClose(contactOpen, () => setContactOpen(false))
  useEffect(() => {                                        // 사이트 이탈·새로고침 → 브라우저 확인창
    if (!user) return
    const onBefore = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
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
  // 스플래시는 '이 탭의 첫 접속'에만 (새로고침/뒤로가기는 같은 세션이라 생략)
  useEffect(() => {
    sessionStorage.setItem('dsm_booted', '1')
    if (!splash) { setMinDone(true); return }
    const t = setTimeout(() => setMinDone(true), 1300)
    return () => clearTimeout(t)
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
  const loadVideos = async () => { setVidsLoading(true); try { setVideos(await api.videos()) } catch { } finally { setVidsLoading(false) } }
  const toggleVid = (id) => setSelVids(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleAllVids = () => setSelVids(s => s.size === videos.length ? new Set() : new Set(videos.map(v => v.id)))
  const downloadSel = () => { videos.filter(v => selVids.has(v.id)).forEach((v, i) => setTimeout(() => { const a = document.createElement('a'); a.href = mediaUrl(v.id); a.download = v.id; document.body.appendChild(a); a.click(); a.remove() }, i * 400)) }
  const deleteSel = async () => { if (!selVids.size || !confirm(`선택한 ${selVids.size}개 영상을 삭제할까요?`)) return; for (const id of Array.from(selVids)) { try { await api.delVideo(id) } catch { } } setSelVids(new Set()); loadVideos() }

  const scenes = buildScenes(project)
  const urls = [...project.cuts.map(c => c.image_url), s.ending_url].filter(Boolean)
  const images = useImages(urls)
  const sceneEls = scenes.map(sc => ({ ...sc, dur: sc.center === 0.55 ? (s.cta_dur || 4.6) : s.scene_dur }))
  const anyModal = settingsOpen || musicOpen || promptHelp || guideOpen || contactOpen || !!fontDlg || transHelp || !!aiResult || !!lightbox
  const bgmUrl = s.bgm_mode === 'none' ? null
    : s.bgm_mode === 'file' ? (s.bgm_file ? mediaUrl(s.bgm_file) : null)
      : `/api/bgm-preview?mood=${s.bgm_mode}`

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
  const pickAudio = async (e) => { const f = e.target.files[0]; if (!f) return; setBusyMsg('음악 업로드 중…'); try { const r = await api.uploadAudio(f); setS({ bgm_mode: 'file', bgm_file: r.id, bgm_name: f.name }) } catch (err) { alert(err.message) } finally { setBusyMsg(null); e.target.value = '' } }

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
  const resetProject = () => { if (!confirm(`'${pname || '제목 없음'}'의 모든 내용을 초기화하시겠습니까?`)) return; setProject(defaultProject()); setSel(0) }
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

  if (booting || (splash && !minDone)) return splash
    ? <Splash />
    : <div className="splash min"><div className="spinner" /></div>
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
      <span className={'keyst ' + (user.has_key ? 'valid' : '')}>{user.has_key ? '등록됨 (인증 완료)' : '미등록'}</span>
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
      <button className="btn ghost sm" onClick={() => setMusicOpen(true)}>{s.bgm_mode === 'file' ? (s.bgm_name || '내 음악') : (BGM_NAME2LABEL[s.bgm_mode] || '선택')}</button>
    </div>
  </>)
  const cutListBlock = (
    <div className="cutlist">
      <div className="m-title">✎ 컷 목록 · 장면 편집</div>
      <div className="cutbar"><button className="btn success sm" onClick={addCut}>＋ 컷 추가</button></div>
      <div className="cuts-scroll">
        {project.cuts.map((c, i) =>
          <CutRow key={i} idx={i} cut={c} onChange={(nc) => setCut(i, nc)} onMove={(d) => moveCut(i, d)} onDel={() => delCut(i)}
            hasKey={user.has_key} busy={setBusyMsg} onAiResult={onAiResult} fontMode={s.font_mode} onCutFont={openFont} onImage={setLightbox} onHelp={() => setPromptHelp(true)} watermark={!!user.watermark} onInquiry={() => setContactOpen(true)} />)}
      </div>
    </div>
  )

  return (
    <div className="app studio">
      <header className="topbar">
        <div className="tb-row tb-nav">
          <span className="logo" role="button" onClick={() => setTab('edit')}>DSM</span>
          <button className={'navtab' + (tab === 'edit' ? ' on' : '')} onClick={() => setTab('edit')}>메인</button>
          <button className={'navtab' + (tab === 'vids' ? ' on' : '')} onClick={() => { setTab('vids'); loadVideos() }}>내 영상</button>
          <button className="btn ghost sm guide-btn" onClick={() => setGuideOpen(true)}>사용 도움말</button>
          <span className="spacer" />
          <span className="muted acct"><b>{user.name || user.email}</b>님 오늘은 어떤 영상을 만들어 볼까요?</span>
          <button className="btn ghost sm" onClick={logout}>로그아웃</button>
          {tab !== 'vids' && <button className="btn primary sm" disabled={!!render} onClick={makeVideo}>{render ? '만드는 중…' : '영상 만들기'}</button>}
        </div>
        {tab !== 'vids' && <div className="tb-row tb-proj">
          <span className="lbl">프로젝트</span>
          <input className="proj-name" value={pname} onChange={e => setPname(e.target.value)} placeholder="제목 없음" />
          <button className="btn success sm" onClick={saveProject}>저장</button>
          <button className="btn ghost sm" onClick={resetProject}>초기화</button>
          <select className="proj-pick" value={pid || ''} onChange={e => openProject(e.target.value)}>
            <option value="">내 프로젝트 열기…</option>
            {projList.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>}
      </header>

      {tab === 'vids' ? (
        <div className="vids-page">
          {vidsLoading && !videos.length ? (
            <div className="vids-loading"><div className="spinner" /><div>작업 내용을 불러오는 중입니다…</div></div>
          ) : !videos.length ? (
            <p className="muted" style={{ padding: '20px 4px' }}>아직 만든 영상이 없어요.</p>
          ) : (
            <>
              <div className="vids-bar">
                <label className="toggle"><input type="checkbox" checked={selVids.size === videos.length && videos.length > 0} onChange={toggleAllVids} /> 전체 선택</label>
                <span className="muted">{selVids.size > 0 ? `${selVids.size}개 선택됨` : `총 ${videos.length}개`}</span>
                <span className="spacer" />
                <button className="btn ghost sm" disabled={!selVids.size} onClick={downloadSel}>선택 다운로드</button>
                <button className="btn danger-o sm" disabled={!selVids.size} onClick={deleteSel}>선택 삭제</button>
              </div>
              <div className="vids">
                {videos.map(v =>
                  <div key={v.id} className={'vid' + (selVids.has(v.id) ? ' on' : '')}>
                    <label className="vid-check"><input type="checkbox" checked={selVids.has(v.id)} onChange={() => toggleVid(v.id)} /></label>
                    <video src={mediaUrl(v.id)} controls width="180" />
                    <div className="vid-meta"><div>{v.created}</div>
                      <a className="btn ghost sm" href={mediaUrl(v.id)} download>다운로드</a>
                      <button className="btn danger-o sm" onClick={async () => { if (!confirm('이 영상을 삭제할까요?')) return; await api.delVideo(v.id); loadVideos() }}>삭제</button>
                    </div>
                  </div>)}
              </div>
            </>
          )}
        </div>
      ) : isMobile ? (
        <div className="studio-mobile">
          <div className="m-canvas">
            <Preview scenes={sceneEls} images={images} settings={s} focus={sel} rendering={!!render} showMake={false} active={!anyModal} bgmUrl={bgmUrl} watermark={!!user.watermark} onInquiry={() => setContactOpen(true)} />
          </div>
          <SceneList cuts={project.cuts} sel={sel} onSelect={setSel} onAdd={addCut} onMove={moveCut} strip />
          <div className="m-edit">
            {project.cuts[sel] && <CutRow idx={sel} cut={project.cuts[sel]} onChange={nc => setCut(sel, nc)} onMove={d => moveCut(sel, d)} onDel={() => delCut(sel)} hasKey={user.has_key} busy={setBusyMsg} onAiResult={onAiResult} fontMode={s.font_mode} onCutFont={openFont} onImage={setLightbox} onHelp={() => setPromptHelp(true)} watermark={!!user.watermark} onInquiry={() => setContactOpen(true)} />}
          </div>
          <div className="mbar">
            <button className="btn info" onClick={() => setSettingsOpen(true)}>전체 설정</button>
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
            <Preview scenes={sceneEls} images={images} settings={s} focus={sel} rendering={!!render} showMake={false} active={!anyModal} bgmUrl={bgmUrl} watermark={!!user.watermark} onInquiry={() => setContactOpen(true)} />
          </main>
          <aside className="panel props-panel">
            <div className="prop-tabs">
              <button className={'pt' + (propTab === 'scene' ? ' on' : '')} onClick={() => setPropTab('scene')}>이 장면</button>
              <button className={'pt' + (propTab === 'global' ? ' on' : '')} onClick={() => setPropTab('global')}>전체 설정</button>
            </div>
            <div className="prop-body">
              {propTab === 'scene'
                ? (project.cuts[sel]
                  ? <CutRow idx={sel} cut={project.cuts[sel]} onChange={nc => setCut(sel, nc)} onMove={d => moveCut(sel, d)} onDel={() => delCut(sel)} hasKey={user.has_key} busy={setBusyMsg} onAiResult={onAiResult} fontMode={s.font_mode} onCutFont={openFont} onImage={setLightbox} onHelp={() => setPromptHelp(true)} watermark={!!user.watermark} onInquiry={() => setContactOpen(true)} />
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
      {promptHelp && <PromptHelp onClose={() => setPromptHelp(false)} />}
      {guideOpen && <Guide onClose={() => setGuideOpen(false)} />}
      {contactOpen && <Contact email={user.email} onClose={() => setContactOpen(false)} />}
      {aiResult && <AiResult images={aiResult.images} sel={aiResult.sel} setSel={setAiSel} loading={aiResult.loading} cut={aiResult.cut} onChoose={chooseAi} onOther={otherAi} onClose={() => setAiResult(null)} />}
      {lightbox && <div className="overlay lightbox" onClick={() => setLightbox(null)}>
        <img className="lightbox-img" src={lightbox} alt="" onClick={() => setLightbox(null)} />
      </div>}
      {musicOpen && <MusicPicker current={s.bgm_mode === 'file' ? s.bgm_file : s.bgm_mode}
        onPick={(patch) => { setS(patch); setMusicOpen(false) }}
        onClose={() => setMusicOpen(false)} />}
    </div>
  )
}
