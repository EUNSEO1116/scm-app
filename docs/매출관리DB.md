# 매출관리 DB

## 메모 기능

### 개요
매출관리 테이블에서 상품별로 메모를 입력하고, 호버 시 확인할 수 있는 기능.
Vultr DB에 저장되어 모든 기기에서 동일하게 조회 가능.

### 저장 구조
- **Store 이름:** `sales_memos`
- **데이터 형식:** `{ [barcode]: "메모 내용" }`
- **Vultr DB 테이블:** `sales_memos (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT)`

### API
| Method | URL | 설명 |
|--------|-----|------|
| GET | /api/store/sales_memos | 전체 메모 조회 |
| POST | /api/store/sales_memos | 메모 저장 (전체 덮어쓰기) |

### 프론트엔드
- **파일:** `src/pages/Sales.jsx`
- **DB 호출:** `dbStoreGet('sales_memos')`, `dbStoreSet('sales_memos', data)`
- **상태:** `memos` (barcode → 메모 텍스트 맵)

### UI 동작
| 동작 | 설명 |
|------|------|
| 아이콘 클릭 | 인라인 입력창 열림 |
| Enter / 포커스 해제 | 메모 저장 |
| Esc | 입력 취소 |
| 호버 (메모 있을 때) | 셀 오른쪽에 말풍선 툴팁 표시 |

### 아이콘 표시
- 메모 없음: ✏️ (반투명)
- 메모 있음: 📝

---

## Vultr 서버 설정 (2026-04-13)
- `VALID_STORES` 배열에 `'sales_memos'` 추가
- SQLite 테이블 수동 생성 완료
- 서버 재시작 완료
