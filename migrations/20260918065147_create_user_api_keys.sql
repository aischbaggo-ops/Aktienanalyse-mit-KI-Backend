-- Eigene FMP-/Claude-API-Keys pro Nutzer. Werte werden ausschliesslich
-- verschluesselt gespeichert (AES-256-GCM, Schluessel im Function-Secret
-- API_KEY_ENCRYPTION_SECRET, siehe supabase/functions/_shared/crypto.ts) -
-- *_ciphertext/*_iv sind ohne dieses Secret wertlos. *_last4 ist bewusst
-- unverschluesselt (nur 4 Zeichen, dient der UI-Anzeige "...endet auf 1234",
-- kein sicherheitsrelevanter Wert).
create table if not exists user_api_keys (
  user_id uuid primary key,
  fmp_key_ciphertext text,
  fmp_key_iv text,
  fmp_key_last4 text,
  claude_key_ciphertext text,
  claude_key_iv text,
  claude_key_last4 text,
  updated_at timestamptz not null default now()
);

alter table user_api_keys enable row level security;

create policy user_api_keys_select_own
  on user_api_keys
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy user_api_keys_insert_own
  on user_api_keys
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy user_api_keys_update_own
  on user_api_keys
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy user_api_keys_delete_own
  on user_api_keys
  for delete
  to authenticated
  using (auth.uid() = user_id);
