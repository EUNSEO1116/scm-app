import { useState, useEffect, useRef } from 'react';
import { loadTutorials, saveTutorials, loadStepImages, saveStepImages, resizeImage } from '../tutorials/tutorialStore';
import { pageGroups, keyToLabel, allPages } from '../tutorials/pageRegistry';

const ACCENT = '#1e8e3e';
const imgId = (pageKey, stepId) => `${pageKey}::${stepId}`;

// 도움말(튜토리얼) 관리 — 모든 페이지의 스텝 문구·순서·사진을 편집해 DB에 저장.
export default function HelpAdmin() {
  const [content, setContent] = useState(null);        // { [pageKey]: { title, steps } }
  const [sel, setSel] = useState(allPages[0]?.key || '');
  const [imgs, setImgs] = useState({});                // { 'pageKey::stepId': base64[] }
  const [dirty, setDirty] = useState(() => new Set()); // 변경된 이미지 키
  const [loadedPages, setLoadedPages] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const fileRef = useRef({});

  useEffect(() => { loadTutorials().then(setContent); }, []);

  // 선택 페이지 엔트리 보장 + 이미지 로드(한 번만)
  useEffect(() => {
    if (!content || !sel) return;
    if (!content[sel]) {
      setContent(c => ({ ...c, [sel]: { title: keyToLabel[sel] || sel, steps: [] } }));
      return;
    }
    if (loadedPages.has(sel)) return;
    const steps = content[sel].steps || [];
    Promise.all(steps.map(s => loadStepImages(sel, s.id).then(a => [imgId(sel, s.id), a])))
      .then(pairs => {
        setImgs(m => ({ ...m, ...Object.fromEntries(pairs) }));
        setLoadedPages(p => new Set(p).add(sel));
      });
  }, [content, sel, loadedPages]);

  if (!content) return <div className="card"><div className="loading"><div className="spinner" /></div></div>;

  const page = content[sel] || { title: keyToLabel[sel] || sel, steps: [] };
  const steps = page.steps || [];
  const hasContent = (k) => (content[k]?.steps?.length || 0) > 0;

  const updatePage = (patch) => setContent(c => ({ ...c, [sel]: { ...c[sel], ...patch } }));
  const updateStep = (idx, patch) => updatePage({ steps: steps.map((s, i) => i === idx ? { ...s, ...patch } : s) });
  const moveStep = (idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[idx], next[j]] = [next[j], next[idx]];
    updatePage({ steps: next });
  };
  const deleteStep = (idx) => { if (confirm('이 스텝을 삭제할까요?')) updatePage({ steps: steps.filter((_, i) => i !== idx) }); };
  const addStep = () => updatePage({ steps: [...steps, { id: `s_${Date.now()}`, title: '새 스텝', body: '' }] });

  const setStepImgs = (stepId, arr) => {
    const key = imgId(sel, stepId);
    setImgs(m => ({ ...m, [key]: arr }));
    setDirty(d => new Set(d).add(key));
  };
  const addImages = async (stepId, files) => {
    const arr = [...(imgs[imgId(sel, stepId)] || [])];
    for (const f of files) { try { arr.push(await resizeImage(f)); } catch { /* skip */ } }
    setStepImgs(stepId, arr);
  };
  const removeImage = (stepId, i) => setStepImgs(stepId, (imgs[imgId(sel, stepId)] || []).filter((_, k) => k !== i));

  const handleSave = async () => {
    setSaving(true); setMsg('');
    // 콘텐츠: 스텝이 있는 페이지만 저장(DB 경량화)
    const toSave = Object.fromEntries(Object.entries(content).filter(([, v]) => v.steps?.length));
    const okContent = await saveTutorials(toSave);
    // 이미지: 변경된 것만 저장
    const dirtyKeys = [...dirty];
    const imgResults = await Promise.all(dirtyKeys.map(k => {
      const [pk, sid] = k.split('::');
      return saveStepImages(pk, sid, imgs[k] || []);
    }));
    setSaving(false);
    if (okContent && imgResults.every(Boolean)) { setDirty(new Set()); setMsg('저장 완료'); }
    else setMsg('저장 일부 실패 — 다시 시도해 주세요');
    setTimeout(() => setMsg(''), 3000);
  };

  const input = { width: '100%', padding: '9px 11px', border: '1px solid #dadce0', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' };
  const lbl = { fontSize: 12, fontWeight: 700, color: '#5f6368', display: 'block', marginBottom: 5 };

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, padding: '18px 22px', borderBottom: '1px solid #ececec' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 19 }}>도움말 관리</h2>
          <div style={{ fontSize: 12.5, color: '#80868b', marginTop: 3 }}>페이지별 튜토리얼 문구·순서·사진을 편집합니다. 저장하면 모든 기기에 공유됩니다.</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {msg && <span style={{ fontSize: 13, fontWeight: 700, color: msg.includes('완료') ? ACCENT : '#c5221f' }}>{msg}</span>}
          {dirty.size > 0 && <span style={{ fontSize: 12, color: '#b06000' }}>미저장 변경 {dirty.size}</span>}
          <button onClick={handleSave} disabled={saving}
            style={{ padding: '10px 22px', borderRadius: 9, border: 'none', background: ACCENT, color: '#fff', fontSize: 13.5, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1, boxShadow: '0 1px 3px rgba(30,142,62,0.3)' }}>
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch' }}>
        {/* 좌측: 페이지 목록 */}
        <aside style={{ width: 256, flexShrink: 0, borderRight: '1px solid #ececec', background: '#fafafa', padding: '14px 10px', maxHeight: '72vh', overflowY: 'auto' }}>
          {pageGroups.map(g => (
            <div key={g.group} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#9aa0a6', letterSpacing: 0.5, padding: '0 8px 6px' }}>{g.group}</div>
              {g.pages.map(p => {
                const active = p.key === sel;
                const done = hasContent(p.key);
                return (
                  <button key={p.key} onClick={() => setSel(p.key)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 2, borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: active ? 700 : 500,
                      background: active ? '#e6f4ea' : 'transparent', color: active ? ACCENT : '#3c4043' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: done ? ACCENT : 'transparent', border: done ? 'none' : '1.5px solid #c0c0c0' }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </aside>

        {/* 우측: 편집 */}
        <section style={{ flex: 1, minWidth: 320, padding: '20px 22px', maxHeight: '72vh', overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
            <h3 style={{ margin: 0, fontSize: 17 }}>{keyToLabel[sel] || sel}</h3>
            <code style={{ fontSize: 11.5, color: '#80868b' }}>{allPages.find(p => p.key === sel)?.path}</code>
          </div>
          <div style={{ fontSize: 12, color: '#80868b', marginBottom: 18 }}>
            {steps.length === 0 ? '아직 튜토리얼이 없습니다. 아래에서 스텝을 추가해 시작하세요.' : `${steps.length}개 스텝`}
          </div>

          <div style={{ marginBottom: 20, maxWidth: 440 }}>
            <label style={lbl}>튜토리얼 제목 (말풍선 상단에 표시)</label>
            <input value={page.title || ''} onChange={e => updatePage({ title: e.target.value })} style={input} />
          </div>

          {steps.map((s, idx) => {
            const key = imgId(sel, s.id);
            const list = imgs[key] || [];
            return (
              <div key={s.id} style={{ border: '1px solid #e8e8e8', borderRadius: 12, padding: 16, marginBottom: 14, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: '50%', background: '#e6f4ea', color: ACCENT, fontSize: 12, fontWeight: 800 }}>{idx + 1}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => moveStep(idx, -1)} disabled={idx === 0} title="위로"
                      style={{ border: '1px solid #dadce0', background: '#fff', borderRadius: 6, padding: '4px 9px', cursor: idx === 0 ? 'default' : 'pointer', opacity: idx === 0 ? 0.35 : 1 }}>▲</button>
                    <button onClick={() => moveStep(idx, 1)} disabled={idx === steps.length - 1} title="아래로"
                      style={{ border: '1px solid #dadce0', background: '#fff', borderRadius: 6, padding: '4px 9px', cursor: idx === steps.length - 1 ? 'default' : 'pointer', opacity: idx === steps.length - 1 ? 0.35 : 1 }}>▼</button>
                    <button onClick={() => deleteStep(idx)} title="삭제"
                      style={{ border: '1px solid #f3c1bd', background: '#fff', color: '#c5221f', borderRadius: 6, padding: '4px 11px', cursor: 'pointer', fontWeight: 600 }}>삭제</button>
                  </div>
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label style={lbl}>제목</label>
                  <input value={s.title || ''} onChange={e => updateStep(idx, { title: e.target.value })} style={input} />
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label style={lbl}>설명</label>
                  <textarea value={s.body || ''} onChange={e => updateStep(idx, { body: e.target.value })} rows={4}
                    style={{ ...input, lineHeight: 1.6, resize: 'vertical' }} />
                </div>

                <div style={{ fontSize: 11.5, color: '#9aa0a6', marginBottom: 12 }}>
                  {s.target ? <>🎯 스포트라이트: <code>{s.target}</code></> : '💬 화면 가운데 안내'}
                  {s.table && <> · 📊 표 미리보기 포함</>}
                </div>

                <label style={lbl}>사진 <span style={{ fontWeight: 400, color: '#9aa0a6' }}>(선택 시 800px 자동 압축)</span></label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
                  {list.map((src, i) => (
                    <div key={i} style={{ position: 'relative' }}>
                      <img src={src} alt="" style={{ width: 88, height: 88, objectFit: 'cover', borderRadius: 8, border: '1px solid #e0e0e0' }} />
                      <span onClick={() => removeImage(s.id, i)}
                        style={{ position: 'absolute', top: 3, right: 3, background: 'rgba(0,0,0,0.6)', color: '#fff', borderRadius: '50%', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 11 }}>✕</span>
                    </div>
                  ))}
                  <button onClick={() => fileRef.current[s.id]?.click()}
                    style={{ width: 88, height: 88, border: '1.5px dashed #b8b8b8', borderRadius: 8, background: '#fafafa', color: '#80868b', fontSize: 26, cursor: 'pointer' }}>+</button>
                  <input ref={el => (fileRef.current[s.id] = el)} type="file" accept="image/*" multiple
                    onChange={e => { addImages(s.id, [...e.target.files]); e.target.value = ''; }} style={{ display: 'none' }} />
                </div>
              </div>
            );
          })}

          <button onClick={addStep}
            style={{ width: '100%', padding: '12px', borderRadius: 10, border: `1.5px dashed ${ACCENT}`, background: '#f6faf7', color: ACCENT, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', marginTop: 4 }}>
            + 스텝 추가
          </button>
        </section>
      </div>
    </div>
  );
}
