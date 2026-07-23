import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method === 'DELETE') {
    const id = req.query?.id;
    if (!id) {
      res.status(400).json({ error: 'id は必須です' });
      return;
    }

    const { data: doc, error: fetchError } = await supabase
      .from('ocr_documents')
      .select('storage_path')
      .eq('id', id)
      .single();
    if (fetchError) {
      res.status(404).json({ error: '対象のデータが見つかりません' });
      return;
    }

    if (doc.storage_path) {
      await supabase.storage.from('ocr-images').remove([doc.storage_path]);
    }

    const { error: deleteError } = await supabase.from('ocr_documents').delete().eq('id', id);
    if (deleteError) {
      res.status(500).json({ error: deleteError.message });
      return;
    }

    res.status(200).json({ ok: true });
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { data, error } = await supabase
    .from('ocr_documents')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const withUrls = await Promise.all(
    data.map(async (doc) => {
      const { data: signed } = await supabase.storage
        .from('ocr-images')
        .createSignedUrl(doc.storage_path, 60 * 60);
      return { ...doc, image_url: signed?.signedUrl || null };
    })
  );

  res.status(200).json({ documents: withUrls });
}
