# Codex Git 및 작업 Workflow

## Branch

`main` 직접 수정 금지. 예:

```text
feat/geoim3d-brand-foundation
feat/vworld-plugin
feat/geoim3d-project-extension
chore/windows-identity
```

## Agent 권한

Codex는 다음을 수행할 수 있다.

- 보안과 무관한 Source 수정
- npm/pip/cargo Dependency 추가
- Branch/Commit/PR 생성
- Test/Build/Package 실행
- 관련 문서 수정

보안, Credential, License, 비호환 Schema/API, 데이터 Migration은 계획 승인 후 진행한다.

## 작업 순서

1. 요구사항과 가까운 `AGENTS.md` 읽기
2. 결합 지점과 Test 감사
3. Baseline 기록
4. 작은 구현 계획 작성
5. RED Test 또는 Contract 추가
6. 구현
7. 관련 Test
8. 필수 Gate
9. Windows 실제 검증
10. Commit/PR과 증거 보고

## 기존 실패

- 기존 실패는 작업 전 재현하고 목록화한다.
- 기존 실패를 숨기거나 Test를 삭제·Skip하여 통과시키지 않는다.
- 변경으로 새 실패가 생기면 작업 완료로 보고하지 않는다.

## Dependency

승인은 필요 없지만 PR에 다음을 기록한다.

- 목적
- 대안
- License
- 보안·Bundle·설치 크기 영향
- Lockfile 변경

## 문서

모든 변경에 CHANGELOG는 필수가 아니다. 다음은 문서화한다.

- 사용자 동작 변경
- 보안/개인정보 변경
- Project/Plugin 호환 변경
- 새 Settings/Environment Variable
- Packaging/Release 변경
