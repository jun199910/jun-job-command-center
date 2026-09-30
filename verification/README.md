# 독립 원공고 검증: 이벤트 파이프라인

기존 `verifier_protocol`, `blind_job_posting_verifier_v1`, `independent_verification_queue`, `blind-verifier.cjs`를 재사용한다. 사이트는 결과를 표시하고, 검증은 기존 Node와 로그인된 Codex CLI로 구성한 별도 실행기가 수행한다. 새 서비스·패키지·API 결제 키를 설치하지 않는다.

## 자동 실행과 변경 감지

- 회사/공고 INSERT, `job_url` 교체, `posting_instance_key` 변경(동일 URL의 별도 재공고), `posting_source_facts` 변경이 DB 트리거를 실행한다.
- `posting_source_facts`에는 원공고에서 확인한 제목·모집부문·업무·필수/우대조건·근무지·마감일 등 안정적인 객관적 사실만 저장한다. 조회 시각, 메모, 점수, HTML 광고/조회수 등은 넣지 않는다. JSON 키 순서는 해시에 영향을 주지 않는다.
- 점수·티어·메모·통근 변경은 큐를 만들지 않는다. 동일 회사 ID + 정확한 URL + 내용 SHA-256의 UNIQUE 제약으로 동시 등록과 반복 저장을 막는다. 기존 완료 결과는 초기화하지 않는다.
- `companies`의 Realtime 변경 알림을 받은 실행기가 대기열을 즉시 확인한다. 단일 실행기가 처리 중이면 다음 순서로 이어진다. 60초 복구 확인은 미처리 이벤트/만료된 임대만 조회하며 모든 회사를 재검증하지 않는다.
- 원격 채용사이트는 이 DB에 수정 이벤트를 보내지 않는다. 발견 작업이 원공고 변경을 확인해 `posting_source_facts`를 저장해야 D 유형 변경을 알 수 있다. 사이트 자체의 모든 변경을 실시간 감시한다고 주장하지 않는다.

## 신규 발굴 / 재공고 연동

기존 회사명이라고 건너뛰지 않는다. 먼저 `company_id`와 현재 `job_url`을 확인하고 아래 어댑터를 사용하거나 인증된 Supabase 작업으로 같은 필드를 저장한다.

```powershell
node verification/record-posting.cjs observation.json
```

입력 예시(실제 원공고의 확인된 사실만 사용):

```json
{"company_id":123,"company_name":"회사명","job_url":"https://원공고주소","source_facts":{"posting_title":"실제 제목","deadline":"실제 마감일"}}
```

신규 회사는 `company_id`를 생략한다. 정확한 이름이 중복되면 ID를 요구한다. URL 교체는 재공고로 표시하고 독립 검증을 다시 예약한다. 사용자에 의해 `제외`된 회사는 재공고만으로 자동 복귀시키지 않는다. 같은 URL의 새 회차는 원공고가 실제 구분하는 `posting_instance_key`를 함께 저장한다. 매 실행마다 임의 UUID/시각을 새 회차로 만들지 않는다.

## 독립성 및 봉인

1. 인증된 조정자가 활성 DB 프로토콜과 큐를 읽고 임대(20분, heartbeat)를 획득한다. claim 응답에는 회사별 자료로 회사명·정확한 URL만 있다. 큐/임대 식별자도 검증원 프롬프트에 전달하지 않는다.
2. 검증원은 매번 `codex exec --ephemeral --ignore-user-config`의 새 스레드와 빈 임시 작업 폴더에서 실행된다. shell, apps/MCP, hooks, memories, multi_agent를 비활성화하고 DB 키·프로젝트 연결 환경변수를 넘기지 않는다. 공통 규칙·JSON 형식과 회사명·URL 두 필드만 제공한다.
3. 정확한 원공고 및 거기 직접 포함된 이미지/프레임만 읽는다. 검색, 다른 공고, 회사 일반 설명으로 보충하지 않는다. 도구 추적에서 검색/shell/MCP를 발견하면 보고서를 채택하지 않는다. 추가 URL은 원공고 HTML의 img/iframe 연결로 출처를 입증해야 한다. 접근 실패는 확인불가다.
4. 구조화된 1차 보고서를 DB에 먼저 저장하고 PostgreSQL JSONB 표현의 SHA-256과 확정 시각을 기록한다. 이미 저장한 보고서는 실행기 RPC로 다시 봉인하거나 수정할 수 없다.
5. DB가 보고서와 해시를 확인한 후에만 `main` 작업이 비교용 메인 사실을 반환한다. 별도의 새 비교 컨텍스트가 봉인 보고서와 메인 사실을 받는다. 점수·티어·경력가치·통근 평가를 재평가하지 않는다.
6. 최종 상태는 DB가 결정한다. 접근 실패/핵심 사실 부족은 `확인불가`, 마감 근거는 `마감확인`, 지원판단을 바꾸는 근거 있는 차이는 `검증충돌`이다. 모든 핵심 비교가 일치하고 원공고 핵심 사실도 있어야 `독립검증 통과`가 된다. 비교자가 통과를 주장해도 빠진 사실을 통과시키지 않는다.
7. `companies`에는 검증 상태·실행 요약을 반영한다. 점수·추천직무·메모는 덮어쓰지 않는다. 마감이면 기존 마감 보관 트리거가 점수를 보관하고 현재 후보에서 제외한다. 회사 행과 과거 큐/보고서는 삭제하지 않는다. 진행 중 URL/내용이 바뀐 경우 과거 결과가 새 공고를 덮어쓰지 않는다.

프로세스/프롬프트/도구를 분리하는 구성이지 악의적 로컬 관리자까지 방어하는 보안 경계는 아니다. DB 소유자는 기록을 변경할 수 있으며 해시는 전자서명이 아니다. 비공개 worker capability는 조정자만 가진다. 공개 웹 키만으로 큐·보고서·프로토콜을 쓰거나 비교 RPC를 사용할 수 없다.

## 운영

로컬 `.verification-runtime/config.json`은 Git 제외 대상이다. `url`, `anonKey`, `workerToken`, 설치된 `codex` 경로를 저장한다. workerToken은 임의 256비트 값이며 DB에는 해시만 보관한다. 토큰·설정·전체 로컬 로그를 GitHub/사이트에 올리지 않는다.

```powershell
# 수동 실행
node verification/worker.cjs
# 숨김 창 시작
./verification/start-worker.ps1
# 현재 사용자의 로그인 시 실행 등록
./verification/install-startup.ps1
```

Windows 작업 이름은 `JUN Independent Verification Events`이다. `host-worker.ps1`은 Node 경로를 설치 시 저장하고 이미 실행 중인 실행기가 있으면 중복 실행하지 않고 기다린다. 새 로그인에서는 기존 실행기로 시작한다. PC가 켜져 있고 해당 Windows 사용자가 로그인해 있으며 네트워크와 Codex 인증/사용량이 유효해야 한다. PC가 꺼져 있는 동안에도 DB 큐는 보존되며 다음 실행에서 따라잡는다. GitHub Pages는 UI만 제공하며 검증 실행 서버가 아니다.

실행 오류는 5분 후 재시도하며 최대 3회로 제한한다. 원공고가 읽히지 않아 정상적으로 `확인불가`가 확정된 경우 무한 재검증하지 않는다. 봉인된 보고서는 재사용하고 비교만 복구한다. 봉인 직전 중단된 유효 보고서도 입력·출처·별도 스레드 증거를 다시 검증한 뒤 재사용한다. 오류가 한도에 도달하면 오류를 보존하고 사람의 점검을 기다린다.

기존 현재 후보를 1회 백필한다. 우선순위는 3일 이내 마감 → 70점 이상 → 신규후보 → 나머지 현재 후보다. 마감/제외/보관 후보는 기본 실행에서 제외하며 명시적 `includeArchived` 설정일 때 마지막 순서로 처리한다.

## UI / 검사

목록에 통과·대기·진행·충돌·확인불가·마감을 표시한다. 기존 6개 요약 카드와 상세 분석을 유지하며 검증 카드에는 대상 URL, 결과, 충돌, 검증일, 보고 확정/비교 시각을 표시한다. 계산 근거 없는 신뢰도 수치는 만들지 않는다. 기존 메인 검토 메모는 상세 분석에 보존한다. 마감 기록은 상태 필터의 `마감`에서 볼 수 있다.

```powershell
node --test tests/*.test.cjs
```

`tests/pipeline-db.sql`은 실제 Supabase에서 트리거·중복·봉인 전 접근 차단·결과 분류를 검사하고 전체 테스트 데이터를 롤백한다. 실행 흔적은 `.verification-runtime/worker.jsonl`, 개별 입력/추적/보고서/결과는 `runs/`에 남긴다. 샘플 완료는 DB의 report_sealed_at < compared_at, report_hash, 별도 agent_id, company 상태를 함께 확인해야 한다. queue row만으로 완료를 주장하지 않는다.

## 기존 수동 절차 호환

`blind-verifier.cjs`와 `cli.cjs prepare|seal|compare-sql|finalize-sql`은 기존 라이팩 테스트와 수동 사용을 위해 유지한다. 수동 검증원도 `fork_turns: none`으로 생성하며 DB 보고서 저장 전 메인 조회는 금지한다. 과거 수동 결과의 `마감` 표기는 새 자동 경로에서 `마감확인`으로 구분한다. 기존 완료 보고서는 재작성하지 않는다.
