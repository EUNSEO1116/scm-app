# DB 터짐 해결 기록 (2026-06-26)

## 한 줄 요약
이슈관리·상품개선 사진을 **단일 블롭 → 바코드/항목별 개별 저장**으로 전환하여 Vercel 4.5MB 한도 초과로 인한 데이터 소실을 해결하고, 활동로그 스냅샷에서 **37바코드 / 55장**을 복구함.

---

## 1. 무슨 일이 일어났나 (증상)
- 발주신청에서 복사 버튼을 눌러도 사진 알림이 안 떴다.
- 특별관리(이슈관리)에 사진이 있다고 배지 숫자는 뜨는데, 눌러보면 사진이 하나도 안 보였다.
- 배지 개수(`issue_img_counts`)는 32개로 남아있는데 실제 사진 데이터(`issue_img_data`)는 텅 빈 `{}` 상태였다.

## 2. 진짜 원인 (Root Cause)
- **단일 블롭 저장 구조의 한계.** 모든 바코드의 사진을 `issue_img_data` 하나의 키에 통째로 모아 저장했다.
- 사진이 쌓이자 이 블롭이 **Vercel 서버리스 함수의 요청/응답 본문 4.5MB 한도**를 넘겼다.
- 한도를 넘으면 프록시(`api/proxy.js`)에서 저장/조회가 깨진다.
- 저장 방식이 **read-modify-write**(전체를 읽어 일부 수정 후 전체를 다시 씀)였기 때문에, 읽기가 실패해 빈 객체가 되면 그 빈 객체로 **전체를 덮어써서 모든 사진이 한 번에 소실**됐다. (파괴적 구조)

## 3. 해결책 — 개별 저장으로 전환
사진을 한 덩어리가 아니라 **항목 단위로 쪼개서** 저장한다. 각 요청이 작아져 4.5MB 한도를 넘지 않는다.

- **이슈관리 사진:** `issue_img_<바코드소문자>` — 바코드별 개별 키에 저장.
  - 배지 개수만 담는 `issue_img_counts`는 숫자라 작으므로 단일 블롭 유지.
- **상품개선 사진:** `imp_img_<itemId>` — 항목별 개별 키에 저장.
  - 기존 `improvement_images` 블롭은 첫 로드 시 일회성 마이그레이션(`imp_img_migrated` 플래그)으로 개별 저장소로 이전.
  - 인라인 썸네일/UI는 그대로 유지(옵션 A).

### 중요 제약 — 대문자 바코드 주의
- 서버의 store 이름 검증은 **소문자만 허용**한다: `/^[a-z][a-z0-9_]*$/`
- 바코드는 `S`로 시작(대문자)하므로, **데이터 키는 반드시 `.toLowerCase()`** 처리해야 한다.
- 단, 개수 배지 맵(`issue_img_counts`)의 키는 원본 바코드(대문자)를 그대로 사용한다.

## 4. 같이 잡은 버그 — 삭제했는데 썸네일 숫자가 1로 남던 문제
- 원인: 로드 시 레거시 블롭(`improvement_images`)으로 **보강(fallback)**하면서, 이미 삭제한 항목이 되살아났다.
- 수정: 개별 저장소를 **권위 소스**로 삼고, DB에서 받아온 게 **하나도 없을 때만**(`!dbHadAny`, 전송 장애 등) 로컬 백업으로 폴백하도록 변경.

## 5. 사진 복구 (Recovery)
- 활동로그(`activity_log`)에는 변경 전/후 JSON 스냅샷(`before_data`/`after_data`)이 남아있었다.
  - `issue_img_data`는 SKIP_LOG 대상이 아니어서 **로그가 남아있었고 → 복구 가능**했다.
- 서버에 복구 엔드포인트 추가: `GET /api/recover-issue-images`
  - 모든 스냅샷을 훑어 **바코드별로 사진이 가장 많은 버전을 합집합**으로 모아 복원.
  - 복원 결과를 `issue_img_<바코드소문자>` 개별 저장소에 기록하고 `issue_img_counts`도 갱신.
- **복구 결과: 37바코드 / 55장 복원 성공.** (예: 바코드 S0034994685760에 실제 JPEG 3장 복원 확인)

## 6. 배포 중 겪은 함정 — pkill 자살
- 서버 재시작 시 `ssh root@... "pkill -f server.js; ... nohup node server.js ..."` 처럼 한 줄 SSH 명령에 `pkill -f server.js`를 넣으면,
  그 SSH 세션의 셸 명령줄에도 "server.js"가 들어있어 **pkill이 자기 셸까지 죽여버린다.**
  → 옛 서버는 죽고 새 서버는 안 켜져 **서버가 다운**됨(HTTP 000).
- 올바른 재시작: pkill 없이 켜기만 한다.
  ```
  ssh root@158.247.239.161 "cd /root/scm-api && nohup node server.js > /dev/null 2>&1 & sleep 2; echo done"
  ```
  또는 포트 기준 종료(`fuser -k 3100/tcp`) 사용.

## 7. 수정한 파일
- `src/pages/IssueManagement.jsx` — `openImgModal`, `saveImages`, `handleDownloadAllImages` 개별 저장으로 전환
- `src/pages/OrderRequest.jsx` — `showPhotosAfterCopy` 바코드별 병렬 조회로 전환
- `src/pages/ProductImprovement.jsx` — `persistImpImages`/`dbSaveAllImpImages` 항목별 저장 + 일회성 마이그레이션
- `server.js` — `GET /api/recover-issue-images` 복구 엔드포인트 추가

## 8. 앞으로 주의할 점
- 새 store 이름 추가 시: 서버 검증 정규식(소문자) 통과 확인 → 필요 시 SQLite 테이블 생성 → 서버 재시작.
- 사진처럼 커질 수 있는 데이터는 **절대 단일 블롭에 모으지 말 것**(4.5MB 한도). 항목별 개별 키로 저장.
- read-modify-write로 전체를 덮어쓰는 구조는 읽기 실패 시 데이터 전체를 날릴 수 있으니 지양.
