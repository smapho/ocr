import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
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
