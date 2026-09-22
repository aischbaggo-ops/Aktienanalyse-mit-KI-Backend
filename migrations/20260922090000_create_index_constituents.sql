-- Manuell gepflegte Fallback-Tabelle fuer Index-Mitglieder, die der FMP-
-- Konstituenten-Endpoint (Free-Plan) nicht abdeckt - voraussichtlich vor
-- allem DAX/MDAX/SDAX, siehe getIndexConstituents() in index-constituents.
-- Wird nur fuer Indizes befuellt, die FMP nachweislich nicht liefert.
--
-- "rank" ist die Reihenfolge, wie sie gepflegt/geliefert wird (Index-
-- Gewichtung, falls bekannt, sonst Quellenreihenfolge) - dient "Top N" als
-- Sortierkriterium. Keine FMP- oder Boersen-Vorgabe, rein redaktionell.
create table if not exists index_constituents (
  index_id text not null,
  rank int not null,
  ticker text not null,
  name text not null,
  updated_at timestamptz not null default now(),
  primary key (index_id, ticker)
);

create index if not exists index_constituents_index_id_rank_idx
  on index_constituents (index_id, rank);

alter table index_constituents enable row level security;

-- Tickerlisten sind oeffentlich bekannte Information, keine Nutzerdaten -
-- jeder eingeloggte Nutzer darf lesen (fuer die Index-Auswahl im Batch-
-- Feature). Geschrieben wird nur manuell durch einen Admin.
create policy index_constituents_select_authenticated
  on index_constituents
  for select
  to authenticated
  using (true);

-- Gleiches is_admin-Muster wie feature_access/access_requests.
create policy index_constituents_admin_all
  on index_constituents
  for all
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  )
  with check (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );
