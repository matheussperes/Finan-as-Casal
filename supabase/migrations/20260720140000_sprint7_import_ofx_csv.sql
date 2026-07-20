-- Sprint 7 · LAN-05 — Importação OFX/CSV
-- 1) import_fingerprint: impressão digital do lançamento importado, usada
--    para não reimportar o mesmo lançamento (dedup). Único por casal.
-- 2) needs_category_review: fila "Confirmar categoria" — lançamentos que a
--    importação não conseguiu categorizar com confiança.
-- 3) source: origem do lançamento (manual | import_ofx | import_csv).

alter table public.transactions
  add column if not exists import_fingerprint text,
  add column if not exists needs_category_review boolean not null default false,
  add column if not exists source text not null default 'manual';

-- Dedup: dois lançamentos com a mesma fingerprint no mesmo casal não coexistem.
-- Parcial (só quando há fingerprint) para não afetar lançamentos manuais.
create unique index if not exists uniq_transactions_import_fp
  on public.transactions (household_id, import_fingerprint)
  where import_fingerprint is not null;

-- Acelera a contagem/listagem da fila de revisão por casal.
create index if not exists idx_transactions_needs_review
  on public.transactions (household_id, date desc)
  where needs_category_review = true;
