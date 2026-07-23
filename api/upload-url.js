import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// クライアントが直接Supabase Storageへアップロードするための署名付きURL(トークン)を発行する。
// Vercel Functionsのリクエストボディサイズ上限を回避するため、画像本体はこの関数を経由させず
// ブラウザ→Supabase Storageへ直接送らせる。
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { fileName } = req.body || {};
    if (!fileName) {
      res.status(400).json({ error: 'fileName は必須です' });
      return;
    }

    const storagePath = `${Date.now()}_${fileName}`.replace(/\s+/g, '_');
    const { data, error } = await supabase.storage
      .from('ocr-images')
      .createSignedUploadUrl(storagePath);

    if (error) throw new Error(error.message);

    res.status(200).json({ storagePath, token: data.token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '不明なエラーが発生しました' });
  }
}
