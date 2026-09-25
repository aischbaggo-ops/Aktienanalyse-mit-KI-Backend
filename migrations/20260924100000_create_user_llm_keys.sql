-- Providerneutrale LLM-Key-Tabelle: ein Nutzer kann Keys fuer mehrere
-- Anbieter (claude/openai/gemini/openrouter) hinterlegen und einen davon
-- als aktiv festlegen (siehe active_llm_provider auf profiles unten).
-- Verschluesselung identisch zu user_api_keys (AES-256-GCM,
-- API_KEY_ENCRYPTION_SECRET, siehe _shared/crypto.ts) - *_ciphertext/*_iv
-- sind ohne dieses Secret wertlos, *_last4 dient nur der UI-Anzeige.
--
-- model ist bewusst nullable: bei provider='claude' greift ohne eigenen
-- Eintrag der Code-Default (aktuelles Standard-Claude-Modell, siehe
-- _shared/llm/index.ts) - bei den anderen drei Anbietern ist der Modellname
-- Pflicht und wird 1:1 vom Nutzer uebernommen (z.B. "gpt-4o",
-- "anthropic/claude-sonnet-5" bei OpenRouter).
create table if not exists user_llm_keys (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('claude', 'openai', 'gemini', 'openrouter')),
  key_ciphertext text not null,
  key_iv text not null,
  key_last4 text not null,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table user_llm_keys enable row level security;

create policy user_llm_keys_select_own
  on user_llm_keys
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy user_llm_keys_insert_own
  on user_llm_keys
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy user_llm_keys_update_own
  on user_llm_keys
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy user_llm_keys_delete_own
  on user_llm_keys
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- Aktiver Anbieter pro Nutzer, gilt fuer alle kuenftigen Analysen bis er
-- geaendert wird (kein Umschalten pro Lauf). Default 'claude' fuer ALLE
-- Bestandsnutzer, damit sich am Verhalten nichts aendert, ohne dass
-- irgendjemand etwas an seinen Einstellungen anpassen muss.
alter table profiles
  add column if not exists active_llm_provider text not null default 'claude'
  check (active_llm_provider in ('claude', 'openai', 'gemini', 'openrouter'));

-- Bestehende Claude-Keys aus user_api_keys nach user_llm_keys uebernehmen -
-- reiner Ciphertext-Kopiervorgang (gleicher Verschluesselungsschluessel/
-- -algorithmus), kein Entschluesseln/Neuverschluesseln noetig. model bleibt
-- NULL (Code-Default greift). user_api_keys.claude_key_* wird bewusst NICHT
-- geloescht/geaendert - siehe Kommentar in _shared/userKeys.ts, warum das
-- als Sicherheitsnetz stehen bleibt, bis sich die neue Ablage im Betrieb
-- bewaehrt hat. on conflict: macht die Migration erneut ausfuehrbar.
insert into user_llm_keys (user_id, provider, key_ciphertext, key_iv, key_last4, model, created_at, updated_at)
select user_id, 'claude', claude_key_ciphertext, claude_key_iv, claude_key_last4, null, updated_at, updated_at
from user_api_keys
where claude_key_ciphertext is not null and claude_key_iv is not null
on conflict (user_id, provider) do update set
  key_ciphertext = excluded.key_ciphertext,
  key_iv = excluded.key_iv,
  key_last4 = excluded.key_last4,
  updated_at = excluded.updated_at;
