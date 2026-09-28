# JUN Job Command Center V2

## 현재 동작
- 동일한 대시보드 안에서 회사 후보, 검증상태, 지원 파이프라인, 오늘 할 일, 결정 기록 관리
- 브라우저 localStorage 자동 저장
- JSON 백업/복원
- 초기 데이터: 에피텍, 하이멕, 인투알, 라이팩, 인터전기

## '같은 URL 새로고침 = 최신 정보'로 만들기 위한 다음 연결
현재 파일만으로는 ChatGPT 대화가 브라우저 localStorage를 직접 수정할 수 없습니다.
진짜 동기화형 V2는 다음 3개가 추가되어야 합니다.

1. 호스팅: GitHub Pages / Vercel 등
2. 공유 DB: Supabase / Firebase 등
3. ChatGPT가 안전하게 읽고 쓸 수 있는 API 또는 연결 도구

그 연결이 완료되면 localStorage 대신 API fetch로 데이터를 읽고 저장하도록 교체하면 됩니다.

## 안전 원칙
- DB 비밀키(service role key)를 HTML/브라우저 코드에 넣지 말 것
- 공개 프론트엔드에는 제한된 public key만 사용
- 쓰기 권한은 인증/RLS/API를 통해 제한
