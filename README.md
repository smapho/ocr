# 経費検収書 OCR取り込み

画像化された「年間経費検収書」を Gemini でOCRし、構造化データとして Supabase に格納するツールです。
「検収金額」欄が `*********` のようにマスクされている場合は、「事前承認金額」を代わりに採用します(手書き文字も読み取り対象)。

- フロントエンド: `index.html` + `app.js`(素のHTML/JS、フレームワークなし)
- バックエンド: Vercel Functions(`api/ingest.js`, `api/documents.js`)
- OCR: Google AI Studio の Gemini API
- データ格納: Supabase(Postgres + Storage)

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
vercel dev
```

## 5. デプロイ

```
vercel --prod
```

## 使い方

1. デプロイしたURL(またはローカルの `vercel dev`)を開く
2. OCR対象の画像をドラッグ&ドロップ、またはクリックして複数選択
3. 「取り込み実行」を押すと、1枚ずつ Gemini でOCR → Supabase Storageに原本保存 → `ocr_documents` テーブルに格納される
4. 下の一覧に格納結果が表示される。検収金額がマスクされていた行には注記が表示される

## 注意

- 画像には実際の取引先名・銀行口座・承認番号などの機密情報が含まれる可能性があります。このリポジトリはpublicのため、サンプル画像や実データの画像ファイルは絶対にコミットしないでください(`.gitignore` で拡張子ベースに除外済み)。
- `SUPABASE_SERVICE_ROLE_KEY` はRLSを無視できる強い権限を持つため、Vercelの環境変数以外の場所(フロントエンドのコードなど)には絶対に置かないでください。
