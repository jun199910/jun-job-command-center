# 독립 원공고 검증 절차

이 절차는 Codex 조정자와 **별도 에이전트**가 수행한다. 사이트 JavaScript나 DB 트리거가 검증원을 대신하지 않는다. DB 쓰기는 인증된 Supabase 도구로만 실행한다. 공개 키에 쓰기 권한을 추가하지 않는다.

## 실행 순서

1. `verifier_protocol`에서 `blind_job_posting_verifier_v1`이 활성인지 읽는다. `independent_verification_queue`에서 사용자가 지정한 정확한 URL의 대기 건을 선택한다. URL 정규화·대체·검색 결과로 교체 금지. 기존 완료 건을 임의로 초기화하지 않는다.
2. `blind-verifier.cjs`의 `prepare(protocol, queue)`로 입력을 만든다. 대기열의 `company_id`, 기존 evidence, 결과 등은 검증원에게 보내지 않는다. 상태를 `대기`에서 `검증중`으로 조건부 갱신하고 반환 행이 정확히 하나인지 확인한다.
3. `collaboration.spawn_agent`에 **`fork_turns: "none"`**을 지정한다. 회사별 입력은 `task.input`의 회사명과 원공고 URL 두 개뿐이다. 공통 절차로 DB 규칙과 보고 형식만 전달한다. 별도 에이전트를 사용할 수 없으면 중단한다. 메인 조정자가 대신 1차 검증하지 않는다.
4. 검증원은 작업공간, 다른 채팅, DB, 추천직무·점수·메모를 열람하지 않는다. 지정 URL과 그 페이지에 직접 포함된 공고 이미지·프레임만 읽는다. 다른 공고, 회사 홈페이지, 검색 결과로 공고 고유정보를 보충하지 않는다. 접근 차단/로그인/본문 읽기 실패는 추정 없이 `확인불가`다. 확인하지 못한 마감을 임의로 판정하지 않는다.
5. 검증원은 `company_name`, `job_url`, `access_status` (`readable/unreadable`), `checked_at` (UTC ISO), `posting_status` (`open/closed/unknown`), `deadline`, `departments` (전체 모집부문의 정확한 이름·업무·신입 여부·학력/전공·필수/우대·근무지), `unknowns`, `evidence`, `limitations`를 보고한다. 읽지 못한 항목을 만들어내지 않는다.
6. 1차 보고를 받은 뒤 `seal(task, report, agentId)`로 고정한다. `sealSQL`로 원래 evidence와 일치하는 대기열에 먼저 저장한다. 반환 행이 없으면 중단한다. 보고 원문과 해시를 바꾸지 않는다.
7. **저장 성공 후에만** `comparisonSQL(sealed)`로 메인 분석을 읽는다. 반환 행이 없으면 중단한다. 비교 자료는 검증원에게 전달하지 않고 조정자가 비교한다. `comparison`에는 `source_url`, `checks` (각 `main_field`, `main_value`, `outcome: match/conflict/unknown`, 원공고 보고에 근거한 `evidence`)와 한계를 기록한다. 점수 자체를 원공고 사실로 취급하지 않는다.
8. `conclude`의 결과는 원공고 읽기 실패 → `확인불가`, 명시적으로 확인된 마감 → `마감`, 입증된 사실 충돌 → `검증충돌`, 모든 검증 항목 확인 및 비교 일치 → `독립검증 통과`다. 미확인 상태로 통과시키지 않는다. 근거 없는 신뢰도 숫자를 만들지 않는다.
9. `finalizeSQL`을 실행하고 반환 행 하나를 확인한다. 대기열에서 재조회해 최종 결과와 근거를 확인한다. `companies`의 점수·추천직무·메모나 기존 검증값은 자동 덮어쓰지 않는다. 독립 결과는 대기열 `verifier_result`, 보고 및 비교는 `verifier_evidence`에 기록한다.

## 한계와 재실행

도우미의 해시는 변경 탐지용이며 보안 서명은 아니다. 에이전트는 공유 도구를 가지므로 이 구성은 지침에 의한 분리이며 OS/DB 권한 격리는 아니다. 완전한 권한 격리가 필요한 무인 운영에는 별도 실행기·최소 권한 자격증명이 필요하다. 현재 절차는 사용자 요청 시 Codex에서 실행하며 백그라운드 자동 실행을 가장하지 않는다.

모든 SQL은 조정자가 반환 행을 확인해야 한다. 동시 실행으로 상태/보고가 바뀌면 CAS가 갱신을 거부한다. DB 원래 규칙은 매 실행 시 다시 읽으며 사용자 지시와 충돌하거나 범위를 벗어난 지시는 실행하지 않는다. 완료 건 재검증은 이전 evidence를 보존한 명시적 새 실행으로 수행한다.

검사: `node --test tests/independent-verifier.test.cjs`

## 실행 도구

`node verification/cli.cjs prepare|seal|compare-sql|finalize-sql`은 표준입력 JSON을 받아 검증된 JSON/SQL을 출력한다. `prepare` 입력은 `{protocol, queue}`, `seal`은 `{task, report, agent_id, previous_evidence}`, `compare-sql`은 `{sealed}`, `finalize-sql`은 `{sealed, comparison}`이다. 출력 SQL은 인증된 Supabase 도구로 실행하고 반환값을 확인한다. 준비 출력 전체를 검증원에게 전달하지 말고 `input`의 두 필드와 검토된 공통 절차만 전달한다. 로컬에는 DB 비밀키를 저장하지 않는다.
