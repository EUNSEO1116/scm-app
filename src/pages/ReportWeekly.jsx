import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

// ===== 유틸 =====
function resizeImage(file, maxDim = 1000) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
          else { width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstDayNr = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNr + 3);
  const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
  return `${target.getFullYear()}-W${pad2(week)}`;
}
const WEEKDAY_KR = ['일', '월', '화', '수', '목', '금', '토'];
function dowKr(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return WEEKDAY_KR[d.getDay()];
}
function genId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// 보고서 뷰어(.report-viewer)를 캡처해 A4 PDF 파일로 즉시 다운로드.
// 라이브러리는 동적 import로 불러와 메인 번들을 키우지 않는다.
async function downloadReportPdf(report) {
  const el = document.querySelector('.report-viewer');
  if (!el) return;
  const [{ default: html2canvas }, jspdfMod] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);
  const JsPDF = jspdfMod.jsPDF || jspdfMod.default;
  const hidden = el.querySelectorAll('.no-print');
  hidden.forEach(n => { n.style.visibility = 'hidden'; });
  try {
    const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
    const pdf = new JsPDF('p', 'mm', 'a4');
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgW = pageW;
    const imgH = canvas.height * imgW / canvas.width;
    const imgData = canvas.toDataURL('image/jpeg', 0.92);
    let heightLeft = imgH;
    let position = 0;
    pdf.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
    heightLeft -= pageH;
    while (heightLeft > 0) {
      position = heightLeft - imgH;
      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
      heightLeft -= pageH;
    }
    const safe = (report.title || '보고서').replace(/[\\/:*?"<>|]/g, '_');
    pdf.save(`${safe}_${report.reportDate || todayStr()}.pdf`);
  } finally {
    hidden.forEach(n => { n.style.visibility = ''; });
  }
}

// 섹션 색상 팔레트 (순서대로 자동 배정 — 입력 불필요)
const PALETTE = [
  { bar: '#2563eb', bg: '#eff6ff', text: '#1e40af' },
  { bar: '#e67e22', bg: '#fff7ed', text: '#c05600' },
  { bar: '#8e44ad', bg: '#faf5ff', text: '#6b21a8' },
  { bar: '#16a34a', bg: '#f0fdf4', text: '#15803d' },
  { bar: '#dc2626', bg: '#fef2f2', text: '#b91c1c' },
  { bar: '#0891b2', bg: '#ecfeff', text: '#0e7490' },
];
function pal(i) { return PALETTE[i % PALETTE.length]; }

const DEFAULT_TEMPLATE = [
  { id: 'sec_summary', title: '핵심 요약' },
  { id: 'sec_stock', title: '재고 이슈' },
  { id: 'sec_inbound', title: '입고 이슈' },
  { id: 'sec_logi', title: '물류 이슈' },
  { id: 'sec_decision', title: '의사결정 요청' },
  { id: 'sec_next', title: '다음 주 리스크 & 대응' },
];

function emptyReportFromTemplate(tmpl) {
  const date = todayStr();
  return {
    id: genId(),
    title: 'SCM 이슈 보고',
    team: 'SCM팀',
    reportDate: date,
    weekLabel: isoWeek(date),
    sections: (tmpl || DEFAULT_TEMPLATE).map(s => ({
      id: s.id, title: s.title, rows: [{ title: '', detail: '' }], imageCount: 0,
    })),
    updatedAt: new Date().toISOString(),
  };
}

export default function ReportWeekly() {
  const [index, setIndex] = useState([]);
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [report, setReport] = useState(null);
  const [mode, setMode] = useState('view'); // view | edit | calendar
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [imgMap, setImgMap] = useState({}); // { sectionId: [base64...] }
  const [calMonth, setCalMonth] = useState(() => todayStr().slice(0, 7));
  const [toast, setToast] = useState('');
  const fileInputRef = useRef(null);
  const addTargetRef = useRef(null);

  useEffect(() => {
    (async () => {
      const [idx, tmpl] = await Promise.all([
        dbStoreGet('report_index'),
        dbStoreGet('report_template'),
      ]);
      if (Array.isArray(tmpl?.sections) && tmpl.sections.length) setTemplate(tmpl.sections);
      const list = Array.isArray(idx) ? idx : [];
      list.sort((a, b) => (b.reportDate || '').localeCompare(a.reportDate || ''));
      setIndex(list);
      if (list.length > 0) await openReport(list[0].id);
      setLoading(false);
    })();
  }, []);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(''), 1800); };

  const openReport = useCallback(async (id) => {
    setLoading(true);
    const r = await dbStoreGet(`report_${id}`);
    if (r) {
      setReport(r);
      const map = {};
      await Promise.all((r.sections || []).map(async (sec) => {
        if (sec.imageCount > 0) {
          const imgs = await dbStoreGet(`report_img_${id}_${sec.id}`);
          map[sec.id] = Array.isArray(imgs) ? imgs : [];
        } else map[sec.id] = [];
      }));
      setImgMap(map);
    }
    setLoading(false);
  }, []);

  const sortedIndex = useMemo(
    () => [...index].sort((a, b) => (b.reportDate || '').localeCompare(a.reportDate || '')),
    [index]
  );

  // ===== 저장 =====
  const persist = useCallback(async (next) => {
    setSaving(true);
    const toSave = { ...next, updatedAt: new Date().toISOString(), weekLabel: isoWeek(next.reportDate) };
    await dbStoreSet(`report_${toSave.id}`, toSave, { logDesc: `주간보고 저장: ${toSave.reportDate}` });
    const entry = {
      id: toSave.id, title: toSave.title, team: toSave.team,
      reportDate: toSave.reportDate, weekLabel: toSave.weekLabel, updatedAt: toSave.updatedAt,
    };
    const curIdx = Array.isArray(index) ? [...index] : [];
    const pos = curIdx.findIndex(e => e.id === toSave.id);
    if (pos >= 0) curIdx[pos] = entry; else curIdx.push(entry);
    await dbStoreSet('report_index', curIdx, { skipLog: true });
    setIndex(curIdx);
    setReport(toSave);
    setSaving(false);
    return toSave;
  }, [index]);

  const createNew = () => {
    const r = emptyReportFromTemplate(template);
    setReport(r);
    setImgMap({});
    setMode('edit');
  };

  const deleteReport = async (id) => {
    if (!window.confirm('이 보고서를 삭제할까요? (이미지 포함)')) return;
    const r = await dbStoreGet(`report_${id}`);
    if (r && Array.isArray(r.sections)) {
      await Promise.all(r.sections.map(sec =>
        sec.imageCount > 0 ? dbStoreSet(`report_img_${id}_${sec.id}`, [], { skipLog: true }) : null));
    }
    await dbStoreSet(`report_${id}`, null, { skipLog: true });
    const curIdx = index.filter(e => e.id !== id);
    await dbStoreSet('report_index', curIdx, { skipLog: true });
    setIndex(curIdx);
    if (curIdx.length > 0) openReport(curIdx[0].id);
    else { setReport(null); setMode('view'); }
  };

  // ===== 편집 드래프트 =====
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    if (mode === 'edit' && report) setDraft(JSON.parse(JSON.stringify(report)));
  }, [mode, report]);

  const updateDraft = (patch) => setDraft(d => ({ ...d, ...patch }));

  const updateSection = (sid, patch) =>
    setDraft(d => ({ ...d, sections: d.sections.map(s => s.id === sid ? { ...s, ...patch } : s) }));
  const addSection = () => {
    const title = window.prompt('새 섹션 제목', '새 섹션');
    if (title == null) return;
    setDraft(d => ({ ...d, sections: [...d.sections, { id: genId(), title: title.trim() || '새 섹션', rows: [{ title: '', detail: '' }], imageCount: 0 }] }));
  };
  const removeSection = async (sid) => {
    if (!window.confirm('이 섹션을 삭제할까요?')) return;
    if (draft) await dbStoreSet(`report_img_${draft.id}_${sid}`, [], { skipLog: true });
    setImgMap(m => { const n = { ...m }; delete n[sid]; return n; });
    setDraft(d => ({ ...d, sections: d.sections.filter(s => s.id !== sid) }));
  };
  const moveSection = (sid, dir) => {
    setDraft(d => {
      const arr = [...d.sections];
      const i = arr.findIndex(s => s.id === sid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return d;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return { ...d, sections: arr };
    });
  };

  const addRow = (sid) =>
    updateSection(sid, { rows: [...(draft.sections.find(s => s.id === sid)?.rows || []), { title: '', detail: '' }] });
  const updateRow = (sid, idx, patch) => {
    const sec = draft.sections.find(s => s.id === sid);
    const rows = sec.rows.map((r, i) => i === idx ? { ...r, ...patch } : r);
    updateSection(sid, { rows });
  };
  const removeRow = (sid, idx) => {
    const sec = draft.sections.find(s => s.id === sid);
    updateSection(sid, { rows: sec.rows.filter((_, i) => i !== idx) });
  };

  // ===== 이미지 =====
  const triggerAddImage = (sid) => { addTargetRef.current = sid; fileInputRef.current?.click(); };
  const handleFiles = async (e) => {
    const sid = addTargetRef.current;
    const files = Array.from(e.target.files || []);
    if (!sid || !files.length || !draft) return;
    const cur = imgMap[sid] || [];
    const remaining = 3 - cur.length;
    if (remaining <= 0) { if (fileInputRef.current) fileInputRef.current.value = ''; return; }
    const resized = await Promise.all(files.slice(0, remaining).map(f => resizeImage(f)));
    const next = [...cur, ...resized];
    await dbStoreSet(`report_img_${draft.id}_${sid}`, next, { logDesc: `주간보고 이미지 저장` });
    setImgMap(m => ({ ...m, [sid]: next }));
    updateSection(sid, { imageCount: next.length });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const deleteImage = async (sid, idx) => {
    const cur = imgMap[sid] || [];
    const next = cur.filter((_, i) => i !== idx);
    await dbStoreSet(`report_img_${draft.id}_${sid}`, next, { logDesc: `주간보고 이미지 삭제` });
    setImgMap(m => ({ ...m, [sid]: next }));
    updateSection(sid, { imageCount: next.length });
  };

  // ===== 저장 액션 =====
  const saveDraft = async () => {
    const cleaned = {
      ...draft,
      sections: draft.sections.map(s => ({
        ...s,
        rows: s.rows.filter(r => (r.title || '').trim() || (r.detail || '').trim()),
      })),
    };
    await persist(cleaned);
    setMode('view');
    flash('보고서 저장 완료');
  };

  const saveAsTemplate = async () => {
    if (!draft) return;
    const sections = draft.sections.map(s => ({ id: s.id, title: s.title }));
    await dbStoreSet('report_template', { sections, updatedAt: new Date().toISOString() }, { logDesc: '주간보고 템플릿 저장' });
    setTemplate(sections);
    flash('현재 구성을 템플릿으로 저장했습니다');
  };

  if (loading) {
    return (
      <div className="loading" style={{ padding: 80, flexDirection: 'column', gap: 12 }}>
        <div className="spinner" />
        <p>주간 이슈 보고를 불러오는 중...</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      {toast && (
        <div style={{ position: 'fixed', top: 70, left: '50%', transform: 'translateX(-50%)', background: '#111827', color: '#fff', padding: '10px 18px', borderRadius: 10, fontSize: 13, zIndex: 10000, boxShadow: '0 4px 16px rgba(0,0,0,.2)' }}>{toast}</div>
      )}

      {/* 툴바 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className={`btn btn-sm ${mode === 'view' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setMode('view')}>📄 보고 보기</button>
          <button className={`btn btn-sm ${mode === 'edit' ? 'btn-primary' : 'btn-outline'}`} onClick={() => { if (report) setMode('edit'); else createNew(); }}>✏️ 편집</button>
          <button className={`btn btn-sm ${mode === 'calendar' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setMode('calendar')}>🗓️ 캘린더</button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {saving && <span style={{ fontSize: 12, color: '#999' }}>저장 중...</span>}
            <button className="btn btn-primary btn-sm" onClick={createNew}>+ 새 보고서</button>
          </div>
        </div>
      </div>

      {/* 주차 네비 */}
      {mode !== 'calendar' && sortedIndex.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-body" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
            <span style={{ fontSize: 12, color: '#888', marginRight: 4 }}>주차 기록</span>
            {sortedIndex.slice(0, 12).map((e) => {
              const active = report && report.id === e.id;
              const isThis = e.weekLabel === isoWeek(todayStr());
              return (
                <button key={e.id}
                  className={`btn btn-sm ${active ? 'btn-primary' : 'btn-outline'}`}
                  style={{ fontSize: 11 }}
                  onClick={() => { setMode('view'); openReport(e.id); }}>
                  {isThis ? '금주 · ' : ''}{e.reportDate?.slice(5)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {mode === 'calendar' && (
        <CalendarView month={calMonth} setMonth={setCalMonth} index={sortedIndex}
          onOpen={(id) => { setMode('view'); openReport(id); }} />
      )}

      {mode === 'view' && !report && (
        <div className="card"><div className="card-body" style={{ textAlign: 'center', padding: 48, color: '#999' }}>
          아직 작성된 보고서가 없습니다. <b>+ 새 보고서</b>로 시작하세요.
        </div></div>
      )}

      {mode === 'view' && report && (
        <ReportView report={report} imgMap={imgMap}
          onEdit={() => setMode('edit')} onDelete={() => deleteReport(report.id)} />
      )}

      {mode === 'edit' && draft && (
        <ReportEditor
          draft={draft} imgMap={imgMap}
          updateDraft={updateDraft}
          updateSection={updateSection} addSection={addSection} removeSection={removeSection} moveSection={moveSection}
          addRow={addRow} updateRow={updateRow} removeRow={removeRow}
          triggerAddImage={triggerAddImage} deleteImage={deleteImage}
          onSave={saveDraft} onSaveTemplate={saveAsTemplate}
          onCancel={() => { setMode('view'); if (!report) setDraft(null); }}
        />
      )}

      <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFiles} style={{ display: 'none' }} />
    </div>
  );
}

// ===== 보고 보기 (뷰어) =====
function hasContent(sec, imgMap) {
  return (sec.rows || []).some(r => (r.title || '').trim() || (r.detail || '').trim()) || (imgMap[sec.id] || []).length > 0;
}
function cleanRows(sec) {
  return (sec.rows || []).filter(r => (r.title || '').trim() || (r.detail || '').trim());
}

function ReportView({ report, imgMap, onEdit, onDelete }) {
  const allSections = report.sections || [];
  // 핵심 요약 / 다음 주 섹션을 제목으로 분류 (내용 있을 때만 밴드로)
  const summarySec = allSections.find(s => /요약|summary/i.test(s.title || '') && hasContent(s, imgMap));
  const nextSec = allSections.find(s => /다음\s*주|리스크|next|risk/i.test(s.title || '') && hasContent(s, imgMap));
  // 중간 카드: 요약·다음주를 제외하고, 내용이 있는 섹션만 (빈 섹션은 숨김)
  const midSections = allSections.filter(s => s !== summarySec && s !== nextSec && hasContent(s, imgMap));
  const filledCount = allSections.filter(s => hasContent(s, imgMap)).length;

  return (
    <div className="report-viewer">
      {/* 인쇄 시 메뉴·툴바·웹 UI 숨기고 보고서만 출력 */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .report-viewer, .report-viewer * { visibility: visible !important; }
          .report-viewer { position: absolute; left: 0; top: 0; width: 100%; padding: 0 10px; }
          .no-print { display: none !important; }
          @page { margin: 12mm; }
        }
      `}</style>

      {/* 헤더 (플랫 — 큰 박스 제거) */}
      <div style={{ textAlign: 'center', marginBottom: 24, paddingBottom: 16, borderBottom: '3px solid #1e40af' }}>
        <div style={{ fontSize: 34, fontWeight: 900, color: '#0f172a', letterSpacing: -1 }}>{report.title}</div>
        <div style={{ fontSize: 14, color: '#475569', marginTop: 9, fontWeight: 600 }}>
          {report.team} · 보고 기준 {report.reportDate}({dowKr(report.reportDate)})
        </div>
      </div>

      {filledCount === 0 && (
        <div className="card"><div className="card-body" style={{ textAlign: 'center', color: '#aaa', padding: 40 }}>
          작성된 내용이 없습니다. <b>✏️ 편집</b>에서 각 칸을 채워보세요.
        </div></div>
      )}

      {/* ① 핵심 요약 밴드 */}
      {summarySec && (
        <div style={{
          background: 'linear-gradient(135deg,#fff6e9,#fffdf9)', border: '1px solid #ffdca8',
          borderLeft: '7px solid #fb8c00', borderRadius: 16, padding: '20px 24px', marginBottom: 20,
          boxShadow: '0 4px 16px rgba(251,140,0,.1)',
        }}>
          <div style={{ fontSize: 17, fontWeight: 900, color: '#d35400', marginBottom: 14, textAlign: 'center', letterSpacing: -0.4 }}>⚡ {summarySec.title}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
            {cleanRows(summarySec).map((r, i) => (
              <span key={i} style={{ background: '#fff', border: '1px solid #ffd79a', borderRadius: 999, padding: '9px 18px', fontSize: 14.5, fontWeight: 700, color: '#7a3e00', boxShadow: '0 2px 5px rgba(0,0,0,.05)' }}>
                {r.title}{r.detail ? <span style={{ fontWeight: 500, color: '#a86a2a' }}> · {r.detail}</span> : null}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ② 중간 섹션 카드 그리드 (빈 섹션 숨김, 폭 제한+가운데) */}
      {midSections.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 460px))', gap: 18, marginBottom: 20, justifyContent: 'center' }}>
          {midSections.map((sec, idx) => {
            const c = pal(idx);
            const rows = cleanRows(sec);
            const imgs = imgMap[sec.id] || [];
            return (
              <div key={sec.id} style={{
                gridColumn: imgs.length ? '1 / -1' : 'auto',
                background: '#fff', border: '1px solid #e8ecf2', borderRadius: 16, overflow: 'hidden',
                boxShadow: '0 4px 18px rgba(16,24,40,.08)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: c.bg, borderBottom: `2px solid ${c.bar}`, padding: '14px 18px' }}>
                  <span style={{ width: 12, height: 12, borderRadius: 4, background: c.bar, flexShrink: 0 }} />
                  <span style={{ fontWeight: 900, fontSize: 16.5, color: c.text, letterSpacing: -0.4 }}>{sec.title}</span>
                </div>
                <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {rows.map((r, i) => (
                    <div key={i} style={{ display: 'flex', gap: 11, alignItems: 'flex-start' }}>
                      <span style={{ color: c.bar, fontWeight: 900, fontSize: 18, lineHeight: 1.25, flexShrink: 0 }}>›</span>
                      <div style={{ flex: 1 }}>
                        {r.title && <div style={{ fontWeight: 800, fontSize: 15.5, color: '#111827', lineHeight: 1.35, letterSpacing: -0.2 }}>{r.title}</div>}
                        {r.detail && <div style={{ fontSize: 13.5, color: '#5b6b82', whiteSpace: 'pre-wrap', lineHeight: 1.55, marginTop: 3 }}>{r.detail}</div>}
                      </div>
                    </div>
                  ))}
                  {imgs.length > 0 && (
                    <div style={{ marginTop: 2 }}>
                      {imgs.map((src, i) => (
                        <img key={i} src={src} alt="" style={{ width: '100%', height: 'auto', objectFit: 'contain', borderRadius: 10, border: '1px solid #e5e7eb', display: 'block' }} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ③ 다음 주 리스크 밴드 */}
      {nextSec && (
        <div style={{ background: 'linear-gradient(135deg,#eef2f9,#f8fafc)', border: '1px solid #d7e0ec', borderLeft: '7px solid #334155', borderRadius: 16, padding: '20px 24px', marginBottom: 20 }}>
          <div style={{ fontSize: 17, fontWeight: 900, color: '#1e293b', marginBottom: 14, textAlign: 'center', letterSpacing: -0.4 }}>📌 {nextSec.title}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
            {cleanRows(nextSec).map((r, i) => (
              <div key={i} style={{ textAlign: 'center' }}>
                <span style={{ fontWeight: 800, fontSize: 15, color: '#0f172a' }}>{r.title}</span>
                {r.detail ? <span style={{ color: '#64748b', fontSize: 13.5 }}> — {r.detail}</span> : null}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 10 }} className="no-print">
        <button className="btn btn-primary btn-sm" onClick={onEdit}>✏️ 편집</button>
        <button className="btn btn-outline btn-sm" onClick={() => downloadReportPdf(report)}>⬇️ PDF 다운로드</button>
        <button className="btn btn-outline btn-sm" onClick={() => window.print()}>🖨️ 인쇄</button>
        <button className="btn btn-outline btn-sm" style={{ color: '#d93025' }} onClick={onDelete}>🗑️ 삭제</button>
      </div>
    </div>
  );
}

// ===== 편집 =====
function ReportEditor({ draft, imgMap, updateDraft, updateSection, addSection, removeSection, moveSection, addRow, updateRow, removeRow, triggerAddImage, deleteImage, onSave, onSaveTemplate, onCancel }) {
  const inp = { width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' };
  return (
    <div>
      {/* 기본 정보 */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><h2 style={{ fontSize: 14, fontWeight: 700 }}>보고서 기본 정보</h2></div>
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
          <div>
            <label style={{ fontSize: 11, color: '#666' }}>제목</label>
            <input style={{ ...inp, textAlign: 'center' }} value={draft.title} onChange={e => updateDraft({ title: e.target.value })} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: '#666' }}>보고 기준일</label>
            <input type="date" style={{ ...inp, textAlign: 'center' }} value={draft.reportDate} onChange={e => updateDraft({ reportDate: e.target.value })} />
          </div>
          <div>
            <label style={{ fontSize: 11, color: '#666' }}>팀/부서</label>
            <input style={{ ...inp, textAlign: 'center' }} value={draft.team} onChange={e => updateDraft({ team: e.target.value })} />
          </div>
        </div>
      </div>

      {/* 섹션들 */}
      {draft.sections.map((sec, sIdx) => {
        const c = pal(sIdx);
        const imgs = imgMap[sec.id] || [];
        return (
          <div key={sec.id} className="card" style={{ marginBottom: 12, borderTop: `3px solid ${c.bar}` }}>
            <div className="card-header" style={{ display: 'flex', gap: 8, alignItems: 'center', background: c.bg }}>
              <input
                style={{ ...inp, fontWeight: 700, fontSize: 14, textAlign: 'center', background: '#fff', maxWidth: 320 }}
                value={sec.title} onChange={e => updateSection(sec.id, { title: e.target.value })} />
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                <button className="btn btn-outline btn-sm" title="위로" onClick={() => moveSection(sec.id, -1)}>▲</button>
                <button className="btn btn-outline btn-sm" title="아래로" onClick={() => moveSection(sec.id, 1)}>▼</button>
                <button className="btn btn-outline btn-sm" style={{ color: '#d93025' }} onClick={() => removeSection(sec.id)}>섹션 삭제</button>
              </div>
            </div>
            <div className="card-body">
              {/* 행 헤더 */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr 36px', gap: 8, marginBottom: 6, fontSize: 11, color: '#888', padding: '0 2px' }}>
                <div style={{ textAlign: 'center' }}>제목</div>
                <div style={{ textAlign: 'center' }}>상세 (선택)</div>
                <div />
              </div>
              {sec.rows.map((r, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr 36px', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                  <input style={{ ...inp, fontWeight: 600, textAlign: 'center' }} value={r.title} placeholder="예: 품절 위험 12종"
                    onChange={e => updateRow(sec.id, i, { title: e.target.value })} />
                  <input style={inp} value={r.detail} placeholder="상세 설명 (비우면 제목만 표시)"
                    onChange={e => updateRow(sec.id, i, { detail: e.target.value })} />
                  <button className="btn btn-outline btn-sm" style={{ color: '#d93025' }} onClick={() => removeRow(sec.id, i)}>✕</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <button className="btn btn-outline btn-sm" onClick={() => addRow(sec.id)}>+ 행 추가</button>
                {imgs.length < 1 && (
                  <button className="btn btn-outline btn-sm" onClick={() => triggerAddImage(sec.id)}>📷 사진 추가</button>
                )}
              </div>
              {imgs.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, justifyContent: 'center' }}>
                  {imgs.map((src, i) => (
                    <div key={i} style={{ position: 'relative' }}>
                      <img src={src} alt="" style={{ width: 70, height: 70, objectFit: 'cover', borderRadius: 6, border: '1px solid #e5e7eb' }} />
                      <span onClick={() => deleteImage(sec.id, i)} style={{ position: 'absolute', top: -6, right: -6, background: 'rgba(0,0,0,.65)', color: '#fff', borderRadius: '50%', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 11 }}>✕</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <button className="btn btn-outline btn-sm" onClick={addSection}>+ 섹션 추가</button>
        <button className="btn btn-outline btn-sm" onClick={onSaveTemplate}>⭐ 이 구성을 템플릿으로 저장</button>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button className="btn btn-primary" onClick={onSave}>💾 보고서 저장</button>
        <button className="btn btn-outline" onClick={onCancel}>취소</button>
      </div>
      <div style={{ textAlign: 'center', fontSize: 11, color: '#aaa', marginTop: 8 }}>
        💡 섹션 구성(제목·순서)을 바꾼 뒤 <b>템플릿으로 저장</b>하면, 다음 <b>새 보고서</b>부터 그 틀로 시작합니다.
      </div>
    </div>
  );
}

// ===== 캘린더 =====
function CalendarView({ month, setMonth, index, onOpen }) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const byDate = useMemo(() => {
    const g = {};
    index.forEach(e => { if (e.reportDate?.startsWith(month)) (g[e.reportDate] ||= []).push(e); });
    return g;
  }, [index, month]);

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const shift = (delta) => {
    const nm = new Date(y, m - 1 + delta, 1);
    setMonth(`${nm.getFullYear()}-${pad2(nm.getMonth() + 1)}`);
  };

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16 }}>
        <button className="btn btn-outline btn-sm" onClick={() => shift(-1)}>‹</button>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>{y}년 {m}월</h2>
        <button className="btn btn-outline btn-sm" onClick={() => shift(1)}>›</button>
      </div>
      <div className="card-body">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
          {WEEKDAY_KR.map((w, i) => (
            <div key={w} style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: i === 0 ? '#d93025' : i === 6 ? '#2563eb' : '#555', padding: '4px 0' }}>{w}</div>
          ))}
          {cells.map((d, i) => {
            const dateStr = d ? `${month}-${pad2(d)}` : null;
            const reps = dateStr ? byDate[dateStr] : null;
            return (
              <div key={i} style={{ minHeight: 64, border: '1px solid #eef2f7', borderRadius: 8, padding: 4, background: reps ? '#eff6ff' : '#fff', textAlign: 'center' }}>
                {d && <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>{d}</div>}
                {reps && reps.map(r => (
                  <div key={r.id} onClick={() => onOpen(r.id)}
                    style={{ marginTop: 3, background: '#2563eb', color: '#fff', borderRadius: 5, fontSize: 10, padding: '2px 3px', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={r.title}>📄 보고</div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
