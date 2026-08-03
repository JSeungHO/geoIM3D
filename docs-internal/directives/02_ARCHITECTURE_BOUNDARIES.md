# 아키텍처 경계

## 유지할 계층

```text
UI / Add Data / Plugin / File
            ↓
    @geolibre/core Store
            ↓
         MapCanvas
            ↓
       MapController
            ↓
MapLibre / deck.gl / Cesium
```

## 모듈 책임

- App: Brand, Feature Profile, Window/Shell, File Dialog, Credential Adapter
- Core: Domain Type, Store, Project Schema, Migration
- Map: 2D/3D Rendering과 Layer Sync
- Plugins: VWorld와 확장 기능
- Processing: Browser/WASM/Sidecar Algorithm
- Sidecar: 무거운 Python 처리와 제한된 로컬 파일 접근
- Tauri: OS Credential, File Association, Packaging, Native I/O

## geoIM3D 전용 구현

- VWorld: Built-in Plugin
- Brand Token/Metadata: App 중앙 Config
- `.geoim3d.json`: App File I/O + Core Serializer Contract
- Feature 숨김: UI Profile/Feature Flag
- Windows Credential: Tauri Command/Plugin Adapter
- 국내 업무 기능: 독립 Plugin 또는 작은 Domain Package 우선

## 대형 파일 관리

다음 파일에 기능을 직접 누적하지 않는다.

- `DesktopShell.tsx`
- `LayerPanel.tsx`
- `StylePanel.tsx`
- `MapCanvas.tsx`
- `map-controller.ts`
- `layer-sync.ts`
- `store.ts`
- `src-tauri/src/lib.rs`

새 기능은 Service, Hook, Adapter, Store Slice, Plugin으로 분리하고 중앙 파일은 Composition만 담당하게 한다.
