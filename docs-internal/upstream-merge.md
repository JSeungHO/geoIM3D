# 원본(GeoLibre) 업데이트 절차

geoIM3D는 [opengeos/GeoLibre](https://github.com/opengeos/GeoLibre)의 포크입니다.
원본에 새 릴리스가 나오면 이 순서대로 가져옵니다.

마지막 수행: **v2.8.0 → v2.9.0 (48커밋, 228파일)**. 충돌 8개 파일 + git이
표시하지 않은 의미 충돌 1개(`CesiumCanvas.tsx`). 아래 내용은 실제로 쓴 명령과
부딪힌 문제를 적은 것입니다.

v2.9.0에서 겪은 것:

- **Cesium가 `cesium` → `@cesium/engine`, `Viewer` → `CesiumWidget`으로 바뀜.**
  `cesium-layer-sync.ts`는 충돌로 잡혀서 손으로 타입만 바꾸면 됐지만,
  `CesiumCanvas.tsx`는 **자동 병합이 조용히 성공**하면서 존재하지 않는 `Viewer`
  참조와 중복 선언된 basemap 상태를 남겼습니다. 상위 파일을 통째로 받고
  (`git checkout upstream/main -- <파일>`) 아직 필요한 `onViewerChange` 훅만 다시
  얹었습니다.
- **상위가 지구본 basemap 미러링을 흡수함.** 우리가 그걸 하려고 만든
  `CesiumLayerSync.syncBasemap` + `rasterBasemapTiles`는 이제 상위의
  `core/src/cesium-imagery.ts` + `map/src/cesium-basemap.ts`가 대신합니다.
  호출부(`CesiumCanvas`)는 지웠고, `rasterBasemapTiles`는 아직 export + 테스트가
  살아 있으니 다음 정리 때 함께 제거 후보입니다. 지역 basemap(VWorld 등)은
  상위의 `getRegionalBasemapByStyleUrl` 경로가 커버합니다.
- `bincode`, `tauri-plugin-single-instance`가 `Cargo.toml`에 추가됨 —
  `npm run check:rust`가 잠금 파일까지 확인해 줍니다.

---

## 0. 준비 (컴퓨터마다 한 번)

```bash
git remote add upstream https://github.com/opengeos/GeoLibre.git
```

원격 설정은 저장소가 아니라 **로컬 `.git/config`에 저장**됩니다. 새로 clone하거나
다른 컴퓨터에서 작업하면 다시 등록해야 합니다.

Rust 툴체인도 필요합니다 (`npm run check:rust`, `npm run tauri:dev`용):

```powershell
winget install --id Rustlang.Rustup
winget install --id Microsoft.VisualStudio.2022.BuildTools --override `
  "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Rust만 깔면 `link.exe not found`로 실패합니다. Windows에서 Rust는 MSVC 링커를
빌려 쓰기 때문에 빌드 도구가 따로 필요합니다.

---

## 1. 가져오고 규모 확인

```bash
git fetch upstream
git log --oneline $(git merge-base upstream/main HEAD)..upstream/main | wc -l
git describe --tags upstream/main
```

몇 커밋인지 먼저 봅니다. 175개까지는 반나절 안에 끝났습니다.

---

## 2. 임시 브랜치에서 시험 병합 ← 가장 중요

```bash
git checkout -b trial/upstream dev
git merge upstream/main --no-commit --no-ff
git diff --name-only --diff-filter=U        # 충돌 파일
```

**`dev`에서 바로 병합하지 마세요.** 감당이 안 되면 `git merge --abort` 후 임시
브랜치만 지우면 되고, `dev`는 손대지 않은 상태로 남습니다.

작업 트리가 깨끗해야 병합이 시작됩니다. 커밋 안 된 변경이 있으면 먼저
`git stash` 하세요.

---

## 3. 충돌 해결

이 포크의 충돌은 거의 전부 **"양쪽이 각자 추가"** 이지 "같은 곳을 서로 다르게
고침"이 아닙니다. 그렇게 설계했기 때문입니다 — 원본 파일에는 덧붙이기만 하고,
로직은 우리 파일에 둡니다. 그래서 기본 해법은 **양쪽 다 살리기**입니다.

부딪힌 패턴들:

| 상황                                                 | 하는 일                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DesktopShell.tsx` — 상위가 우리 래퍼 *안쪽*을 바꿈  | **상위 하위 트리를 통째로 받고 `<PrimaryGlobeSwitch>`만 다시 씌우기.** 그 컴포넌트가 존재하는 이유가 이것입니다                                                                                                                                                                                                  |
| `README.md`                                          | 우리 것 유지: `git checkout --ours README.md`. 우리 README는 수정이 아니라 **교체**라 상위 변경이 적용되지 않습니다                                                                                                                                                                                              |
| 버전만 충돌 (`Cargo.toml`, `tauri.conf.json`)        | 우리 것 유지. 단, **`--ours`를 쓰기 전에 상위가 그 파일에서 버전 말고 뭘 더 바꿨는지 반드시 확인**하세요: `git diff $(git merge-base v<태그> dev)..v<태그> -- <파일>`                                                                                                                                            |
| `apps/geolibre-desktop/package.json`                 | 버전만 우리 것. **`--ours`를 쓰면 안 됩니다** — v2.7.0 병합에서 상위가 같은 파일에서 의존성 15개를 올렸고, `--ours`가 그걸 통째로 버렸습니다. `git checkout v<태그> -- <파일>` 후 버전 한 줄만 되돌리세요                                                                                                        |
| `Cargo.lock`                                         | 충돌 덩어리(보통 버전 한 줄)만 손으로 고치세요. `--ours`는 상위의 크레이트 갱신을 전부 날립니다                                                                                                                                                                                                                  |
| `Cargo.toml`, `.gitignore` 등 목록형                 | 양쪽 항목 모두 넣기                                                                                                                                                                                                                                                                                              |
| 같은 TOML 섹션 헤더가 양쪽에                         | **하나로 합치기.** `[target."cfg(target_os = \"windows\")".dependencies]`가 두 번 나오면 중복 키로 파싱이 깨집니다                                                                                                                                                                                               |
| `PluginsMenu.tsx` — 상위가 우리와 비슷한 패턴을 추가 | 두 분기를 **나란히** 두기. 상위 코드를 우리 레지스트리로 바꾸면 다음 병합이 더 나빠집니다                                                                                                                                                                                                                        |
| **상위가 우리 기능을 흡수함**                        | 우리 코드를 **지우고** 상위 것을 받으세요. v2.8.0에서 `AiSectionContent.tsx`가 그랬습니다 — 상위가 Ollama 실제 모델 목록 조회를 직접 구현해서, 그걸 하려고 만든 `use-ollama-models` 훅과 `ollama-models.ts`, 그 테스트까지 129줄을 삭제했습니다. 원칙 5가 실제로 회수된 사례입니다                               |
| **상위 테스트가 우리가 바꾼 기본값을 단언**          | 리터럴 대신 **상수를 읽게** 고치세요. v2.8.0이 시작 카메라 설정을 추가하며 `[-100, 40]` / `zoom 2`를 단언했는데, 포크는 서울·줌 11입니다. `tests/startup-project-settings.test.ts`가 이제 `DEFAULT_MAP_CENTER` / `DEFAULT_MAP_ZOOM`을 import합니다 — 값을 다시 적지 않으니 상위가 그 파일을 또 고쳐도 병합됩니다 |
| `TopToolbar.tsx` — 상위가 로직을 개선                | **상위 로직 + 우리 값**. 예: 앱 제목의 `isMobile()` 판정은 받고 이름만 geoIM3D로                                                                                                                                                                                                                                 |

해결 후:

```bash
git add <해결한 파일들>
git diff --name-only --diff-filter=U     # 비어 있어야 함
```

---

## 4. 검증 (순서대로)

```bash
npm install            # 상위가 의존성을 바꿨을 수 있음
npm run build
npm run test:frontend
npm run check:rust
```

`package-lock.json`이 충돌하면 상위 것을 받고 다시 설치하는 편이 빠릅니다:

```bash
git checkout upstream/main -- package-lock.json && npm install
```

---

## 5. 확정

```bash
git commit                                    # 병합 커밋
git checkout dev
git merge --ff-only trial/upstream
git branch -d trial/upstream
git push                                      # gitlab/dev
```

---

## 병합 때마다 확인할 것

`CLAUDE.md`가 경고하는 **거울값(mirrored constants)** 들입니다. 원본이 의존성을
올리면 **조용히** 어긋납니다 — 빌드는 통과하고 동작만 틀립니다.

- **`geolibre-wasm` 버전이 바뀌었으면** `node scripts/gen-whitebox-menu-catalog.mjs`를
  실행하고 결과를 커밋합니다. 안 하면 새 도구가 Processing *메뉴*에서만 조용히
  빠집니다 (다이얼로그에는 나오므로 눈에 잘 안 띕니다).
- `MAX_VECTOR_PMTILES_ZOOM`, `MAX_VECTOR_BYTES`, `MAP_PANEL_SELECTOR`,
  `propertySpecFor` — 대부분 `npm run test:frontend`가 잡아줍니다. 그래서
  프런트 테스트는 병합 후 반드시 돌립니다.
- **`Cargo.lock`** — `Cargo.toml`에 의존성을 추가했으면 `cargo check`를 한 번
  돌려 잠금 파일에 반영합니다. 실제로 `keyring`이 몇 달간 빠져 있었고, cargo를
  한 번도 못 돌린 게 원인이었습니다.
- **`maplibre-gl-splat` 버전이 바뀌었으면** `npm run test:frontend`가
  `tests/geoim3d-object-scene.test.ts`로 잡아줍니다. 3D 객체의 위치 변경은
  라이브러리의 **비공개 필드**(`_splatLayers` / `_modelLayers`)를 통해 씬 그래프에
  직접 씁니다 — 그래야 매번 파일을 다시 언팩하지 않고, 그 재언팩이 실제로
  `RangeError: Array buffer allocation failed`를 냈습니다. 이름이 바뀌면 예전
  재로드 경로로 자동 폴백하므로 **기능은 살아 있지만 그 버그가 돌아옵니다**.
  같은 파일의 `scenePosition`은 `@dvt3d/maplibre-three-plugin`의
  `lngLatToVector3`를 옮겨온 거울값이고, 테스트가 실물과 대조합니다.
- **`backend/geolibre_server/uv.lock`** — 그 `pyproject.toml`을 건드렸다면
  `uv lock --project backend/geolibre_server`. 어긋나면 데스크톱 설치본에서
  사이드카가 exit 2로 죽습니다.

### 포맷은 oxfmt

```bash
npx oxfmt <파일들>
```

**`prettier`를 쓰지 마세요.** 이 저장소에는 prettier 설정이 없어서 기본값
80칸으로 떨어지고(`.oxfmtrc.json`은 100), 손대지 않아야 할 줄까지 다시 감쌉니다.
한 번 이 실수로 커밋 하나가 실제 변경 60줄인데 +453줄로 부풀었습니다. 포크에서
다시 감긴 줄은 전부 **다음 병합의 충돌 후보**입니다.

---

## 충돌을 줄이는 원칙

병합 비용은 "원본 파일을 몇 줄 고쳤나"에 정비례합니다. 새 파일은 아무리 많아도
충돌하지 않습니다. 그래서:

1. **로직은 우리 파일에.** 원본 파일에는 호출 한 줄, 래퍼 태그, export만 남깁니다.
   - `AiSectionContent`가 유일하게 원본 *로직*을 고친 곳이었고, 훅으로 빼서 없앴습니다.
2. **데이터 주도 레지스트리.** `plugin-menu-groups.ts`에 id 한 줄을 더하면 메뉴에
   들어갑니다 — 3D 객체 플러그인을 추가할 때 원본 파일은 한 줄도 안 건드렸습니다.
3. **i18n은 구독으로.** `i18n/geoim3d-plugin-labels.ts`가 `languageChanged`를
   직접 구독합니다. 예전에는 `TopToolbar` 안에 ~140줄이 있었고 플러그인마다
   커졌습니다.
4. **CSS·번역은 별도 파일.** `styles/geoim3d.css`, `i18n/locales-geoim3d/`.
   `index.css`와 `locales/*.json`은 원본과 바이트 단위로 같습니다.
5. **범용 기능은 원본에 PR.** `packages/map/src/cesium-layer-sync.ts`의 3D 돌출
   (+85줄)은 우리만 쓰는 기능이 아닙니다. 원본에 들어가면 우리 diff에서 사라지고
   유지보수도 넘어갑니다. 포크에서 코드를 없애는 가장 확실한 방법입니다.

현재 상태 (v2.7.0 기준): 원본 파일 **63개** 수정 = 브랜딩 아이콘 22개 + 텍스트
41개. v2.5.0 때의 30개에서 늘어난 것은 병렬 브랜치 병합(`PrimaryGlobeSwitch`,
Cesium 돌출, `AssistantPanel`, `diagnostics`)과 Cesium 작업 때문입니다.

가장 큰 항목은 `packages/map/src/cesium-layer-sync.ts` (+242/-6)입니다. 이 안의
3D 돌출과 래스터 배경지도 재생은 우리만 쓰는 기능이 아니므로 **원본 PR 후보 1순위**
입니다 (아래 원칙 5).

규모를 다시 재려면:

```bash
git diff --numstat upstream/main -- . | while read a d f; do
  git cat-file -e upstream/main:"$f" 2>/dev/null && echo -e "$a\t$d\t$f"
done | sort -rn
```

`git cat-file -e upstream/main:<파일>`이 성공하는 것만 원본에 있던 파일입니다.
새로 추가한 파일(50여 개)은 충돌하지 않으므로 이 집계에서 뺍니다.

### CLAUDE.md는 건드리지 않습니다

원본과 바이트 단위로 같은 상태입니다. 이 문서를 가리키는 한 줄을 넣고 싶더라도
넣지 마세요 — 원본이 자주 고치는 파일이라 한 줄이 그대로 충돌 지점이 됩니다.
같은 이유로 `index.css`와 `i18n/locales/*.json`도 원본 그대로 둡니다.
