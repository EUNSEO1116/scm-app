# DB 등록 방법 (Vultr SQLite)

새로운 기능에 DB 저장이 필요할 때 아래 순서대로 진행한다.

## 서버 정보

- Vultr 서버: `158.247.239.161`
- DB 경로: `/root/scm-api/scm.db` (SQLite)
- 서버 코드: `/root/scm-api/server.js`
- 프론트 프록시: `api/proxy.js` → Vultr `158.247.239.161:3100`

## 1단계: 로컬 server.js 수정

`/scm-app/server.js` 에서 아래 2가지 수정:

1. `db.exec()` 블록에 CREATE TABLE 추가:
```sql
CREATE TABLE IF NOT EXISTS [테이블명] (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

2. `VALID_STORES` 배열에 테이블명 추가:
```js
const VALID_STORES = [...기존항목, '테이블명'];
```

## 2단계: PowerShell에서 Vultr에 파일 복사

```powershell
scp C:\Users\Edit\Desktop\scm-app\server.js root@158.247.239.161:~/scm-api/server.js
```
비밀번호 입력 (Vultr 대시보드 → 서버 Overview에서 확인)

## 3단계: PowerShell에서 서버 재시작

```powershell
ssh root@158.247.239.161 "kill $(pgrep -f 'node /root/scm-api/server.js'); cd ~/scm-api && nohup node server.js > /dev/null 2>&1 & sleep 2 && curl http://localhost:3100/api/store/[테이블명]"
```

`{"data":null}` 나오면 성공.

## 참고: 테이블 확인

```powershell
ssh root@158.247.239.161 "sqlite3 ~/scm-api/scm.db '.tables'"
```

## 참고: 자동 테이블 생성

server.js에 자동 테이블 생성 로직이 있어서, VALID_STORES에만 추가하면 첫 접근 시 테이블이 자동 생성됨. 수동으로 sqlite3 명령어를 실행할 필요 없음.

## 프론트엔드 연동

`dbStoreSet` / `dbStoreGet` 으로 사용 (추가 코드 수정 불필요):
```js
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

// 저장
await dbStoreSet('improvement_items', data);

// 조회
const data = await dbStoreGet('improvement_items');
```

## 현재 등록된 테이블 목록

| 테이블명 | 용도 |
|---------|------|
| sales_memos | 매출관리 메모 |
| fbc_savings | FBC 절감 |
| soldout_history | 품절 이력 |
| soldout_exclude | 품절 제외 |
| soldout_rate | 품절률 |
| soldout_reasons | 품절 사유 |
| new_product_stock | 신규 상품 재고 |
| orderbook_notes | 발주 메모 |
| supplies_orders | 부자재 주문 |
| caution_items | 주의 품목 |
| calendar_events | 캘린더 이벤트 |
| issue_img_data | 이슈관리 사진 |
| issue_img_counts | 이슈관리 사진 수 |
| issue_special_items | 특별관리 품목 |
| soldout_reasons_obj | 품절 사유 (전체 객체) |
| improvement_items | 상품개선 항목 |
| improvement_images | 상품개선 사진 |
