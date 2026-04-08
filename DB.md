# DB - 작업 기록

## 2026-04-07

### DB화 작업 (Google Apps Script + localStorage → Vultr SQLite)

#### 서버 구성
- **서버**: Vultr Cloud Compute (Ubuntu 22.04, Seoul, $2/mo)
- **IP**: 158.247.239.161
- **API 포트**: 3100
- **기술스택**: Node.js v22 + Express + SQLite (better-sqlite3)
- **프로세스 관리**: PM2 (자동 재시작)
- **DB 파일**: /root/scm-api/scm.db

#### 생성된 테이블
| 테이블 | 용도 | 이전 방식 |
|--------|------|----------|
| soldout_reasons | 품절 사유 | Apps Script → 스프레드시트 |
| caution_items | 주의 품목 | Apps Script → 스프레드시트 |
| calendar_events | 캘린더 이벤트 | Apps Script → 스프레드시트 |
| fbc_savings | FBC 절감 내역 | localStorage |
| soldout_history | 품절 히스토리 | localStorage |
| soldout_exclude | 품절 제외 항목 | localStorage |
| new_product_stock | 신규상품 재고 추적 | localStorage |
| orderbook_notes | 발주장부 메모 | localStorage |
| supplies_orders | 부자재 발주 | localStorage |
| issue_special_items | 이슈 특별관리 | localStorage |
| soldout_rate | 품절률 데이터 | localStorage |

#### API 엔드포인트
| Method | URL | 설명 |
|--------|-----|------|
| GET | /api/soldout/reasons | 품절 사유 전체 조회 |
| POST | /api/soldout/reasons | 품절 사유 저장 |
| DELETE | /api/soldout/reasons/:barcode | 품절 사유 삭제 |
| GET | /api/caution | 주의 품목 조회 |
| POST | /api/caution | 주의 품목 추가 |
| DELETE | /api/caution/:barcode | 주의 품목 삭제 |
| GET | /api/calendar | 캘린더 이벤트 조회 |
| POST | /api/calendar | 캘린더 이벤트 저장 |
| GET | /api/store/:name | 범용 저장소 조회 |
| POST | /api/store/:name | 범용 저장소 저장 |

#### 수정된 프론트엔드 파일
| 파일 | 변경 내용 |
|------|----------|
| src/utils/dbApi.js | **신규** - Vultr DB API 호출 유틸리티 |
| src/sheetSync.js | Apps Script → DB API로 전환 |
| src/pages/Home.jsx | 캘린더 저장/읽기 DB 연동 |
| src/pages/Dashboard.jsx | FBC 절감 내역 DB 동기화 |
| src/pages/FbcCalculator.jsx | FBC 계산 결과 DB 저장 |
| src/pages/OrderBook.jsx | 발주장부 메모 DB 동기화 |
| src/pages/SuppliesOrder.jsx | 부자재 발주 DB 동기화 |
| src/pages/IssueManagement.jsx | 이슈 특별관리 DB 동기화 |
| src/pages/SoldOut.jsx | 신규상품 재고 추적 DB 저장 |
| src/pages/SoldOutRate.jsx | 품절률 스냅샷 DB 동기화 |
| src/pages/SoldOutExclude.jsx | 품절 제외 항목 DB 동기화 |
| src/pages/SoldOutHistory.jsx | 품절 제외 항목 DB 동기화 |

#### 데이터 흐름
```
읽기: Google Sheets CSV/TSV → 프론트엔드 (변경 없음)
쓰기: 프론트엔드 → Vultr API (port 3100) → SQLite DB
캐시: localStorage는 오프라인 캐시로 유지
```

---
