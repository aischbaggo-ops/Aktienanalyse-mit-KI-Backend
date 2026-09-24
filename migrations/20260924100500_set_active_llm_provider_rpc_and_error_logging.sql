-- profiles hat bewusst KEINE UPDATE-Policy fuer authenticated (siehe H1 im
-- Pentest-Bericht - schuetzt is_admin). active_llm_provider aendert sich
-- deshalb ueber eine SECURITY DEFINER RPC, gleiches Muster wie
-- set_my_username() (20260921140000): validiert selbst, aendert
-- ausschliesslich die eigene Zeile.
create or replace function set_active_llm_provider(p_provider text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if p_provider not in ('claude', 'openai', 'gemini', 'openrouter') then
    raise exception 'Unbekannter Anbieter: %', p_provider;
  end if;

  insert into profiles (id) values (auth.uid()) on conflict (id) do nothing;
  update profiles set active_llm_provider = p_provider where id = auth.uid();
end;
$$;
revoke execute on function set_active_llm_provider(text) from public, anon;
grant execute on function set_active_llm_provider(text) to authenticated;

-- Pentest-Scratchpad-Muster (llm_provider ergaenzt): bei Fehlern sofort
-- erkennbar, welcher LLM-Anbieter betroffen war (unterschiedliche
-- Rate-Limits/Fehlercodes pro Anbieter). Nullable - die meisten
-- function_errors-Zeilen (save-api-keys, delete-account, ...) haben keinen
-- LLM-Bezug.
alter table function_errors
  add column if not exists llm_provider text;
