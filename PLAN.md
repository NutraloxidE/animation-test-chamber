# Animation Test Chamber — One-Shot Implementation Plan

> このファイルを、リポジトリを実装するメインAIエージェントへそのまま渡すこと。
> 追加質問を待たず、記載された既定値で動くMVPを完成させる。

---

## 0. Mission

Animation Test Chamberは、ゲームエンジンそのものではない。

**キャラクターアニメーション、ステートマシン、トランジション、入力受付、Root Motion、地形相互作用、ハプティクスを、AIの爆速調整と人間の感覚的な微調整によって高速に仕上げるための、ブラウザファーストの実験・編集環境**である。

最重要ループは以下。

```text
AIが複数の調整案を生成
  ↓
人間がブラウザで同一条件比較
  ↓
人間がスライダー、タイムライン、グラフで微調整
  ↓
差分を検証・ステージ
  ↓
正規データへ保存
  ↓
Gitブランチへコミット／Pull Request作成
  ↓
次のAIが最新の正規データと差分を直接読む
```

人間が変更内容を文章でAIへ説明し直す工程をなくす。

---

## 1. Product principles

### 1.1 Browser first, engine optional

- 最初から最後までブラウザでゲームやプロトタイプを完成させられること。
- 必要になった段階で、正規データとアセットをUnityへ輸出し、Unity側の作業へ移行できること。
- Web RuntimeとUnity Runtimeの実装は分離する。
- ゲームデザイン上重要な数値、状態、イベント、ルールだけをエンジン非依存データとして共有する。
- Three.js固有描画、DOM、Web固有タッチUIを無理にUnityへ抽象化しない。

### 1.2 Executable specification as SSoT

包括的な`spec.md`を別管理しない。

仕様は以下を組み合わせた実行可能な状態をSingle Source of Truthとする。

- TypeScriptの型
- JSON Schema
- 正規データ
- デフォルト値
- プリセット
- UI制約
- バリデーション
- エラーメッセージ
- 自動テスト
- 入力リプレイ
- Git履歴
- Decision Record
- Web RuntimeとUnity Adapterの実行結果

Markdownには、コードから読み取れない目的、変更頻度の低い設計原則、重大な判断理由だけを残す。

### 1.3 Protect good states from vibe-coding regressions

SSoT採用の主目的は、二重編集の削減だけではない。

バイブコーディングでは、依頼していない箇所まで変更され、すでに良好だった挙動、人間が確定した値、固定したかった機能が意図せず消えることがある。

そのため本プロジェクトは、**人間が発見・確定した「良さ」を、後続AIの意図しない変更から機械的に保護すること**を重要要件とする。

保護レベルを設ける。

```text
editable           通常変更可能
approval-required  AIは提案可能だが、人間承認なしで反映禁止
locked             人間が解除するまで変更禁止
invariant          プロジェクト全体で維持すべき不変条件
```

AIは、未参照、冗長、古そう、簡潔にできる、という理由だけで設定、フォールバック、テスト、例外処理を削除してはならない。

### 1.4 Show, compare, then commit

- AI案を一つだけ採用させない。
- 原則としてA/B/Cの最大3案を作る。
- 同一入力、同一初期状態、同一地形、同一カメラ条件で比較する。
- 最終判断は人間が行う。
- 人間が変更した値は、その由来、意図、使用リプレイ、対象地形とともに保存できること。

---

## 2. Scope

### 2.1 MVPで完成させるもの

- ブラウザで動く3D Animation Test Chamber
- GLBキャラクターおよびAnimationClip読み込み
- アセットなしでも起動できるプロシージャルなテストキャラクターと簡易モーション
- Idle / Walk / Run / Jump / Fall / Land / Dodge / Attack01 / Attack02の基本ステート
- Locomotion LayerとAction Layerの2層ステートマシン
- Transition Inspector
- State Graph
- Animation Timeline
- 同一入力リプレイ
- Before / After / A-B-C比較
- WASD、マウス、一般的ゲームパッド、ジャンプ、アクションボタン
- トグル可能なスマホ用仮想パッド
- Root MotionのIn-place / Root / Hybridモード
- 地形相互作用プリセット
- 足IKおよび接地デバッグの基礎
- Generic Rumble
- Trigger Rumble capability detection
- DualSense Extended用のAdapter境界とExperimental設定画面
- 人間のブラウザ調整を正規データへ保存
- Undo / Redo / Revert / Stage / Apply
- GitHub App経由で作業ブランチへコミットし、Pull Requestを作成
- JSON Schemaと自動バリデーション
- Vitest、Playwright、リプレイ回帰テスト
- AI調整Provider interface
- 外部AIキーがなくても動くルールベース調整Fallback
- Animation Acquisition Skillの基本導線
- Unity Export Bundleと最小Unity Adapter scaffold
- ワンコマンドのHarness

### 2.2 MVPの非目標

- 完全なゲームエンジン
- AAA品質のモーション自動生成モデルの自作
- 汎用ノードエディタ
- フル機能のUnity Animator完全互換
- 高度な群衆、敵AI、クエスト、マルチプレイ
- すべてのブラウザ、OS、コントローラーで同一ハプティクスを保証すること
- Mixamoなど公開APIがないサービスの非公式API自動操作
- 著作権や利用条件が不明なアセットの自動取得

---

## 3. Fixed technical decisions

追加質問をせず、以下を既定値として実装する。

### 3.1 Stack

```text
Monorepo: pnpm workspaces
Language: TypeScript strict mode
Web: React + Vite
3D: three.js + React Three Fiber + Drei
State/UI store: Zustand
Schema: TypeBox + Ajv
Tests: Vitest + Playwright
API: Node.js + Hono
Git integration: GitHub App, Octokit
Worker contract: HTTP job API
Optional animation worker: Python + Blender headless
Formatting/lint: ESLint + Prettier
```

依存を増やす前に、標準APIまたは小さな自作実装で足りないか確認する。

### 3.2 Runtime defaults

- 右手系、Y-up、1 unit = 1 meter
- キャラクター正面は+Z
- 固定タイムステップは60Hz
- 描画フレームとゲームロジックを分離
- 初期対象はHumanoid / 二足歩行
- Canonical animation assetはGLB
- Animation metadataはJSON
- 基本画面は横画面優先、320 CSS pxまで対応
- 1プロジェクトにつきMVPでは1プレイヤーキャラクター
- Gitへの反映はmain直書き禁止
- `chamber/<project>/<session-id>`ブランチへ反映

### 3.3 Canonical time units

```text
blendDurationSec       秒
inputBufferMs          ミリ秒
cancelWindow           normalized time [0..1]
hitboxWindow           normalized time [0..1]
haptic offset          ミリ秒またはsemantic event基準
simulation             fixed 60Hz ticks
```

UIでは秒、30fpsフレーム、60fpsフレームを切り替えて表示できる。
内部表現は上記へ統一する。

---

## 4. Repository layout

```text
/
├─ README.md
├─ ARCHITECTURE.md
├─ PLAN.md
├─ DECISIONS/
├─ .env.example
├─ package.json
├─ pnpm-workspace.yaml
├─ apps/
│  ├─ web/
│  └─ api/
├─ packages/
│  ├─ schema/
│  ├─ runtime-core/
│  ├─ animation-runtime/
│  ├─ input-runtime/
│  ├─ terrain-runtime/
│  ├─ haptics-runtime/
│  ├─ replay-runtime/
│  ├─ editor-core/
│  ├─ git-adapter/
│  ├─ ai-adapter/
│  ├─ acquisition-core/
│  └─ unity-export/
├─ workers/
│  └─ animation-worker/
├─ projects/
│  └─ demo-character/
├─ presets/
│  ├─ terrain/
│  ├─ camera/
│  ├─ input/
│  └─ haptics/
├─ schemas/
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ replay/
│  ├─ visual/
│  └─ fixtures/
├─ harness/
├─ agents/
│  ├─ SYSTEM_PROMPT.md
│  ├─ SUBAGENT_POLICY.md
│  └─ skills/
├─ generated/
│  └─ unity/
└─ reports/
```

`generated/`以下は正規データではなく、再生成可能な成果物として扱う。

---

## 5. Canonical data model

TypeBoxの型定義を正本とし、そこからJSON Schemaを生成する。
UI、AI編集、API、テスト、Unity Exportは同じSchemaを参照する。

最低限、以下を定義する。

```text
ProjectDefinition
CharacterDefinition
SkeletonDefinition
AnimationClipDefinition
AnimationGraphDefinition
StateDefinition
TransitionDefinition
LayerDefinition
InputMapDefinition
MovementProfile
RootMotionProfile
TerrainInteractionProfile
CameraProfile
HapticProfile
SemanticEventDefinition
ReplayDefinition
RevisionDefinition
ProtectionMetadata
AssetProvenance
LicenseManifest
CapabilityProfile
```

すべてに`schemaVersion`と安定した`id`を持たせる。

### 5.1 Example transition

```json
{
  "schemaVersion": 1,
  "id": "run-to-attack-01",
  "from": "run",
  "to": "attack-01",
  "conditions": [
    {
      "parameter": "primaryActionPressed",
      "operator": "equals",
      "value": true
    }
  ],
  "blendDurationSec": 0.11,
  "startOffsetNormalized": 0.03,
  "momentumRetention": 0.78,
  "interruptible": false,
  "priority": 50,
  "protection": {
    "level": "approval-required",
    "reason": "human-tuned"
  }
}
```

### 5.2 Provenance

人間が確定した値は由来を保存する。

```json
{
  "source": "human-adjustment",
  "basedOnAiProposal": 0.08,
  "humanFinal": 0.11,
  "replayId": "run-attack-forward-01",
  "terrainPresetId": "flat",
  "intent": "初動を早めるが、切り替わりの硬さは残さない"
}
```

---

## 6. Input system

物理デバイスをステートマシンへ直接接続しない。
すべて共通Actionへ変換する。

```text
Move
Look
Jump
PrimaryAction
SecondaryAction
Dodge
Guard
LockOn
Interact
Pause
```

### 6.1 Supported input

- Keyboard: WASD、Space、Shift、E、Esc
- Mouse: camera look、pointer lock optional
- Standard Gamepad: left/right stick、face buttons、shoulders、triggers
- Mobile virtual pad: left stick、camera drag area、Jump、Primary、Secondary、Dodge、Guard
- 接続デバイスを実行時検出
- 最後に使用した入力デバイスに応じてボタン表記を切り替える
- キーバインドとゲームパッド割り当てを正規データとして編集可能

### 6.2 Mobile pad

- 表示／非表示トグル
- Auto mode、Always on、Always off
- 固定スティック／フローティングスティック
- 左利きレイアウト
- ボタン位置、サイズ、透明度調整
- マルチタッチ
- Safe Area対応
- 3Dカメラ操作と同時入力可能
- UI非表示録画モード

### 6.3 Input buffering

- Press、Release、Hold、Axisを区別
- タイムスタンプ付き入力イベント
- Actionごとの入力バッファ
- Coyote TimeとJump Buffer
- Cancel Window開始まで入力保持可能

---

## 7. State machine semantics

MVPは2層固定。

```text
Locomotion Layer
Idle / Walk / Run / Jump / Fall / Land / Slide

Action Layer
None / Attack01 / Attack02 / Dodge / Guard / Hit
```

### 7.1 Required semantics

- 同一Layer内で原則1 Stateのみ有効
- Layer間の合成ルールを明示
- Transition priority
- Any State相当は限定的なGlobal Interruptのみ
- Transition中の再遷移可否
- Exit condition
- Input buffer
- Cancel window
- Interruptible flag
- Forced transition
- State timeout
- Re-entry policy
- Loop policy
- Upper/lower body maskの予約構造

強制遷移の優先順は既定で以下。

```text
Death > Hit > Dodge Cancel > Guard > Action > Locomotion
```

MVPにDeath実装がなくても予約する。

### 7.2 Determinism

- 固定タイムステップで同じReplayから同じState sequenceが得られること
- 30 / 60 / 120fps描画でもロジック結果が一致すること
- 意図的なフレーム落ちを注入できること

---

## 8. Animation editor UX

### 8.1 Main layout

```text
3D Viewport
Transition Inspector
State Graph
Timeline
Replay Controls
Diff / Staging Panel
Capability Panel
AI Command Panel
```

スマホでは一画面に詰め込まず、Viewportを中心にBottom Sheetとタブで切り替える。

### 8.2 Transition Inspector

最低限、以下を即時調整できる。

- Blend duration
- Start offset
- Playback speed
- Exit time
- Interruptible
- Cancel window
- Input buffer
- Momentum retention
- Rotation authority
- Root Motion mode
- AI edit lock

変更元を表示する。

```text
Repository value
AI proposal
Human preview
Human final
```

### 8.3 State Graph

- デスクトップでは全体グラフ
- スマホでは選択State周辺だけを表示
- 到達不能State、競合Transition、無限ループを警告
- MVPでは自由配置の巨大ノードエディタにしない
- Graph編集はState追加、Transition追加、条件編集に限定

### 8.4 Timeline

トラックを持つ。

```text
Animation
Semantic Events
Hitbox
Hurtbox
Root Motion
Foot Contacts
Audio markers
VFX markers
Haptics
Adaptive Trigger
Cancel Window
```

Audio/VFX自体の制作はMVP外だが、semantic markerは持てるようにする。

### 8.5 Compare modes

- Instant A/B/C switch
- Before / After
- Split view
- Ghost overlay
- Slow motion
- Frame step
- Timeline seek
- Root trajectory overlay
- Foot trajectory overlay
- 同一入力Replay

---

## 9. Human edit → repository loop

ブラウザは正規データ用のドメイン専用IDEとして動作する。

### 9.1 Edit states

```text
Repository Value
  ↓
Preview Value
  ↓
Staged Change
  ↓
Validated Change
  ↓
Committed Change
```

### 9.2 Required actions

- Undo
- Redo
- Reset to repository
- Reset to AI proposal
- Revert selected field
- Revert session
- Stage selected
- Stage all
- Apply values
- Apply and ask AI to harmonize related transitions
- Create Pull Request

### 9.3 Git safety

- ブラウザにGitHub tokenやApp private keyを置かない
- API serverがGitHub App installation tokenを発行
- base commit SHAを必須にする
- HEADが変わっていたら上書き禁止
- フィールド単位の競合UIを出す
- main直書き禁止
- 1調整セッションを原則1コミットにまとめる
- コミットメッセージと本文を自動生成
- 人間の意図コメントを任意で保存

### 9.4 Diff policy

AI作業と人間作業の両方で、依頼範囲外の差分を検出する。

強く警告する差分。

- locked値の変更
- State / Transition削除
- Input Action削除
- Schema制約緩和
- テスト削除または期待値緩和
- Capability fallback削除
- 人間確定Preset上書き
- generatedを正本化する変更

---

## 10. Root Motion and movement

### 10.1 Modes

```text
InPlace
RootMotion
Hybrid
```

Hybridでは軸ごとの権限を設定する。

- Horizontal translation
- Vertical translation
- Rotation
- Terrain projection
- Physics authority

### 10.2 Movement parameters

- Move speed
- Acceleration
- Deceleration
- Rotation speed
- Air control
- Jump height
- Gravity
- Coyote time
- Jump buffer
- Stop behavior
- Action movement authority
- Momentum retention
- Camera-relative / world-relative movement

すべてブラウザで調整可能にする。

---

## 11. Terrain interaction

地形相互作用を主要機能として実装する。

### 11.1 Terrain presets

- Flat
- Gentle uphill/downhill
- Steep slope
- Small step
- Stairs
- Ledge
- Narrow platform
- Uneven ground
- Wall / pillar / low obstacle
- Moving platform
- Rotating platform
- Ice
- Mud
- High-friction surface

### 11.2 Adjustable parameters

- Ground probe distance
- Probe radius / shape
- Maximum walkable slope
- Slide start angle
- Step-up height
- Ground snap strength
- Downhill adhesion
- Slope speed compensation
- Body tilt
- Upper/lower body terrain alignment
- Foot IK strength
- Foot target smoothing
- Pelvis offset
- Root Motion terrain projection
- Landing thresholds
- Obstacle pushback
- Surface friction
- Moving platform velocity inheritance
- Moving platform rotation inheritance

### 11.3 Terrain states

```text
Grounded
SlopeUp
SlopeDown
Sliding
NearLedge
SteppingUp
SteppingDown
Airborne
LandingLight
LandingHeavy
OnMovingPlatform
AgainstWall
```

地形StateはTransition conditionやblend parameterとして使う。

### 11.4 Foot IK and debugging

- 左右Foot contact
- Ground normal
- IK target
- Original foot pose
- Corrected foot pose
- Ankle rotation
- Pelvis correction
- Foot sliding distance
- Penetration depth
- Floating distance

IK ON/OFFとBefore/Afterを即時比較する。

### 11.5 Metrics

- Foot sliding distance
- Foot floating time
- Maximum penetration
- Grounded state flicker count
- Pelvis jerk
- Root Motion vs actual displacement error
- Step traversal time
- Landing stabilization time
- Moving platform drift

数値は補助であり、人間の感覚を最終判断とする。

---

## 12. Haptics

HapticsはAnimation Clipへ直書きせず、Semantic Eventへ接続する独立Trackとする。

### 12.1 Semantic events

```text
FootContactLeft
FootContactRight
AttackWindup
AttackHit
AttackRecoil
JumpTakeoff
Landing
DamageReceived
DodgeStart
DodgeEnd
GuardImpact
```

Hitbox、Audio、VFX、Hapticsは同じSemantic Eventを参照できる。

### 12.2 Capability tiers

```text
Tier 1: Generic dual-rumble
Tier 2: Trigger rumble when available
Tier 3: DualSense Extended experimental adapter
```

未対応環境では段階的にFallbackする。

```text
Advanced haptics
→ Trigger rumble
→ Generic rumble
→ No-op
```

未対応でプレビューやゲームを停止しない。

### 12.3 Editable values

- Duration
- Start delay
- Low-frequency magnitude
- High-frequency magnitude
- Curve
- Left/right trigger magnitude
- Adaptive trigger preset
- Resistance start
- Resistance strength
- Break point
- Pulse / recoil preset

### 12.4 Capability panel

実際に検出した機能だけを表示する。
コントローラー名だけで能力を決めない。

```text
Input
Generic Rumble
Trigger Rumble
Advanced Haptics
Adaptive Triggers
Permission State
Connection Type
```

DualSense固有出力はExperimental Adapter境界を実装し、標準機能の必須条件にしない。

---

## 13. Replay and regression system

### 13.1 Replay contents

- Initial project revision
- Initial character transform
- Input timestamps
- Axis values
- Button press/release
- Camera direction
- Terrain preset
- Random seed
- Fixed timestep version

### 13.2 Replay tests

最低限用意する。

```text
run-to-attack-forward
attack-01-to-attack-02
late-dodge-cancel
jump-buffer-before-landing
downhill-root-motion
stair-foot-ik
moving-platform-jump
ice-surface-stop
```

### 13.3 Regression policy

以前と違う結果が出た場合、新しい挙動を自動で正解にしない。

```text
Difference detected
  ↓
Generate metrics and visual comparison
  ↓
Require human accept / reject when protected behavior changes
```

Golden screenshotだけに依存しない。
State sequence、position、velocity、events、foot metricsも保存する。

---

## 14. AI adjustment system

### 14.1 Provider interface

外部AIサービスに依存しない抽象Adapterを定義する。

```text
proposeAdjustments(context) -> AdjustmentProposal[]
explainDiff(diff) -> Explanation
harmonizeRelatedTransitions(context) -> PatchSet
reviewRegression(report) -> Review
```

環境変数にAI keyがない場合は、決定論的なルールベースFallbackを使う。
アプリ自体はAI keyなしで完全起動すること。

### 14.2 Proposal contract

原則最大3案。

```text
A Responsive
B Weighted
C Preserve Original
```

各案は以下を持つ。

- Changed fields
- Before / after
- Rationale
- Expected tradeoffs
- Protected fields respected
- Required approval
- Test impact

### 14.3 Natural language translation

例。

```text
「攻撃に入るまで遅いが、重量感は消したくない」
```

単純なPlayback speed最大化ではなく、以下を候補にする。

- Input bufferを早める
- Blendを短くする
- Start offsetを少し進める
- 本体モーション速度は維持
- Momentumを残す
- AttackHit eventとHitboxの同期を維持

### 14.4 Learning project preferences

モデル再学習ではなく、プロジェクト内のPreference Profileとして保存する。

- Preferred blend range
- Responsiveness preference
- Momentum preference
- Root Motion policy
- IK correction preference
- Haptic intensity preference
- AI proposal acceptance history

人間がAI案をどう補正したかを次回提案へ反映する。

---

## 15. Animation Acquisition Skill

目的は、単にファイルをダウンロードすることではない。

**必要な動きを、出所と権利が追跡可能で、正規化され、リターゲットされ、検証済みで、Chamberから調整可能なプロジェクト資産へ変換すること。**

### 15.1 Entry modes

```text
Search    既製モーションを探す
Generate  Text-to-Motion Providerを使う
Capture   動画からモーション化する
Import    FBX / BVH / GLBを投入する
```

### 15.2 MVP behavior

- GLBを直接Import
- FBX / BVHはanimation-workerが利用可能な場合に変換
- workerがない環境では、変換が必要な形式を明確なPending Jobとして扱う
- Mixamoなど公開APIが保証されないサービスは、半自動Providerとして扱う
- ユーザーが取得したファイルのImport以降を自動化する
- 外部サービスの非公式APIを解析・利用しない
- Video-to-Motion / Text-to-MotionはProvider Adapterを用意する
- Provider未設定でもImport経路は動作する

### 15.3 Motion Brief

自然言語を構造化する。

```text
Action
Purpose
Style
Duration range
Root Motion required
Loop
Start pose
End pose
Direction
Weapon
Foot contact expectations
Mirroring allowed
```

### 15.4 Normalization pipeline

```text
Acquire
→ Verify provenance and license metadata
→ Import
→ Analyze skeleton
→ Map to canonical humanoid skeleton
→ Normalize axes, scale and FPS
→ Retarget
→ Extract or remove Root Motion
→ Detect loop and foot contacts
→ Detect spikes, sliding and penetration
→ Generate semantic tags and event candidates
→ Register as Candidate
→ Human compare
→ Human accept
→ Commit asset manifest and metadata
```

### 15.5 Asset states

```text
Imported
Candidate
Retargeted
Validated
HumanAccepted
Registered
Rejected
```

`HumanAccepted`になるまで既存Animation Setを置き換えない。
既存のlocked clipを自動置換しない。

### 15.6 License manifest

最低限記録する。

- Provider
- Source type
- Source asset ID or URL reference
- Acquired by
- Acquired date
- Commercial use status
- Raw asset redistribution status
- Team sharing status
- Public repository status
- Attribution requirement
- Verification status

不明な項目を勝手に`true`にしない。
不明は`unknown`として、公開GitへのRaw asset追加を禁止する。

### 15.7 Storage

- メタデータはGit管理
- 大きなバイナリはGit LFSまたは外部asset storage
- 公開再配布不可のRaw assetを公開Repositoryへ置かない
- 正規化済みファイルについても元ライセンス条件を継承する

---

## 16. Unity path

MVPでは、ブラウザ側が正本である。

### 16.1 Export bundle

```text
project.json
animation-graph.json
input-map.json
movement-profile.json
terrain-profile.json
haptic-profile.json
replays/
assets manifest
generated C# constants and DTOs
```

### 16.2 Minimal Unity Adapter scaffold

`generated/unity/AnimationTestChamberAdapter/`へ以下を生成する。

- Serializable DTOs
- JSON importer
- Runtime state machine skeleton
- Input action mapping placeholder
- Haptics adapter interface
- Terrain adapter interface
- Editor menu item: Import Chamber Project
- README with limitations

Unity Animator ControllerやPlayableGraphは生成物として扱う。
Unity固有機能を正規データへ逆流させる場合は、明示的なImport Back機能なしに直接編集を正本としない。

---

## 17. Harness

AIが実装を完了したと判断する前に、必ずHarnessを通す。

### 17.1 Commands

```text
pnpm harness:check
pnpm harness:unit
pnpm harness:integration
pnpm harness:replay
pnpm harness:visual
pnpm harness:repo-guard
pnpm harness:build
pnpm harness:one-shot
```

`harness:one-shot`は上記すべてを適切な順番で実行し、`reports/one-shot-report.json`と`reports/one-shot-report.md`を生成する。

### 17.2 Required checks

#### Static

- TypeScript strict
- ESLint
- Schema generation drift
- Dead canonical references
- Generated files not manually modified

#### Unit

- Transition conditions
- Priority
- Input buffer
- Cancel windows
- Fixed timestep
- Root Motion modes
- Terrain state detection
- Haptic fallback
- Protection metadata

#### Integration

- Load demo project
- Change value in editor state
- Stage diff
- Validate
- Commit through fake Git adapter
- Conflict detection
- Generate Unity export

#### Replay

- All required replays deterministic
- State sequence matches
- Event timing tolerance
- Position tolerance
- Foot metrics tolerance

#### Visual

- Desktop viewport
- Mobile landscape
- Mobile pad on/off
- Transition Inspector
- State Graph
- Timeline
- Diff panel
- Terrain debug

#### Repo guard

- No locked values changed unexpectedly
- No tests deleted or weakened without approval metadata
- No Schema constraints relaxed silently
- No generated artifact treated as canonical
- No secrets committed
- No raw restricted asset committed

### 17.3 Harness output

失敗時は、単なる終了コードだけでなく以下を出す。

- Failing stage
- Affected files
- Expected / actual
- Reproduction command
- Whether failure blocks commit
- Suggested next action

---

## 18. Skills

`agents/skills/`へ以下のSkill定義を作る。
各Skillは目的、入力、出力、変更可能範囲、禁止事項、検証コマンドを持つ。

### 18.1 `repo-guardian.md`

役割。

- SSoTと保護レベルを確認
- 依頼外差分を検出
- locked / invariantを守る
- テスト弱体化を検出
- 変更前後のRepo Guard reportを作る

禁止。

- 未参照だけを理由に削除
- テストを通すための期待値変更
- generatedの直接編集

### 18.2 `state-machine-tuner.md`

役割。

- 感覚語をTransition parameterへ変換
- A/B/C案を最大3つ作る
- 既存Replayで比較
- 関連Transitionの整合を提案

変更対象。

- Blend
- Offset
- Speed
- Buffer
- Cancel
- Momentum
- Priority
- Interruptibility

### 18.3 `terrain-interaction-tuner.md`

役割。

- 坂、段差、階段、縁、移動床、表面摩擦に関する問題を診断
- Foot IK、Root Motion projection、ground probeを調整
- Terrain replayを実行

### 18.4 `haptics-tuner.md`

役割。

- Semantic EventとHaptic Trackを同期
- Generic、Trigger、DualSense Extendedの案を作る
- Capability fallbackを維持
- 強度最大化だけで解決しない

### 18.5 `animation-acquisition.md`

役割。

- Motion Brief作成
- Search / Generate / Capture / Import経路を選択
- Provider capabilityを確認
- ProvenanceとLicense Manifestを作成
- Normalize、Retarget、Validate
- Candidateとして登録

禁止。

- 非公式APIへ依存
- ライセンス不明アセットを公開Repoへ追加
- HumanAccepted前の既存Clip置換

### 18.6 `git-apply.md`

役割。

- UI staging diffをSchema検証
- base SHA確認
- 作業ブランチ作成
- コミット生成
- PR作成
- 競合をフィールド単位に変換

### 18.7 `regression-inspector.md`

役割。

- Replay、metric、visual diffを比較
- 仕様変更と回帰を分類
- protected behaviorが変化したら人間承認を要求

### 18.8 `unity-export.md`

役割。

- Canonical dataからUnity bundle生成
- Adapter scaffoldを更新
- Unity固有生成物を正本化しない

### 18.9 `transition-feel-tuner.md`

役割。

- 手触りの依頼（もっさり、素早く、途中で割り込みたい）を正規データの最小変更へ落とす
- 診断順序を固定する。直結Transitionの有無 → cancelWindow → blendDurationSec
- 調整した値をInspectorから触れる状態で終える

禁止。

- playbackSpeedを速さの答えにする
- interruptible falseのStateへ窓のないTransitionを足す
- Rendererへブレンド時間をハードコードする

---

## 19. Main agent system prompt

以下を`agents/SYSTEM_PROMPT.md`へそのまま保存し、メイン実装エージェントのシステムプロンプトとして使用する。

```md
# Animation Test Chamber — Main Implementation Agent

あなたはAnimation Test Chamberリポジトリを完成させる主任エンジニアである。

## Mission

ブラウザ上で、AIによるアニメーション調整案の生成、人間による操作・比較・微調整、正規データへの保存、Gitへの安全な反映までを閉じたループとして完成させる。

## Source of truth

1. Canonical dataとSchema
2. Automated testsとReplay expectations
3. Runtime behavior
4. Git historyとDecision Records
5. Architecture documents
6. IssuesとPlans
7. CommentsとAI explanations

実行結果とSchemaが矛盾した場合、実行結果を無条件に正解とみなさない。バグ、暫定実装、未適用変更を疑う。

## Non-negotiable rules

- 包括的spec.mdを新設しない。
- 実装内容をMarkdownへ重複記述しない。
- HumanAccepted、locked、invariantの値や機能を勝手に変更・削除しない。
- 未参照、古そう、冗長、簡潔にできる、という理由だけで既存機能を削除しない。
- リファクタリングと仕様変更を同じ差分へ混在させない。
- テストを通すためにテスト削除、期待値変更、許容誤差拡大、Schema緩和を行わない。
- generatedを正規データとして編集しない。
- mainへ直接コミットしない。
- ブラウザへSecretを置かない。
- 外部AIキー、外部Animation Provider、Blender Workerがなくてもコアアプリを起動可能にする。
- ライセンスが不明なアセットを公開Repositoryへ追加しない。
- 不明なライセンス項目を推測で許可しない。

## Working method

1. 作業前に対象領域のSchema、tests、replays、protection metadataを確認する。
2. 変更範囲を明示し、依頼外差分を避ける。
3. 小さな垂直スライスで実装し、各スライスをHarnessで検証する。
4. UIだけ、Runtimeだけ、Schemaだけを先行させず、読み込みから保存までを接続する。
5. 一時実装には`@temporary`、置換条件、互換性要否を明記する。
6. 完了前に`pnpm harness:one-shot`を実行する。
7. 失敗をテスト弱体化で隠さず、実装を修正する。
8. 完成時に、実装済み、Fallback、未実装、既知制限を正直に報告する。

## Subagents and token discipline

- 軽量、局所的、並列可能な作業はサブエージェントへ積極的に委譲する。
- 主エージェントは、アーキテクチャ、SSoT、統合、競合判断、最終検証へトークンを集中する。
- サブエージェントには、対象ファイル、完了条件、禁止変更、出力形式を狭く指定する。
- 一つのサブエージェントへリポジトリ全体の再説明を与えない。
- 調査、Schema追加、単体テスト、UI部品、fixture、ドキュメント整形、レポート解析などは並列化する。
- 同じファイルを複数サブエージェントへ同時に変更させない。
- サブエージェントの出力は要約とPatchに限定し、冗長な思考過程を要求しない。
- 主エージェントはサブエージェントの変更を盲目的に採用せず、Repo GuardianとHarnessで検証する。
- トークン制限が近づいた場合、機能を曖昧に広げず、MVPの縦切り完成を優先する。
- 作業を途中で放置せず、利用可能な時間とトークン内で起動可能な状態へ収束させる。

## Completion standard

`pnpm install && pnpm harness:one-shot`が成功し、以下が人間の手で確認できること。

- Demo projectがロードされる。
- WASD、Gamepad、Mobile Padでキャラクターを操作できる。
- Jump、Dodge、Attackを実行できる。
- TransitionをUIで変更すると即座にPreviewへ反映される。
- ReplayでBefore/Afterを比較できる。
- Terrain presetを切り替え、接地とFoot IKを確認できる。
- Generic Haptics capabilityを確認できる。
- UI変更をStageし、Schema検証し、Fake Git Adapterでコミットできる。
- GitHub App設定がある場合、作業ブランチとPRを作れる。
- AI keyなしでもルールベースA/B/C案が生成される。
- GLBをImportし、Candidateとして登録できる。
- Unity Export Bundleを生成できる。
- locked値を変更しようとするとブロックされる。
```

---

## 20. Subagent policy

`agents/SUBAGENT_POLICY.md`へ保存する。

### 20.1 Actively delegate lightweight work

軽量な作業はサブエージェントへ積極的に投げ、メインエージェントのコンテキストとトークン消費を抑える。

推奨委譲対象。

- 1つのSchemaと対応テスト
- 1つのUIコンポーネント
- 1つのReplay fixture
- 1つのCapability detector
- 1つのAdapter interface
- 既存差分のレビュー
- テスト失敗ログの分類
- READMEの起動手順
- Unity DTO生成
- License Manifest validator

主エージェントが保持するもの。

- 全体アーキテクチャ
- Canonical data境界
- Protection semantics
- State machine semantics
- API contracts
- Git safety
- 統合順序
- 最終Harness

### 20.2 Subagent task template

```text
Goal:
対象を1文で記載。

Allowed files:
変更可能なファイルを列挙。

Do not change:
保護対象と禁止事項。

Inputs:
必要なSchema、interface、fixtureだけを渡す。

Acceptance:
具体的なテストまたは出力。

Return:
短い要約、変更ファイル、テスト結果、Patch。
思考過程や長い解説は不要。
```

### 20.3 Parallel execution rules

- 同一ファイルの並列編集禁止
- Schema変更担当とRuntime変更担当は、先にcontractを固定
- サブエージェントの出力を統合する前に型検査
- 大きな機能を「調査」「contract」「実装」「test」へ分ける
- 失敗したサブエージェントを同じ曖昧な指示で再実行しない
- ログ全体を投げず、必要箇所だけ抽出する

---

## 21. Implementation order

メインエージェントは以下の順で進める。
各段階で起動可能な状態を維持する。

### Phase 1: Repository and contracts

- Monorepo
- TypeBox schemas
- Demo project
- Procedural fallback character
- Fixed timestep core
- Harness skeleton
- Repo Guardian

### Phase 2: Playable chamber

- R3F viewport
- Third-person camera
- Input abstraction
- WASD / Gamepad / Mobile Pad
- Basic state machine
- Idle / Run / Jump / Dodge / Attack

### Phase 3: Editor loop

- Transition Inspector
- State Graph
- Timeline
- Preview session
- Undo / Redo
- Stage / Validate
- Diff viewer

### Phase 4: Replay and comparison

- Input recording
- Deterministic replay
- A/B/C switching
- Ghost and split comparison
- Regression metrics

### Phase 5: Terrain

- Terrain presets
- Ground detection
- Slope / step / ledge / moving platform states
- Foot IK basics
- Terrain debugging

### Phase 6: Haptics

- Semantic events
- Generic rumble
- Trigger capability detection
- DualSense Extended interface and UI
- Fallback tests

### Phase 7: Git loop

- Fake Git Adapter
- GitHub App Adapter
- base SHA conflict
- branch commit
- PR creation

### Phase 8: AI tuning

- Provider interface
- Rule-based fallback
- A/B/C proposals
- Protection-aware patches
- Apply and harmonize

### Phase 9: Acquisition

- GLB Import
- Candidate registry
- Provenance and License Manifest
- Worker contract for FBX / BVH
- Retargeting placeholders with explicit unsupported states

### Phase 10: Unity export

- Export bundle
- C# DTOs
- Minimal Unity Adapter scaffold

### Phase 11: Final hardening

- Playwright mobile/desktop
- Replay suite
- Repo guard
- Security review
- Accessibility basics
- `harness:one-shot`

---

## 22. Acceptance criteria

### 22.1 Fresh clone

```text
pnpm install
cp .env.example .env
pnpm dev
```

外部サービス設定なしでDemo Chamberが起動する。

### 22.2 Human tuning loop

1. Run → Attack transitionを選ぶ。
2. Blendを変更する。
3. 即座にPreviewへ反映される。
4. Before / Afterを同じReplayで比較する。
5. Stageする。
6. Schema validationを通す。
7. Fake Git Adapterでコミットする。
8. Revision metadataにhuman adjustmentとして残る。

### 22.3 AI tuning loop

1. 「攻撃の初動を速くし、重量感は残す」と入力する。
2. AI keyなしでもA/B/C案が返る。
3. locked値はどの案も変更しない。
4. 各案のTradeoffを表示する。
5. 同一Replayで比較できる。

### 22.4 Input

- WASD
- Gamepad
- Jump
- Primary Action
- Dodge
- Mobile Pad toggle
- Device prompt switching

### 22.5 Terrain

- Flat、Slope、Stairs、Moving Platformを切り替えられる。
- Ground normal、Foot target、Root Motion vectorを表示できる。
- Downhill replayが決定論的に再生される。

### 22.6 Haptics

- Capability panelが表示される。
- Generic rumble対応時にテストできる。
- 非対応時に安全にNo-opまたはFallbackする。
- Haptic eventをTimelineで調整できる。

### 22.7 Git

- mainへ直接書かない。
- base SHA conflictを検出する。
- locked value変更を拒否する。
- GitHub設定がある場合PRを作成する。

### 22.8 Acquisition

- GLBをImportできる。
- ProvenanceとLicense Manifestが必須。
- `unknown`ライセンスのRaw assetを公開RepoへCommitしようとすると拒否する。
- HumanAccepted前に既存Clipを置換しない。

### 22.9 Unity

- Export Bundleを生成できる。
- Generated C# DTOsがSchemaと一致する。
- 生成物であることが明示される。

---

## 23. Final deliverables

- 動作するMonorepo
- Demo Project
- README
- ARCHITECTURE
- Decision Records
- Schemas
- Harness
- Agent System Prompt
- Subagent Policy
- Skill definitions
- Tests and Replay fixtures
- GitHub App setup guide
- Animation Worker contract
- Unity Export scaffold
- One-shot report

最終報告では以下を分けて記載する。

```text
Implemented and verified
Implemented with fallback
Scaffolded but not operational without external service
Known limitations
Harness results
Security notes
```

「すべて完成した」と曖昧に主張せず、外部サービス、ブラウザ、OS、デバイス依存の機能は正確に状態を示す。

---

## 24. Final instruction to the implementation agent

このPLANを議論用文書として要約して終わらせないこと。

リポジトリ内のファイル、実装、テスト、Harness、Agent Skillとして具体化し、外部キーなしで起動可能な垂直スライスを完成させること。

トークン制限を理由に全領域を浅く作らない。
軽量・局所作業はサブエージェントへ積極的に分割し、主エージェントは設計整合、SSoT保護、統合、最終検証へ集中すること。

迷った場合は以下の優先順位で判断する。

```text
1. 人間が良いと確定した状態を守る
2. ブラウザ上の調整を正規データとGitへ閉じる
3. 同一条件で比較・再現できる
4. 外部サービスなしでも起動する
5. WebとUnityの共有境界を壊さない
6. 機能数より縦切りの完成度を優先する
```

**完成とは、コードが存在することではない。人間がブラウザで触り、比較し、確定し、その結果を安全にリポジトリへ刻めることである。**
