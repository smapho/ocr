-- OCRで抽出した経費検収書データを格納するテーブル
create table if not exists ocr_documents (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  storage_path text not null,
  status text not null default 'done',

  issue_date date,
  target_period text,
  company_name text,
  division_name text,
  branch_name text,
  store_name text,
  document_type text,

  expense_item_code text,
  expense_item_name text,
  property_name text,
  contract_no text,
  payment_due_date date,

  vendor_code text,
  vendor_name text,
  payment_method text,

  -- 事前承認金額(常に印字されている金額)
  pre_approved_amount integer,
  -- 検収金額欄に表示されていた生テキスト(マスクされている場合は "*********" 等)
  inspection_amount_raw text,
  -- 検収金額欄がマスクされていて事前承認金額で補完したかどうか
  inspection_amount_masked boolean not null default false,
  -- 最終的に採用する金額(マスク時は pre_approved_amount と同値)
  inspection_amount integer,

  tax_rate numeric,
  bank_info text,
  approval_no text,
  inspection_date date,
  -- 手書きの変更理由欄
  change_reason text,
  other_notes text,

  -- Geminiから返却された抽出結果の全文(監査・デバッグ用)
  raw_ocr_json jsonb,
  error_message text,

  created_at timestamptz not null default now()
);

create index if not exists ocr_documents_created_at_idx on ocr_documents (created_at desc);

-- サーバー側のVercel Functionsからservice role keyでのみアクセスする想定のため、
-- RLSは有効化した上でanon/authenticated向けのポリシーはあえて作成しない(全面拒否がデフォルト)。
alter table ocr_documents enable row level security;

-- 画像原本を保存するプライベートバケット
insert into storage.buckets (id, name, public)
values ('ocr-images', 'ocr-images', false)
on conflict (id) do nothing;
