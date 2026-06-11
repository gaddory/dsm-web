// 윈도우판 DSM과 동일한 옵션 세트

// 씬 전환 (표시이름 → ffmpeg xfade 이름) — 14종, 윈도우판과 동일
export const TRANSITIONS = [
  ['디졸브 (크로스페이드)', 'fade'],
  ['없음 (하드컷)', 'none'],
  ['페이드 (검정)', 'fadeblack'],
  ['페이드 (흰색)', 'fadewhite'],
  ['슬라이드 ←', 'slideleft'],
  ['슬라이드 →', 'slideright'],
  ['슬라이드 ↑', 'slideup'],
  ['슬라이드 ↓', 'slidedown'],
  ['와이프 →', 'wiperight'],
  ['와이프 ↑', 'wipeup'],
  ['원형 열기', 'circleopen'],
  ['원형 닫기', 'circleclose'],
  ['픽셀', 'pixelize'],
  ['디졸브2', 'dissolve'],
]
export const TRANS_MAP = Object.fromEntries(TRANSITIONS)
export const NAME2LABEL = Object.fromEntries(TRANSITIONS.map(([l, v]) => [v, l]))

// 배경음악
export const BGM_OPTS = [
  ['없음', 'none'],
  ['감성 피아노 (기본)', 'auto'],
  ['잔잔한 물결', 'calm'],
  ['따뜻한 햇살', 'bright'],
  ['내 음악 파일…', 'file'],
]
export const BGM_MAP = Object.fromEntries(BGM_OPTS)
export const BGM_NAME2LABEL = Object.fromEntries(BGM_OPTS.map(([l, v]) => [v, l]))

// 자막 세로 위치
export const POS_MAP = { '위': 0.28, '중상': 0.42, '중앙': 0.5, '중하': 0.62, '아래': 0.74 }
export const POS_LABELS = Object.keys(POS_MAP)
export const POS_CUT_LABELS = ['기본(전체)', ...POS_LABELS]
export function posToLabel(v) {
  if (v == null) return '기본(전체)'
  let best = '중하', bd = 9
  for (const [k, val] of Object.entries(POS_MAP)) { if (Math.abs(val - v) < bd) { bd = Math.abs(val - v); best = k } }
  return best
}

// 색상 (윈도우판 동일)
export const INK = [244, 234, 219]
export const GOLD = [212, 172, 116]
export const DIM = [200, 190, 176]

export const FW = 1188, FH = 2112

// 기본 프로젝트
export function defaultProject() {
  return {
    settings: {
      brand: '', use_brand: true,
      brightness: 1.34, scene_dur: 3.8,
      transition: 'fade', trans_dur: 0.45, sub_pos: 0.62,
      bgm_mode: 'auto', bgm_file: '',
      font_mode: 'global', font: null, cta_font: null,
      ending_image: '', use_cta: true,
      cta_lines: ['다음 이야기는 프로필 링크에서'],
      cta: '다음 이야기는 프로필 링크에서',
    },
    cuts: [emptyCut(), emptyCut(), emptyCut()],
  }
}
export function emptyCut() {
  return { text: '', image: '', image_url: '', prompt: '', font: null, sub_pos: null }
}
