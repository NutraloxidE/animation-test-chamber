# Subagent policy

## Actively delegate lightweight work

軽量な作業はサブエージェントへ積極的に投げ、メインエージェントのコンテキストと
トークン消費を抑える。

推奨委譲対象:

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

主エージェントが保持するもの:

- 全体アーキテクチャ
- Canonical data境界
- Protection semantics
- State machine semantics
- API contracts
- Git safety
- 統合順序
- 最終Harness

## Subagent task template

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

## Parallel execution rules

- 同一ファイルの並列編集禁止
- Schema変更担当とRuntime変更担当は、先にcontractを固定
- サブエージェントの出力を統合する前に型検査
- 大きな機能を「調査」「contract」「実装」「test」へ分ける
- 失敗したサブエージェントを同じ曖昧な指示で再実行しない
- ログ全体を投げず、必要箇所だけ抽出する

## A note on when delegation does not pay

このリポジトリを最初にゼロから構築した際は、ほぼ全ての作業を主エージェントが
直接行った。理由は、ファイルがまだ存在せずサブエージェントに渡せる文脈が無く、
Schema・Protection・State machineの境界が同時に決まっていく段階だったため。

委譲が効くのは、契約が固定された後の局所作業である。契約そのものを決めている
最中に並列化すると、統合コストが削減分を上回る。
