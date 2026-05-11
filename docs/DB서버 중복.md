# DB 서버 중복 문제 (2026-05-04)

## 문제 요약
상품개선 기능에서 새 항목 추가 시 DB에 저장되지 않아 다른 컴퓨터에서 보이지 않았음.

## 원인
Vultr 서버(158.247.239.161)의 **3100 포트를 daily-board(Next.js)가 pm2로 점유**하고 있어서, scm-api(Express DB 서버)가 시작되지 못했음.

- `daily-board`: pm2로 관리, 3100 포트 사용, 재시작 156회
- `scm-api`: nohup 방식, 3100 포트 필요 → 포트 충돌로 실행 불가

### 증상
- `node server.js` 실행 시 "SCM API server running on port 3100" 출력 후 즉시 종료
- `curl http://localhost:3100/api/store/improvement_items` → Next.js 404 HTML 반환
- 프론트엔드의 `dbStoreSet`이 전부 실패 → `.catch(() => {})`로 무시 → 로컬에만 저장됨

## 해결
1. `daily-board`의 포트를 3100이 아닌 다른 포트로 변경
2. `scm-api` Express 서버를 3100 포트로 재시작
3. 프론트엔드 코드 개선 (커밋 2cd5a28):
   - DB 저장 실패 시 3회 재시도
   - 실패 시 빨간 알림 배너 + 재시도 버튼
   - 페이지 로드 시 로컬이 DB보다 많으면 자동 동기화

## Vultr 서버 pm2 프로세스 목록
| id | name | 용도 |
|----|------|------|
| 0 | eariple-wiki | 위키 |
| 2 | daily-board | 업무일지 (포트 변경됨) |
| - | scm-api | DB API 서버 (nohup, 포트 3100) |

## 교훈
- Vultr 서버에 여러 앱이 있을 때 포트 충돌 주의
- pm2 관리 앱이 포트를 계속 재시작하면서 뺏어감
- DB 저장 실패를 `.catch(() => {})`로 무시하면 안 됨 → 재시도 + 알림 필수
