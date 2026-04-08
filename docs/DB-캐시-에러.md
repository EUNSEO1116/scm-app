# DB 캐시 덮어쓰기 에러

## 발생일: 2026-04-08

## 문제 요약
FBC 계산기(`FbcCalculator.jsx`)에서 절감 기록 저장 시, localStorage가 비어있으면 DB 데이터를 통째로 덮어써서 기존 기록이 소멸되는 버그.

## 피해
- FBC 절감 대시보드 기록 12건 소멸 (2026-04-07 저장분)
- 오늘(4/8) 저장한 1건만 남음

## 원인

### 저장 흐름 (수정 전)
```
localStorage에서 읽기('fbc_savings_history')
→ 비어있으면 [] 에서 시작
→ 새 데이터 추가
→ localStorage + DB에 저장
→ DB가 [새 데이터만]으로 덮어써짐
→ 기존 기록 전부 소멸
```

### localStorage가 비게 된 경로
발주장부 "답변 일괄입력" 버튼이 안 보이는 문제 → 캐시 삭제 안내 → localStorage 삭제됨 → 이후 FBC 계산기에서 저장 시 DB 덮어쓰기 발생

### 근본 원인
- `Dashboard.jsx`에는 DB 선 로드 `useEffect`가 있었지만, 같은 `fbc_savings` 데이터를 저장하는 `FbcCalculator.jsx`에는 빠져있었음
- 발주장부 버튼이 안 보였던 건 Vercel-GitHub 연동(webhook)이 끊어져 있어서 `git push`가 자동 배포를 트리거하지 못했기 때문

## 수정 내용

### 1. FbcCalculator.jsx - DB 선 로드 추가 (커밋 872e0ff)
```jsx
// 수정 전: DB 로드 없이 localStorage만 사용
const history = JSON.parse(localStorage.getItem('fbc_savings_history') || '[]');

// 수정 후: 컴포넌트 마운트 시 DB에서 먼저 로드
useEffect(() => {
  dbStoreGet('fbc_savings').then(data => {
    if (data && Array.isArray(data) && data.length > 0) {
      const local = JSON.parse(localStorage.getItem('fbc_savings_history') || '[]');
      if (local.length < data.length) {
        localStorage.setItem('fbc_savings_history', JSON.stringify(data));
      }
    }
  }).catch(() => {});
}, []);
```

### 2. Vercel-GitHub 연동 재연결
- Vercel 대시보드 > Settings > Git > GitHub Install & Connect
- 이후 `git push` 시 자동 배포 정상화

## 다른 페이지 점검 결과

| 페이지 | DB 키 | DB 선 로드 | 상태 |
|--------|-------|-----------|------|
| 발주장부 (OrderBook) | `orderbook_notes` | 있음 | 안전 |
| 부자재관리 (SuppliesOrder) | `supplies_orders` | 있음 | 안전 |
| 이슈관리 (IssueManagement) | `issue_special_items`, `issue_img_data`, `issue_img_counts` | 있음 | 안전 |
| 품절관리 (SoldOut) | `new_product_stock` | 있음 | 안전 |
| 품절율 (SoldOutRate) | `soldout_rate` | 있음 | 안전 |
| 품절제외 (SoldOutExclude) | `soldout_exclude` | 있음 | 안전 |
| FBC 대시보드 (Dashboard) | `fbc_savings` | 있음 | 안전 |
| **FBC 계산기 (FbcCalculator)** | `fbc_savings` | **없었음 → 추가** | **수정됨** |

## 교훈
- DB를 사용하는 모든 페이지에 DB 선 로드 로직 필수
- 같은 DB 키를 여러 페이지에서 쓸 때 양쪽 다 로드 로직 확인
- 캐시 삭제 안내 전에 배포 상태부터 확인할 것
