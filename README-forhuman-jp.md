# Animation Test Chamber — 人間向けガイド（日本語）

> このページは、このプロジェクトを使う人・評価する人向けです。
> コーディングAIは、実装ルールを詳しく書いた [`README.md`](README.md) を読む前提です。
>
> English: [`README-forhuman-en.md`](README-forhuman-en.md)

## Animation Test Chamberとは

Animation Test Chamberは、**AIでゲームを作ることを前提に設計した、ブラウザ中心のゲーム開発環境**です。

考え方はかなり単純です。

> ゲームごとにこのリポジトリをclone / forkして、作りたいものをAIに伝える。AIが毎回エンジン本体を魔改造しなくてもゲームを増築できるよう、リポジトリ自体に作り方・制約・検証環境まで入れておく。

もともとはキャラクターアニメーションを高速に調整するための環境として始まり、現在は以下をまとめて持つゲームプレイ基盤へ発展しています。

- ブラウザで動くゲームランタイム
- 普通のゲームルールを書くGameplay Script
- キャラクター移動・アニメーションの再利用可能な基盤
- Prefab / Scene
- Scene / Prefab / アニメーション編集UI
- ゲーム専用HUDの編集面
- 決定論的なテストとharness
- AI向けの手順・skill・アーキテクチャ制約
- Gitで扱いやすいcanonical project data

何でもできる巨大な汎用ゲームエンジンを目指すというより、**バイブコーディングでプロトタイプや小〜中規模のアクションゲームを高速に作り、別のAIが後から触っても壊れにくくする**ことを重視しています。

## どう使う前提なのか

現状のAnimation Test Chamberは、**リポジトリを丸ごとコピーして使うタイプのエンジン**です。

基本形はこうです。

```text
Animation Test Chamber
        ↓ clone / fork
自分のゲーム用リポジトリ
        ↓
Claude Code / Codexなどに機能を依頼
        ↓
Gameplay Script / Prefab / Scene / UI / animation dataを編集
        ↓
harnessで設計を壊していないか検証
```

今のところ、別リポジトリから小さなnpm packageだけをimportして使う設計ではありません。

エンジン・ゲームコード・エディタ・テスト・AI向け説明を同じrepoに置くことで、AIが「このプロジェクトではどう作るべきか」を毎回外部から推測しなくて済むようにしています。

## クイックスタート

必要なもの：

- Node.js
- pnpm
- モダンブラウザ

起動：

```bash
pnpm install
cp .env.example .env     # 任意
pnpm dev
```

ブラウザで以下を開きます。

```text
http://localhost:5173
```

ルートURLはゲーム本体です。

```text
/                  active Sceneをプレイ
/play/:sceneId     指定したSceneだけをプレイ
/edit/scene/:id    Scene Editor
/edit/prefab/:id   Prefab Editor
```

多くのローカルゲームプレイ・編集機能は外部APIキーなしでも動きます。Gitや外部AIなどサーバー側の資格情報が必要な機能は、未設定時に黙って壊れるのではなく利用不可であることを明示します。

## 一番重要な考え方：ゲームルールはゲーム側に置く

中心ルールはこれです。

> **ゲーム固有ルール = Gameplay Script。再利用可能なエンジン能力 = native Component。**

普通はGameplay Scriptとして実装するもの：

- HP / stamina
- damage / heal
- cooldown
- poisonなどのstatus effect
- door / pickup
- enemyやencounterのルール
- dash / knockback
- moving platform
- spawn / despawn

Gameplay Scriptはここにあります。

```text
packages/gameplay/src/scripts/
```

現在のrepoには、最小例として以下があります。

- `health`
- `stamina`
- `air-dash`

例えばAIに、

```text
「HP100の敵を追加。攻撃されたらノックバックして、HP0で消える」
```

と頼んだ場合、理想的にはGameplay Script / Prefab / Scene側の変更で完結します。

`EnemyHealthComponent`を新設して、rendererやSimulationに敵専用分岐を増やす、という方向にはしません。

この「普通のゲーム機能でエンジン本体を汚さない」構造が、AIで継続開発しやすくする重要な部分です。

## キャラクター移動

CharacterMotorで管理されるキャラクターは、移動のauthorityを一つに保ちます。

Gameplay Scriptがtransformやvelocityを直接書き換えるのではなく、型付きの移動commandを送ります。

現在の大きな分類は：

- impulse
- 一時的なmotion override
- movement scale
- teleport

これを使って、例えば以下を作れます。

- dash
- knockback
- recoil
- launch
- slow / haste
- grapple系移動

アニメーション側には一時的な`gameplay.*`パラメータを渡せますが、Gameplay Scriptからclipを直接選ぶ設計にはしません。

つまり、新しい移動技を追加するたびに新しいエンジンサブシステムを作る必要がないのが狙いです。

## AIと一緒に作る時の基本フロー

普通の使い方はかなり単純です。

```text
1. repoをclone / forkする
2. AIに作りたい機能を言う
3. AIがREADME.mdと関連docsを読む
4. ブラウザで触る
5. 気になるところを追加で指示する
6. 大きな変更ならharnessを通す
```

例えば：

```text
「二段ジャンプを追加」
「staminaを追加してair dashで20消費」
「攻撃されるとHPが減ってノックバックする敵を追加」
「2地点を往復するmoving platformを追加」
「HUDにHPとstaminaを表示」
「現在のSceneに敵を3体配置」
```

AI向けの`README.md`には、それぞれの要求をどの層で実装すべきかまで書いてあります。

## どこに何があるか

```text
apps/web/
  ブラウザゲーム、renderer、editor、game UI

apps/api/
  Git / AI / assetなどサーバー専用機能

packages/gameplay/
  ゲーム固有Gameplay Script

packages/gameplay-sdk/
  Gameplay Scriptに見せる安定API

packages/game-object-runtime/
  Scene / GameObject runtimeとscript host

packages/character-control-runtime/
  キャラクター入力と移動command処理

packages/replay-runtime/
  決定論的なキャラクターSimulation

packages/animation-*/
  animation runtime / authored animation基盤

packages/prefab-runtime/
  Prefab解決・composition

projects/
  canonical project / Scene data

agents/
  コーディングAI向けinstructions / skills

harness/
  アーキテクチャ・回帰チェック

reports/
  harness / auditの証拠
```

## ゲーム画面とエディタは分けてある

このrepoでは、ゲーム本体と編集UIを意図的に分離しています。

`/` はプレイ画面で、Scene Editor / Prefab Editorのchromeを載せません。

ゲーム固有HUDはここです。

```text
apps/web/src/game-ui/
```

編集作業は明示的に`/edit/...`へ入ります。

これにより、AIが「ゲームのHPバーを追加して」と言われた時に、editor UIへHPバーを生やすような混線を避けやすくしています。

## アニメーション調整環境としての機能も残っている

Animation Test Chamberは元々アニメーション調整ツールだったため、その部分も現在の設計の重要な要素です。

共有Animation Behavior、キャラクターごとのmotion binding、root motionを含むsimulation、replay、ブラウザ上での比較・調整などを同じrepoで扱います。

基本ループは今も、

```text
AIが調整案を出す
  → 人間がブラウザで比較
  → 人間またはAIが微調整
  → canonical dataへ反映
  → validation
  → commit
```

という形です。

Gameplay platformはこのループを捨てたのではなく、その上にゲーム制作まで載せています。

## 検証

Gameplay、Character Motion、ブラウザplay surfaceなどには個別harnessがあります。

大きな変更の最終ゲートは：

```bash
pnpm harness:one-shot
```

一通り確認する場合：

```bash
pnpm gameplay:generate
pnpm gameplay:check
pnpm typecheck
pnpm lint
pnpm harness:one-shot
```

harnessは単なるテスト集ではなく、**後から別のAIが触っても壊してはいけない設計を実行可能な形で残すもの**として扱っています。

## ビルドとデプロイ

production build：

```bash
pnpm build
```

静的web outputは`apps/web/dist`に生成され、Vercel用設定もrepoに含まれています。

静的デプロイではブラウザゲームやclient-side機能を動かせます。filesystem書き込み、server-side secrets、Git操作などが必要な機能はlocal/API環境が必要です。

## 現在の状態

現在は、Gameplay Script ABI、Character Motion command layer、ブラウザplay pathの基盤が実装され、主要なextension pathにはunit/browser testがあります。

ただし、これは「汎用ゲームエンジンの全問題を解決済み」という意味ではありません。まだ進化中のplatformで、単に一度動いたことよりもharnessを通して設計が維持されていることを重視しています。

実装の正確なルールやAI向けの開発手順を知りたい場合は、以下へ進んでください。

- [`README.md`](README.md) — AI / 実装向け入口
- [`agents/GAMEPLAY_VIBE_CODING.md`](agents/GAMEPLAY_VIBE_CODING.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
