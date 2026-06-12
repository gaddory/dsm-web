// 윈도우판 engine.compose_card / _trans_frame 을 Canvas로 동일 재현
import { FW, FH } from './constants.js'

const FONT = '"Noto Sans KR", "Malgun Gothic", sans-serif'
function fontStr(size, bold) { return `${bold ? 700 : 400} ${Math.round(size)}px ${FONT}` }

function drawCover(ctx, img, tw, th) {
  const s = Math.max(tw / img.naturalWidth, th / img.naturalHeight)
  const nw = img.naturalWidth * s, nh = img.naturalHeight * s
  ctx.drawImage(img, (tw - nw) / 2, (th - nh) / 2, nw, nh)
}

function bottomGrad(ctx) {
  const g = ctx.createLinearGradient(0, 0, 0, FH)
  g.addColorStop(0, 'rgba(8,6,5,0)')
  g.addColorStop(0.42, 'rgba(8,6,5,0)')
  g.addColorStop(1, 'rgba(8,6,5,0.47)')
  ctx.fillStyle = g; ctx.fillRect(0, 0, FW, FH)
}

function lineH(ctx, size) {
  const m = ctx.measureText('가힣')
  if (m.fontBoundingBoxAscent) return m.fontBoundingBoxAscent + m.fontBoundingBoxDescent
  return size * 1.2
}

// _line: 그림자(+1,+3 검정) + 검정 외곽선 + 색 채움
function drawLine(ctx, cx, y, text, fStr, fill, stroke) {
  ctx.font = fStr; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.lineJoin = 'round'
  ctx.fillStyle = 'black'; ctx.fillText(text, cx + 1, y + 3)
  ctx.lineWidth = stroke * 2; ctx.strokeStyle = 'black'; ctx.strokeText(text, cx, y)
  ctx.fillStyle = fill; ctx.fillText(text, cx, y)
}

// 워터마크: 우하단, 2줄 가운데정렬, 반투명 (렌더 결과와 동일)
function drawWatermark(ctx) {
  const lines = ['DSM(DoryShortsMaker)', '-Dory-']
  const fs = 36
  ctx.font = fontStr(fs, true); ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  const lh = lineH(ctx, fs), gap = 6
  const bw = Math.max(...lines.map(l => ctx.measureText(l).width))
  const marginR = 34, marginB = 46
  const cx = FW - marginR - bw / 2
  let y = FH - marginB - (lh * lines.length + gap * (lines.length - 1))
  for (const l of lines) {
    ctx.fillStyle = 'rgba(0,0,0,0.47)'; ctx.fillText(l, cx + 2, y + 2)
    ctx.fillStyle = 'rgba(255,255,255,0.63)'; ctx.fillText(l, cx, y)
    y += lh + gap
  }
}

// scene: {imgEl, lines[], center, header, footer, bright, font:{size,color[]}|null, goldLast, watermark}
export function drawScene(canvas, scene) {
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, FW, FH)
  const im = scene.imgEl
  if (im && im.complete && im.naturalWidth) {
    ctx.save(); ctx.filter = `brightness(${scene.bright || 1.34}) contrast(1.04) saturate(1.08)`
    drawCover(ctx, im, FW, FH); ctx.restore()
    bottomGrad(ctx)
  } else {
    ctx.fillStyle = 'rgb(44,40,36)'; ctx.fillRect(0, 0, FW, FH)
  }
  if (scene.header) drawLine(ctx, FW / 2, 150, scene.header, fontStr(38, false), 'rgb(200,190,176)', 4)
  if (scene.footer) drawLine(ctx, FW / 2, FH - 230, scene.footer, fontStr(40, false), 'rgb(200,190,176)', 4)

  let lines = (scene.lines || []).filter(l => l !== '')
  if (!lines.length) lines = [' ']
  const gap = 16

  if (scene.font) {
    let s = scene.font.size || 58; ctx.font = fontStr(s, true)
    while (s > 20 && Math.max(...lines.map(l => ctx.measureText(l).width)) > 1010) { s -= 3; ctx.font = fontStr(s, true) }
    const lh = lineH(ctx, s), total = lh * lines.length + gap * (lines.length - 1)
    let y = FH * scene.center - total / 2
    const col = scene.font.color ? `rgb(${scene.font.color.join(',')})` : 'rgb(244,234,219)'
    const stroke = Math.max(4, Math.floor(s / 12))
    for (const l of lines) { drawLine(ctx, FW / 2, y, l, fontStr(s, true), col, stroke); y += lh + gap }
  } else {
    let s = 58; ctx.font = fontStr(s, true)
    while (s > 28 && Math.max(...lines.map(l => ctx.measureText(l).width)) > 1010) { s -= 3; ctx.font = fontStr(s, true) }
    const lh = lineH(ctx, s), total = lh * lines.length + gap * (lines.length - 1)
    let y = FH * scene.center - total / 2
    const stroke = Math.max(4, Math.floor(s / 12))
    lines.forEach((l, i) => {
      const col = (scene.goldLast !== false && i === lines.length - 1) ? 'rgb(212,172,116)' : 'rgb(244,234,219)'
      drawLine(ctx, FW / 2, y, l, fontStr(s, true), col, stroke); y += lh + gap
    })
  }
  if (scene.watermark) drawWatermark(ctx)
}

// 전환: A→B (오프스크린 캔버스 2장) 를 visible ctx에 합성
export function drawTransition(ctx, A, B, name, t) {
  ctx.clearRect(0, 0, FW, FH); ctx.globalAlpha = 1
  const T = Math.max(0, Math.min(1, t))
  switch (name) {
    case 'none': ctx.drawImage(T < 1 ? A : B, 0, 0); return
    case 'slideleft': ctx.drawImage(A, -FW * T, 0); ctx.drawImage(B, FW * (1 - T), 0); return
    case 'slideright': ctx.drawImage(A, FW * T, 0); ctx.drawImage(B, -FW * (1 - T), 0); return
    case 'slideup': ctx.drawImage(A, 0, -FH * T); ctx.drawImage(B, 0, FH * (1 - T)); return
    case 'slidedown': ctx.drawImage(A, 0, FH * T); ctx.drawImage(B, 0, -FH * (1 - T)); return
    case 'wiperight': {
      ctx.drawImage(A, 0, 0); ctx.save(); ctx.beginPath(); ctx.rect(0, 0, FW * T, FH); ctx.clip(); ctx.drawImage(B, 0, 0); ctx.restore(); return
    }
    case 'wipeup': {
      ctx.drawImage(A, 0, 0); ctx.save(); ctx.beginPath(); ctx.rect(0, FH * (1 - T), FW, FH * T); ctx.clip(); ctx.drawImage(B, 0, 0); ctx.restore(); return
    }
    case 'fadeblack': {
      if (T < 0.5) { ctx.drawImage(A, 0, 0); ctx.fillStyle = `rgba(0,0,0,${T * 2})` }
      else { ctx.drawImage(B, 0, 0); ctx.fillStyle = `rgba(0,0,0,${(1 - T) * 2})` }
      ctx.fillRect(0, 0, FW, FH); return
    }
    case 'fadewhite': {
      if (T < 0.5) { ctx.drawImage(A, 0, 0); ctx.fillStyle = `rgba(255,255,255,${T * 2})` }
      else { ctx.drawImage(B, 0, 0); ctx.fillStyle = `rgba(255,255,255,${(1 - T) * 2})` }
      ctx.fillRect(0, 0, FW, FH); return
    }
    case 'circleopen': case 'circleclose': {
      ctx.drawImage(A, 0, 0); const r = Math.hypot(FW, FH) / 2 * T
      ctx.save(); ctx.beginPath(); ctx.arc(FW / 2, FH / 2, r, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(B, 0, 0); ctx.restore(); return
    }
    default: // fade / dissolve / pixelize 등 → 알파 블렌드
      ctx.drawImage(A, 0, 0); ctx.globalAlpha = T; ctx.drawImage(B, 0, 0); ctx.globalAlpha = 1; return
  }
}
