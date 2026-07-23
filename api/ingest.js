import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    issue_date: { type: 'STRING', nullable: true, description: '発行日。YYYY-MM-DD形式(和暦や手書きの日付も西暦に変換)' },
    target_period: { type: 'STRING', nullable: true, description: '対象年月。YYYY-MM形式' },
    company_name: { type: 'STRING', nullable: true },
    division_name: { type: 'STRING', nullable: true },
    branch_name: { type: 'STRING', nullable: true },
    store_name: { type: 'STRING', nullable: true },
    document_type: { type: 'STRING', nullable: true, description: '帳票のタイトル(例: 年間経費検収書)' },
    expense_item_code: { type: 'STRING', nullable: true },
    expense_item_name: { type: 'STRING', nullable: true },
    property_name: { type: 'STRING', nullable: true },
    contract_no: { type: 'STRING', nullable: true },
    payment_due_date: { type: 'STRING', nullable: true, description: '支払予定日。YYYY-MM-DD形式' },
    vendor_code: { type: 'STRING', nullable: true },
    vendor_name: { type: 'STRING', nullable: true },
    payment_method: { type: 'STRING', nullable: true },
    pre_approved_amount: { type: 'INTEGER', nullable: true, description: '事前承認金額。円マークやカンマを除いた整数' },
    inspection_amount_raw: {
      type: 'STRING',
      nullable: true,
      description: '検収金額欄に表示されている文字をそのまま。"*********" のようにアスタリスク等でマスクされていればそのマスク文字列を、マスクされていなければ実際の金額の数字のみを入れる',
    },
    tax_rate: { type: 'NUMBER', nullable: true, description: '税率(%の数値のみ)' },
    bank_info: { type: 'STRING', nullable: true, description: '引落口座などの銀行情報' },
    approval_no: { type: 'STRING', nullable: true },
    inspection_date: { type: 'STRING', nullable: true, description: '検収月日。手書きの場合も読み取ってYYYY-MM-DD形式に変換' },
    change_reason: { type: 'STRING', nullable: true, description: '変更理由欄の手書き文字' },
    other_notes: { type: 'STRING', nullable: true, description: '上記に当てはまらないが読み取れた補足情報(スタンプの日付など)' },
  },
  required: ['inspection_amount_raw'],
};

const PROMPT = `あなたは経理書類のOCR担当です。添付された経費検収書の画像を読み取り、指定されたJSONスキーマに従って値を抽出してください。

注意事項:
- 印字された文字だけでなく、手書き文字(スタンプ・手書きメモ・手書き数字など)も注意深く読み取ってください。
- 金額は円マークやカンマを除いた整数で返してください。
- 日付は西暦のYYYY-MM-DD形式に変換してください。
- 「検収金額」欄が "*********" のようにアスタリスク等でマスク(伏字)されている場合、inspection_amount_raw にはそのマスク表示をそのまま入れてください。マスクされていない場合は実際の金額の数字のみを文字列として入れてください。
- 読み取れない・存在しない項目は null にしてください。憶測で値を埋めないでください。`;

function toDateOrNull(value) {
  if (typeof value !== 'string') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function toIntOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { fileName, mimeType, imageBase64 } = req.body || {};
    if (!fileName || !mimeType || !imageBase64) {
      res.status(400).json({ error: 'fileName, mimeType, imageBase64 は必須です' });
      return;
    }
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY が設定されていません');
    }

    const geminiRes = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: PROMPT }, { inlineData: { mimeType, data: imageBase64 } }],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      throw new Error(`Gemini API error (${geminiRes.status}): ${errText}`);
    }

    const geminiJson = await geminiRes.json();
    const rawText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('Gemini から有効な応答が得られませんでした');
    const extracted = JSON.parse(rawText);

    // 検収金額がマスクされている場合は事前承認金額で補完する(業務ルール)。
    // モデルの出力に関わらずサーバー側で最終判定する。
    const rawInspection = (extracted.inspection_amount_raw || '').trim();
    const isMasked = rawInspection === '' || /^[*＊]+$/.test(rawInspection);
    const preApprovedAmount = toIntOrNull(extracted.pre_approved_amount);
    const inspectionAmount = isMasked ? preApprovedAmount : toIntOrNull(rawInspection);

    const storagePath = `${Date.now()}_${fileName}`.replace(/\s+/g, '_');
    const buffer = Buffer.from(imageBase64, 'base64');
    const { error: uploadError } = await supabase.storage
      .from('ocr-images')
      .upload(storagePath, buffer, { contentType: mimeType, upsert: false });
    if (uploadError) throw new Error(`Storageへの保存に失敗しました: ${uploadError.message}`);

    const { data: inserted, error: insertError } = await supabase
      .from('ocr_documents')
      .insert({
        file_name: fileName,
        storage_path: storagePath,
        status: 'done',
        issue_date: toDateOrNull(extracted.issue_date),
        target_period: extracted.target_period || null,
        company_name: extracted.company_name || null,
        division_name: extracted.division_name || null,
        branch_name: extracted.branch_name || null,
        store_name: extracted.store_name || null,
        document_type: extracted.document_type || null,
        expense_item_code: extracted.expense_item_code || null,
        expense_item_name: extracted.expense_item_name || null,
        property_name: extracted.property_name || null,
        contract_no: extracted.contract_no || null,
        payment_due_date: toDateOrNull(extracted.payment_due_date),
        vendor_code: extracted.vendor_code || null,
        vendor_name: extracted.vendor_name || null,
        payment_method: extracted.payment_method || null,
        pre_approved_amount: preApprovedAmount,
        inspection_amount_raw: extracted.inspection_amount_raw || null,
        inspection_amount_masked: isMasked,
        inspection_amount: inspectionAmount,
        tax_rate: extracted.tax_rate ?? null,
        bank_info: extracted.bank_info || null,
        approval_no: extracted.approval_no || null,
        inspection_date: toDateOrNull(extracted.inspection_date),
        change_reason: extracted.change_reason || null,
        other_notes: extracted.other_notes || null,
        raw_ocr_json: extracted,
      })
      .select()
      .single();

    if (insertError) throw new Error(`DBへの格納に失敗しました: ${insertError.message}`);

    res.status(200).json({ document: inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '不明なエラーが発生しました' });
  }
}
