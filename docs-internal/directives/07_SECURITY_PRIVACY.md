# 보안·개인정보 Directive

## Credential 저장

| 환경 | 정책 |
| ------------------------------- | ----------------------------------------------------- |
| Windows Desktop | Windows 사용자별 geoIM3D App 전역 OS Credential Store |
| Web/PWA | Memory-only. Reload/Browser 종료 시 폐기 |
| Project/Plugin State | 저장·Import 주입 금지 |
| Local/Session Storage·IndexedDB | 저장 금지 |
| 공개 Runtime Env·Build Bundle | 관리 대상 Credential 노출 금지 |
| 로그/Diagnostics/Error | 값과 값에서 파생된 정보 저장·표시 금지 |
| URL/Query String | 사용 금지 |

대상 Credential:

- Share Token
- Cesium Ion Token
- VWorld API Key
- OpenAI API Key
- Anthropic API Key
- Gemini API Key
- AI Provider Credential
- Geocoder Provider API Key
- 기타 외부 Service Token
- Google Maps, Mapillary, Protomaps, TomTom, HERE, Amazon Location Credential

필수 동작:

- Frontend와 Rust/Tauri Command는 동일한 고정 Credential ID Allowlist를 사용한다.
- Project/Public Runtime Sanitizer는 중앙 Credential Environment Alias Allowlist를 사용한다.
- Vite는 일반 `VITE_*`/`TAURI_*` Client 자동 노출을 금지하고 검토된 비Credential Public 변수만 명시적으로 허용한다.
- 공개 Core/External Plugin API는 Credential Getter나 전체 Overlay Setter를 제공하지 않는다.
- Built-in Consumer는 Desktop Host의 write-only Setter를 통해 필요한 Service Credential만 주입받는다.
- 기존 `localStorage` Credential은 값을 읽어 OS Store로 Migration하지 않고 즉시 제거하며 사용자가 다시 입력한다.
- 저장된 Credential은 Settings Input에 다시 채우지 않고 설정 여부만 표시한다.
- 빈 입력은 삭제가 아니다. 새 값 입력 시에만 교체하고 삭제는 명시적 개별 삭제 동작으로 수행한다.
- 긴급 대응을 위한 전체 Credential 폐기를 제공하며 사용자 확인 후 실행한다.
- Project Open/Recent/URL/Deep Link에서 관리 대상 Environment Variable과 `geocoding.apiKeys`를 제거하고 Device Store를 덮어쓰지 않는다.
- Diagnostics와 Error에는 Credential 값, 길이, Prefix/Suffix, 마지막 문자, Hash/Fingerprint를 포함하지 않는다. 설정 여부와 비민감 오류 Code만 허용한다.

Ollama/로컬 모델 Endpoint는 비밀이 아닐 수 있지만 기존 Credential Policy와 같은 Settings 계층으로 관리한다.

## AI 데이터 전송

허용 Provider:

- OpenAI
- Anthropic
- Gemini
- Ollama/Local Model

지도·도면·BIM 데이터를 외부 AI로 전송할 수 있다. 단, 실행 전에 다음을 명시한다.

- 선택된 Provider
- 전송 데이터 종류와 범위
- 파일 또는 Feature 수/크기
- 외부 전송 여부

사용자 승인 없이 Background에서 업로드하지 않는다.

## Plugin

- 사용자가 ZIP/URL Plugin을 설치할 수 있다.
- 자동 설치·자동 활성화 금지
- 출처, Version, Manifest, Trust 상태 표시
- Plugin 오류와 권한을 App 전체에서 격리
- Credential API는 Plugin에 기본 제공하지 않음

## 수집 금지

- Telemetry
- Crash Report 자동 전송
- 사용 통계
- 사용자 Project/경로/좌표의 외부 분석 전송

## 유지할 보안 경계

- Sidecar Token
- Trusted Host/CORS
- Conversion Root
- Archive/Path Traversal 방어
- Tauri CSP/Capability Allowlist
- HTML Sanitization
- External Plugin Trust Prompt
- AI Code Execution 승인
