# 経費検収書 OCR取り込み

画像化された「年間経費検収書」を Gemini でOCRし、構造化データとして Supabase に格納するツールです。
「検収金額」欄が `*********` のようにマスクされている場合は、「事前承認金額」を代わりに採用します(手書き文字も読み取り対象)。

- フロントエンド: `index.html` + `app.js`(素のHTML/JS、フレームワークなし)
- バックエンド: Vercel Functions(`api/upload-url.js`, `api/ingest.js`, `api/documents.js`)
- OCR: Google AI Studio の Gemini API(`image/heic`・`image/heif` もネイティブ対応)
- データ格納: Supabase(Postgres + Storage)

画像本体はブラウザから `api/upload-url` で発行した署名付きURLを使って直接Supabase Storageへアップロードする(Vercel Functionsのリクエストサイズ上限を回避するため)。`api/ingest` はStorageから画像を取得してGeminiに渡すのみを担当する。

## 1. Gemini APIキーの取得

1. https://aistudio.google.com/apikey にアクセスし、Googleアカウントでログイン
2. 「Create API key」でキーを発行(無料枠あり)

## 2. Supabaseのセットアップ

1. https://supabase.com でプロジェクトを作成
2. SQL Editor で `supabase/schema.sql` の内容を実行
   - `ocr_documents` テーブルと、画像保存用のプライベートバケット `ocr-images` が作成されます
3. Project Settings > API から以下を控える
   - Project URL → `SUPABASE_URL`
   - `service_role` キー(**secret**。絶対に公開しない) → `SUPABASE_SERVICE_ROLE_KEY`

## 3. 環境変数

`.env.example` を参考に、Vercelプロジェクトに以下を設定します(`vercel env add` または Vercelダッシュボードから)。

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.6-flash
```

## 4. ローカル開発

```
npm install
npm i -g vercel   # 未インストールの場合
vercel link       # 初回のみ、プロジェクトと紐付け
vercel env pull .env.local
vercel dev        # npm run ではなく直接実行する(再帰呼び出し防止のため)
```

## 5. デプロイ

```
vercel --prod
```

## 使い方

### フォルダを選択する場合(推奨・Chrome/Edgeのみ)

1. デプロイしたURL(またはローカルの `vercel dev`)を開く
2. 「📁 フォルダを選択(取り込み後に自動移動)」を押し、OCR対象画像が入ったフォルダを選ぶ
3. 「取り込み実行」を押すと、最大4枚を同時にGeminiでOCR → Supabase Storageへ原本保存 → `ocr_documents` テーブルに格納される
4. 成功したファイルは選択したフォルダ内の「取り込み済み」サブフォルダへ自動的に移動される(次回フォルダを選び直しても二重に取り込まれない)

### 個別ファイル選択の場合(全ブラウザ対応・自動移動なし)

画像をドラッグ&ドロップ、またはクリックして複数選択して取り込む。この方法では処理後の自動移動は行われないため、同じファイルを選び直すと重複して取り込まれる点に注意。

下の一覧には格納結果が表示される。検収金額がマスクされていた行には「(定額)」の注記が表示される。

## 注意

- 画像には実際の取引先名・銀行口座・承認番号などの機密情報が含まれる可能性があります。このリポジトリはpublicのため、サンプル画像や実データの画像ファイルは絶対にコミットしないでください(`.gitignore` で拡張子ベースに除外済み)。
- `SUPABASE_SERVICE_ROLE_KEY` はRLSを無視できる強い権限を持つため、Vercelの環境変数以外の場所(フロントエンドのコードなど)には絶対に置かないでください。
- `app.js` 内の `SUPABASE_PUBLISHABLE_KEY` は公開して問題ない値(旧anonキー相当)。署名付きアップロードURLの実行にのみ使われ、RLSで保護されたテーブル/バケットへの直接アクセス権は持たない。
