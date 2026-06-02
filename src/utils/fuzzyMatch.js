/**
 * 상품명+옵션명 유사도 매칭 유틸리티
 * - 공백, 쉼표, 특수문자 정규화
 * - 옵션명 토큰 순서 무관 비교
 * - 유사도 점수 기반 매칭
 */

// 텍스트 정규화: 공백·쉼표·특수문자 제거, 소문자화
function normalize(str) {
  return String(str || '')
    .replace(/\s+/g, '')        // 공백 제거
    .replace(/[,./·\-_()[\]{}'"!@#$%^&*+=|\\<>?~`]/g, '') // 특수문자 제거
    .toLowerCase();
}

// 옵션명을 토큰으로 분리 (쉼표, 공백, /, + 등 기준)
function tokenize(str) {
  return String(str || '')
    .split(/[\s,/+·\-_]+/)
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length > 0)
    .sort();
}

// 두 문자열의 유사도 (0~1), 정규화된 문자열 기준 LCS 비율
function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;

  // 짧은 쪽이 긴 쪽에 포함되면 높은 점수
  if (na.includes(nb) || nb.includes(na)) {
    return Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  }

  // LCS (Longest Common Subsequence) 비율
  const lenA = na.length;
  const lenB = nb.length;
  const dp = Array.from({ length: lenA + 1 }, () => new Array(lenB + 1).fill(0));
  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      dp[i][j] = na[i - 1] === nb[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const lcsLen = dp[lenA][lenB];
  return (2 * lcsLen) / (lenA + lenB);
}

// 옵션명 토큰 기반 유사도: 순서 무관, 각 토큰의 최고 매칭을 합산
function optionSimilarity(a, b) {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.length === 0 && tokensB.length === 0) return 1;
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  // 정규화 문자열 완전일치 시 바로 1
  if (normalize(a) === normalize(b)) return 1;

  // 각 토큰A에 대해 토큰B에서 가장 유사한 것을 매칭
  let totalScore = 0;
  const usedB = new Set();
  for (const tA of tokensA) {
    let bestScore = 0;
    let bestIdx = -1;
    for (let j = 0; j < tokensB.length; j++) {
      if (usedB.has(j)) continue;
      const s = similarity(tA, tokensB[j]);
      if (s > bestScore) { bestScore = s; bestIdx = j; }
    }
    if (bestIdx >= 0) usedB.add(bestIdx);
    totalScore += bestScore;
  }

  // 토큰 수 차이 페널티 포함
  const maxTokens = Math.max(tokensA.length, tokensB.length);
  return totalScore / maxTokens;
}

/**
 * 주문목록 항목을 매칭 대상 목록에서 찾기
 *
 * @param {string} orderName - 주문목록의 상품명
 * @param {string} orderOption - 주문목록의 옵션명
 * @param {Array<{name: string, option: string, key: string}>} candidates - 매칭 후보 목록
 * @param {number} threshold - 최소 유사도 (기본 0.85)
 * @returns {{ key: string, score: number } | null} 매칭 결과
 */
export function findBestMatch(orderName, orderOption, candidates, threshold = 0.85) {
  let bestMatch = null;
  let bestScore = 0;

  for (const cand of candidates) {
    const nameSim = similarity(orderName, cand.name);
    if (nameSim < 0.7) continue; // 상품명이 너무 다르면 스킵

    const optSim = optionSimilarity(orderOption, cand.option);

    // 종합 점수: 상품명 40%, 옵션명 60% (옵션명이 더 세분화되므로 가중치 높음)
    const score = nameSim * 0.4 + optSim * 0.6;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = { key: cand.key, score };
    }
  }

  return bestScore >= threshold ? bestMatch : null;
}

/**
 * nameToSkuMap 또는 orderMap의 키("상품명||옵션명")를 candidates 배열로 변환
 */
export function buildCandidates(map) {
  return Object.keys(map).map(key => {
    const [name, option] = key.split('||');
    return { name: name || '', option: option || '', key };
  });
}
