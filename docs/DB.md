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

## 2026-04-17

### 품절 사유/이력 DB 원툴 전환

#### 배경
품절 사유(`soldout_reasons_v2`)와 품절 이력(`soldout_history`)이 localStorage에만 저장되어 A/B 컴퓨터 간 데이터가 달랐음. 다른 데이터들은 이미 DB화 완료된 상태에서 이 두 키만 빠져있었음.

#### 생성된 테이블
| 테이블 | 용도 | 이전 방식 |
|--------|------|----------|
| soldout_reasons_obj | 품절 사유 전체 객체 | localStorage (soldout_reasons_v2) |

※ `soldout_history` 테이블은 기존에 이미 존재 (범용 스토어로 활용)

#### server.js 변경
| 항목 | 변경 내용 |
|------|----------|
| VALID_STORES | `soldout_reasons_obj` 추가 |
| 범용 스토어 POST/GET | 자동 테이블 생성 try-catch 추가 (테이블 없으면 자동 생성) |

#### 수정된 프론트엔드 파일
| 파일 | 변경 내용 |
|------|----------|
| SoldOut.jsx | `saveSoldoutReasons` → DB 저장 추가, `saveSoldoutHistory` → DB 저장 추가, 초기 로드 시 DB 우선 읽기, 재진입 삭제 시 DB 동기화, `fetchReasons` useEffect 제거 |
| SoldOutHistory.jsx | `saveHistory` → DB 저장 추가, `saveReasons` → DB 저장 추가, 초기 로드 시 DB 제네릭 스토어 우선 읽기 |

#### 마이그레이션 로직
- 제네릭 스토어(`soldout_reasons_obj`)에 데이터 없으면 → dedicated API(`/soldout/reasons`)에서 읽어서 자동 마이그레이션
- 마이그레이션 후에는 제네릭 스토어가 source of truth

#### 재진입 품절 처리 변경
- 기존: localStorage에서만 사유 삭제 (DB 유지 → 다른 컴퓨터에서 복원됨)
- 변경: localStorage + DB 제네릭 스토어 + dedicated API 전부 삭제

---

## DB 규칙

### 범용 스토어(store) 규칙
- **화이트리스트 없음**: `VALID_STORES` 배열 방식 제거함. 이름 형식만 검증 (`/^[a-z][a-z0-9_]*$/`)
- **새 store 추가 시 서버 수정 불필요**: `dbStoreGet`/`dbStoreSet`에 새 키를 쓰면 자동으로 테이블 생성됨
- **키 이름 규칙**: 영소문자로 시작, 영소문자+숫자+언더스코어만 사용 (예: `issue_img_data`, `dashboard_history_2026`)

### Vultr 서버 수정 절차
1. **로컬에서 `server.js` 수정** (Claude Code 또는 에디터)
2. **PowerShell에서 scp 업로드**: `scp C:\Users\Edit\Desktop\scm-app\server.js root@158.247.239.161:/root/scm-api/server.js`
3. **SSH 접속**: `ssh root@158.247.239.161`
4. **프로세스 확인**: `ps aux | grep server`
5. **재시작**: `kill [PID]` 후 `cd ~/scm-api && nohup node server.js > /dev/null 2>&1 &`

⚠️ **주의사항**
- 프로세스 관리는 **pm2가 아닌 nohup** 방식임
- SSH 안에서 sed/node -e 같은 인라인 수정 명령 사용 금지 (PowerShell 이스케이프 깨짐)
- 반드시 로컬 수정 → scp 업로드 순서로 진행

---
