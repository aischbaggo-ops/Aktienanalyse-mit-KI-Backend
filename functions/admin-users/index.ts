import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser } from "../_shared/auth.ts";
import { requireAdmin } from "../_shared/adminGate.ts";
import { logFunctionError } from "../_shared/logFunctionError.ts";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// "michael@example.com" -> "mic***@example.com": Admin kann Nutzer noch
// erkennen, die volle Adresse steht aber nicht in der Oberflaeche.
function maskEmail(email: string | undefined): string {
  if (!email) return "–";
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 3)}***@${domain}`;
}

// Liefert die Nutzerliste fuer die Admin-Freischaltung (nur Admins).
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(req);
  if ("error" in auth) return json({ error: auth.error }, auth.status);

  const admin = await requireAdmin(auth.userId);
  if (!admin.ok) return json({ error: admin.error }, admin.status);

  try {
    const { data: usersData, error: usersError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (usersError) throw new Error(usersError.message);

    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, is_admin, username, last_seen_at");
    if (profilesError) throw new Error(profilesError.message);
    const profileById = new Map((profiles ?? []).map((p: any) => [p.id, p]));

    const { data: access, error: accessError } = await supabase
      .from("feature_access")
      .select("user_id, feature, unlocked");
    if (accessError) throw new Error(accessError.message);

    const adminIds = new Set((profiles ?? []).filter((p: any) => p.is_admin).map((p: any) => p.id));
    const optionenIds = new Set(
      (access ?? []).filter((a: any) => a.feature === "optionen" && a.unlocked).map((a: any) => a.user_id),
    );

    const users = usersData.users.map((u) => ({
      id: u.id,
      ref: u.id.slice(0, 8),
      email_masked: maskEmail(u.email),
      username: profileById.get(u.id)?.username ?? null,
      last_seen_at: profileById.get(u.id)?.last_seen_at ?? null,
      created_at: u.created_at,
      is_admin: adminIds.has(u.id),
      optionen: optionenIds.has(u.id),
    }));

    return json({ users });
  } catch (e) {
    const message = (e as Error).message;
    await logFunctionError("admin-users", auth.userId, message);
    return json({ error: message }, 500);
  }
});
