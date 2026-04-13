# 매출관리 CSS

## 테이블 레이아웃

### 컬럼 너비 고정
- `table-layout: fixed` + `<colgroup>` 퍼센트 너비로 필터 변경 시에도 컬럼 간격 유지
- 클래스: `.sales-table`

### 컬럼 비율
| 컬럼 | 비율 |
|------|------|
| 상태 | 5.5% |
| 메모 | 3% |
| 바코드 | 8% |
| 상품명 | 22% |
| 옵션명 | 12% |
| 총재고 | 5% |
| 6일전~1일전 | 각 5% |
| 합계 | 5% |
| 리뷰(6일) | 5.5% |
| 추세 | 4% |

---

## 메모 기능 CSS

### 메모 아이콘 셀
- 클래스: `.memo-cell`
- `position: relative` (툴팁 기준점)
- `text-align: center`, `padding: 8px 4px`

### 메모 호버 툴팁
- 클래스: `.memo-tooltip`
- 위치: 셀 오른쪽 (`left: 100%`, `transform: translateY(-50%)`)
- `white-space: nowrap` — 한줄로 표시
- 배경: `#333`, 글자: `#fff`, `font-size: 12px`
- `opacity: 0` → `.memo-cell:hover .memo-tooltip`에서 `opacity: 1`
- `pointer-events: none` — 마우스 이벤트 무시
- `z-index: 100` — 다른 셀 위에 표시

### 메모 입력창
- `width: 120px`, `border: 1.5px solid #1a73e8`
- Enter로 저장, Esc로 취소, 포커스 해제 시 저장
