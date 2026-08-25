import { useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { tutorials } from '../tutorials/tutorialContent';
import { loadPageTutorial, loadStepImages } from '../tutorials/tutorialStore';

// 온디맨드 튜토리얼: 오른쪽 아래 '?' 버튼 → 단계별 워크스루 + 요소 스포트라이트
// 콘텐츠는 DB(tutorial_content)에서 로드하고, 없으면 번들 기본값을 사용.
export default function HelpButton({ pageKey }) {
  const [tut, setTut] = useState(tutorials[pageKey] || null);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState(null);
  const [stepImgs, setStepImgs] = useState([]);
  const [lightbox, setLightbox] = useState(null);

  // DB에서 최신 콘텐츠 로드 (관리 페이지 편집분 반영)
  useEffect(() => {
    let alive = true;
    loadPageTutorial(pageKey).then(p => { if (alive && p) setTut(p); });
    return () => { alive = false; };
  }, [pageKey]);

  const steps = tut?.steps || [];
  const cur = steps[step];
  const isLast = step === steps.length - 1;

  // 현재 스텝 이미지 로드
  useEffect(() => {
    if (!open || !cur) { setStepImgs([]); return; }
    let alive = true;
    loadStepImages(pageKey, cur.id).then(imgs => { if (alive) setStepImgs(imgs); });
    return () => { alive = false; };
  }, [open, step, cur, pageKey]);

  // 현재 단계의 강조 대상 위치 측정
  const measure = useCallback(() => {
    if (!cur?.target) { setRect(null); return; }
    const el = document.querySelector(cur.target);
    if (!el) { setRect(null); return; }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [cur]);

  useLayoutEffect(() => {
    if (!open) return;
    // 대상이 화면 밖이면 스크롤로 가져온 뒤 측정
    if (cur?.target) {
      const el = document.querySelector(cur.target);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    measure();
    const t = setTimeout(measure, 320); // 스크롤 정착 후 재측정
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, step, cur, measure]);

  // 키보드: Esc 닫기, ←/→ 이동
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
      else if (e.key === 'ArrowRight') setStep(s => Math.min(s + 1, steps.length - 1));
      else if (e.key === 'ArrowLeft') setStep(s => Math.max(s - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, steps.length]);

  if (!tut || steps.length === 0) return null;

  const start = () => { setStep(0); setOpen(true); };

  // 말풍선 위치: 대상 아래(공간 없으면 위), 없으면 화면 가운데
  const PANEL_W = cur?.table ? 480 : 360;
  let panelStyle;
  if (rect) {
    const belowRoom = window.innerHeight - (rect.top + rect.height);
    const placeBelow = belowRoom > 220;
    const left = Math.min(Math.max(rect.left, 16), window.innerWidth - PANEL_W - 16);
    panelStyle = placeBelow
      ? { top: rect.top + rect.height + 14, left }
      : { top: rect.top - 14, left, transform: 'translateY(-100%)' };
  } else {
    panelStyle = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }

  return (
    <>
      {/* 오른쪽 아래 도움말 버튼 */}
      <button
        onClick={start}
        title="튜토리얼 보기"
        style={{
          position: 'fixed', right: 22, bottom: 22, zIndex: 9000,
          display: 'inline-flex', alignItems: 'center', gap: 7,
          padding: '11px 16px', borderRadius: 999, border: 'none',
          background: '#1e8e3e', color: '#fff', fontSize: 14, fontWeight: 700,
          cursor: 'pointer', boxShadow: '0 4px 14px rgba(30,142,62,0.4)',
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4" />
          <path d="M12 17h.01" />
        </svg>
        도움말
      </button>

      {open && (
        <>
          {/* 딤 처리 + 스포트라이트 (대상 없으면 전체 딤) */}
          {rect ? (
            <div
              onClick={() => setOpen(false)}
              style={{
                position: 'fixed', top: rect.top - 6, left: rect.left - 6,
                width: rect.width + 12, height: rect.height + 12, borderRadius: 8,
                boxShadow: '0 0 0 9999px rgba(15,23,42,0.55)',
                border: '2px solid #1e8e3e', zIndex: 10000, pointerEvents: 'none',
                transition: 'all 0.2s ease',
              }}
            />
          ) : (
            <div
              onClick={() => setOpen(false)}
              style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 10000 }}
            />
          )}

          {/* 안내 말풍선 */}
          <div
            style={{
              position: 'fixed', width: PANEL_W, maxWidth: 'calc(100vw - 32px)',
              maxHeight: 'calc(100vh - 32px)', overflowY: 'auto',
              background: '#fff', borderRadius: 14, boxShadow: '0 8px 30px rgba(0,0,0,0.28)',
              zIndex: 10001, padding: '18px 20px 16px', ...panelStyle,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#1e8e3e', letterSpacing: 0.3 }}>
                {tut.title} · {step + 1}/{steps.length}
              </span>
              <button
                onClick={() => setOpen(false)}
                style={{ border: 'none', background: 'none', fontSize: 20, lineHeight: 1, color: '#9aa0a6', cursor: 'pointer' }}
                title="닫기"
              >✕</button>
            </div>

            <div style={{ fontSize: 16, fontWeight: 800, color: '#202124', marginBottom: 8 }}>{cur.title}</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.7, color: '#3c4043', whiteSpace: 'pre-line', marginBottom: (cur.table || stepImgs.length) ? 10 : 16 }}>
              {cur.body}
            </div>

            {/* 스텝 이미지 (클릭 시 크게 보기) */}
            {stepImgs.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                {stepImgs.map((src, i) => (
                  <img
                    key={i} src={src} alt="" onClick={() => setLightbox(src)}
                    style={{ width: stepImgs.length === 1 ? '100%' : 'calc(50% - 4px)', maxHeight: 200, objectFit: 'cover', borderRadius: 8, border: '1px solid #e0e0e0', cursor: 'zoom-in' }}
                  />
                ))}
              </div>
            )}

            {/* 엑셀 다운로드 형태 등 표 미리보기 (재고주수 4 미만 셀은 빨강) */}
            {cur.table && (
              <div style={{ overflowX: 'auto', border: '1px solid #e0e0e0', borderRadius: 6, marginBottom: 16 }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 11, whiteSpace: 'nowrap' }}>
                  <thead>
                    <tr>
                      {cur.table.headers.map((h, i) => (
                        <th key={i} style={{ padding: '5px 8px', background: '#f1f3f4', borderBottom: '1px solid #e0e0e0', borderRight: '1px solid #eee', fontWeight: 700, color: '#3c4043', textAlign: 'left' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cur.table.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => {
                          const isStock = /재고주수/.test(cur.table.headers[ci] || '');
                          const low = isStock && cell !== '' && Number(cell) < 4;
                          return (
                            <td key={ci} style={{ padding: '5px 8px', borderBottom: '1px solid #f0f0f0', borderRight: '1px solid #f5f5f5', color: '#3c4043', background: low ? '#fce8e6' : undefined }}>{cell}</td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* 진행 점 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: 5 }}>
                {steps.map((_, i) => (
                  <span key={i} style={{
                    width: i === step ? 18 : 7, height: 7, borderRadius: 999,
                    background: i === step ? '#1e8e3e' : '#dadce0', transition: 'all 0.2s',
                  }} />
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {step > 0 && (
                  <button
                    onClick={() => setStep(s => s - 1)}
                    style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #dadce0', background: '#fff', color: '#3c4043', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                  >◀ 이전</button>
                )}
                {isLast ? (
                  <button
                    onClick={() => setOpen(false)}
                    style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#1e8e3e', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                  >완료</button>
                ) : (
                  <button
                    onClick={() => setStep(s => s + 1)}
                    style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#1e8e3e', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                  >다음 ▶</button>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {/* 이미지 크게 보기 */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 10002, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out', padding: 24 }}
        >
          <img src={lightbox} alt="" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8 }} />
        </div>
      )}
    </>
  );
}
