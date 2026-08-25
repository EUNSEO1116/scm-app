// 튜토리얼 콘텐츠·이미지 DB 연동 (Vultr DB, /api/proxy 경유)
// - 본문/구조: store 'tutorial_content' 한 곳에 JSON(텍스트)로 저장
// - 이미지    : 스텝별 개별 저장소 'help_img_<pageKey>_<stepId>' 에 base64 배열(4.5MB 한도 회피)
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';
import { tutorials as defaultTutorials } from './tutorialContent';

const CONTENT_KEY = 'tutorial_content';
const imgKey = (pageKey, stepId) => `help_img_${pageKey}_${stepId}`;

const clone = (o) => JSON.parse(JSON.stringify(o));

// 전체 튜토리얼 로드. DB가 비어있으면 번들 기본값을 반환(시드 전 상태 대비).
export async function loadTutorials() {
  const db = await dbStoreGet(CONTENT_KEY);
  if (db && typeof db === 'object' && Object.keys(db).length > 0) {
    // 코드가 새로 추가한 페이지(기본값엔 있는데 DB엔 없는 것)는 병합해 노출
    const merged = clone(db);
    for (const k of Object.keys(defaultTutorials)) {
      if (!merged[k]) merged[k] = clone(defaultTutorials[k]);
    }
    return merged;
  }
  return clone(defaultTutorials);
}

// 특정 페이지만 로드 (HelpButton용)
export async function loadPageTutorial(pageKey) {
  const all = await loadTutorials();
  return all[pageKey] || null;
}

export async function saveTutorials(all) {
  return dbStoreSet(CONTENT_KEY, all, { logDesc: '도움말(튜토리얼) 수정' });
}

// 스텝 이미지 (base64 배열)
export async function loadStepImages(pageKey, stepId) {
  const imgs = await dbStoreGet(imgKey(pageKey, stepId));
  return Array.isArray(imgs) ? imgs : [];
}

export async function saveStepImages(pageKey, stepId, images) {
  return dbStoreSet(imgKey(pageKey, stepId), images || [], { logDesc: '도움말 이미지 수정' });
}

// 파일 → 800px 이내 JPEG(0.7) base64 로 축소 (상품개선과 동일 규격)
export function resizeImage(file, maxDim = 800) {
  return new Promise((resolve, reject) => {
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
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
