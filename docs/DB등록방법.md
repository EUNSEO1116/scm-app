# DB 등록 방법 (Vultr SQLite)

새로운 기능에 DB 저장이 필요할 때 아래 순서대로 진행한다.

## 서버 정보

- Vultr 서버: `158.247.239.161`
- DB 경로: `/root/scm-api/scm.db` (SQLite)
- 서버 코드: `/root/scm-api/server.js`
- 프론트 프록시: `api/proxy.js` → Vultr `158.247.239.161:3100`

## 1단계: SSH 접속

```bash
ssh root@158.247.239.161
cd /root/scm-api
```

## 2단계: 테이블 생성

```bash
sqlite3 scm.db "CREATE TABLE IF NOT EXISTS [테이블명] (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT);"
```

예시 (상품개선):
```bash
sqlite3 scm.db "CREATE TABLE IF NOT EXISTS improvement_items (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT);"
sqlite3 scm.db "CREATE TABLE IF NOT EXISTS improvement_images (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT);"
```

테이블 생성 확인:
```bash
sqlite3 scm.db ".tables"
```

## 3단계: VALID_STORES에 추가

```bash
nano /root/scm-api/server.js
```

`VALID_STORES` 배열에 새 테이블명 추가:
```js
const VALID_STORES = [...기존항목, 'improvement_items', 'improvement_images'];
```

저장: `Ctrl+O` → `Enter` → `Ctrl+X`

## 4단계: 서버 재시작

```bash
ps aux | grep node
kill [PID번호]
nohup node /root/scm-api/server.js &
```

재시작 확인:
```bash
ps aux | grep node
```

node 프로세스가 1개만 실행 중이면 완료.

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
| improvement_items | 상품개선 항목 |
| improvement_images | 상품개선 사진 |
