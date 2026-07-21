# DB 서버 다운 에러 (fetch failed / 500)

## 발생일: 2026-07-21

## 증상 (다음에 이게 뜨면 이 문서)

- 품절분석 등에서 **데이터 업로드 시 "DB 저장 중 오류가 발생했습니다"** 토스트
- 브라우저 F12 → Network 탭에서 실패한 `store/...` 요청:
  - **Status `500`**
  - 응답 본문: `{"error":"proxy error","message":"fetch failed"}`
- 업로드뿐 아니라 **DB를 쓰는 기능 대부분이 동시에 안 됨** (캘린더 저장, 발주 메모 등)

> 핵심: `fetch failed` = Vercel 프록시(`api/proxy.js`)가 **Vultr 백엔드 서버(158.247.239.161:3100)에 접속 자체를 못 함** = 백엔드가 죽어있음.
> (참고: `413`이면 파일 용량 초과, `400`이면 서버가 store 이름 거부 — 이번 건과 다름)

## 근본 원인

- **Vultr 서버(OS)가 재부팅됨.** `uptime`이 방금 부팅된 값(예: `up 7:16`)이면 확정.
- 이 서버의 node API는 **nohup**으로만 떠 있어서 **재부팅되면 자동으로 안 켜진다.**
- 결과: 새벽에 재부팅 → API 죽은 채 방치 → 아침에 업로드하면 500.

### 이번에 배제된 원인 (참고)
- 디스크: `df -h` → `/dev/vda2 21G/52G, 43%` → **용량 부족 아님**
- 메모리: `free -h` → available 1.1Gi, **Swap 0 사용** → **OOM 아님**
- ⚠️ **"용량 다 차서" 죽은 게 아님.** 순수 재부팅 문제였음.

## 즉시 조치 (복구 순서)

Windows **PowerShell**에서:

```powershell
ssh root@158.247.239.161
```
(비밀번호: Vultr 대시보드 → 서버 Overview)

접속 후 SSH 세션 안에서 한 줄씩:

```bash
uptime                                        # 방금 부팅됐으면 재부팅이 원인
df -h                                         # 디스크 (43%면 정상)
free -h                                       # 메모리 (여유 있으면 정상)
pkill -f 'node /root/scm-api/server.js'       # 죽은 프로세스 잔재 정리
cd ~/scm-api && nohup node server.js > /dev/null 2>&1 &   # 재시작
curl http://localhost:3100/api/calendar       # {"events":...} 나오면 복구 완료
```

`curl`에서 JSON이 나오면 → 웹에서 업로드 재시도.

## 진단 판별표

| Network Status | 응답 | 원인 | 조치 |
|---|---|---|---|
| 500 | `fetch failed` | 백엔드 서버 다운(재부팅 등) | 위 "즉시 조치"로 재시작 |
| 413 | (요청 큼) | 파일 하나가 4.5MB 초과 | `api/proxy` 한도 문제 — 청크 분할 필요 |
| 400 | `invalid store name` | 배포 서버가 store 이름 거부 | server.js 배포/재시작 |

## 재발 방지 (아직 미적용 — 결정 시 진행)

현재 nohup 방식은 "죽으면 끝 + 재부팅 시 자동 복구 없음"이라 같은 사건이 또 발생함.
근본 방지책은 **부팅 시 자동 실행 + 크래시 시 자동 재시작**:

```bash
# pm2 전환 예시 (SSH 안에서)
npm install -g pm2
pm2 start ~/scm-api/server.js --name scm-api
pm2 save
pm2 startup        # 출력되는 명령을 복사해 한 번 더 실행 → 부팅 자동 등록
```

적용하면 재부팅/크래시돼도 API가 자동 복구되어 이 문서가 필요 없어짐.
※ 문서상 기본 운영 방침은 nohup이라, pm2 전환은 사장님 확인 후 진행.

## 로그가 없어서 겪은 불편 (개선 참고)

현재 실행 명령이 `> /dev/null 2>&1`라 **크래시 순간 에러가 하나도 안 남는다.**
다음처럼 로그를 남기면 원인 추적이 쉬워짐:
```bash
cd ~/scm-api && nohup node server.js > ~/scm-api/server.log 2>&1 &
```

## 관련 파일
- `api/proxy.js` — Vercel → Vultr 프록시 (여기서 500 `proxy error` 반환)
- `src/utils/dbApi.js` — `dbStoreSet`/`dbStoreGet` (실패 시 false → 토스트)
- `src/pages/SoldOutAnalysisUpload.jsx` — 품절분석 업로드
- `docs/DB.md` 112~122행 — Vultr 서버 재시작 절차(nohup)
