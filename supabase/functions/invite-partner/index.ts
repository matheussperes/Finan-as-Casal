// Sprint 6 · CFG-01 — Convite do cônjuge.
// Chamada autenticada (JWT do membro logado). Usa a service role para:
//   1. validar que o chamador é membro de um casal;
//   2. criar o auth user do cônjuge via inviteUserByEmail (e-mail de convite);
//   3. vincular members.user_id — única via de vínculo: o cliente não tem
//      grant de UPDATE em user_id, então RLS + grants garantem que ninguém
//      entra num casal sem convite.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = Deno.env.get("APP_URL") ?? "https://finan-as-casal-five.vercel.app";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json(401, { error: "unauthorized" });

  let body: { email?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { error: "invalid_email", message: "E-mail inválido." });
  }
  if (email === (user.email ?? "").toLowerCase()) {
    return json(400, { error: "own_email", message: "Use o e-mail do cônjuge, não o seu." });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: caller, error: callerErr } = await admin
    .from("members")
    .select("id, household_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (callerErr) return json(500, { error: "db_error", message: callerErr.message });
  if (!caller) {
    return json(403, { error: "no_household", message: "Você ainda não tem um casal configurado." });
  }

  const { data: members, error: membersErr } = await admin
    .from("members")
    .select("id, user_id, invite_status")
    .eq("household_id", caller.household_id);
  if (membersErr) return json(500, { error: "db_error", message: membersErr.message });

  const partner = (members ?? []).find((m) => m.id !== caller.id);

  if (partner?.user_id) {
    if (partner.invite_status === "accepted") {
      return json(409, { error: "already_linked", message: "O cônjuge já tem acesso à plataforma." });
    }
    // Convite pendente: só reenviamos se o user antigo nunca entrou.
    const { data: oldUser } = await admin.auth.admin.getUserById(partner.user_id);
    if (oldUser?.user?.last_sign_in_at) {
      return json(409, { error: "already_linked", message: "O cônjuge já tem acesso à plataforma." });
    }
    const { error: delErr } = await admin.auth.admin.deleteUser(partner.user_id);
    if (delErr) return json(500, { error: "resend_failed", message: delErr.message });
  }

  const { data: invited, error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${APP_URL}/convite.html`,
    data: { household_id: caller.household_id, invited_by: user.id },
  });
  if (invErr || !invited?.user) {
    const msg = String(invErr?.message ?? "erro desconhecido");
    if (invErr?.status === 422 || /already|registered|exists/i.test(msg)) {
      return json(409, {
        error: "email_in_use",
        message: "Este e-mail já possui uma conta na plataforma. Use outro e-mail ou fale com o suporte.",
      });
    }
    return json(500, { error: "invite_failed", message: "Falha ao enviar o convite: " + msg });
  }

  const now = new Date().toISOString();
  let linkErr;
  if (partner) {
    ({ error: linkErr } = await admin
      .from("members")
      .update({
        user_id: invited.user.id,
        email,
        ...(name ? { name } : {}),
        invite_status: "pending",
        invited_at: now,
        updated_at: now,
      })
      .eq("id", partner.id));
  } else {
    ({ error: linkErr } = await admin.from("members").insert({
      household_id: caller.household_id,
      user_id: invited.user.id,
      name: name || email.split("@")[0],
      email,
      role: "partner",
      invite_status: "pending",
      invited_at: now,
    }));
  }
  if (linkErr) {
    // Não deixa auth user órfão se o vínculo falhar.
    await admin.auth.admin.deleteUser(invited.user.id);
    return json(500, { error: "link_failed", message: linkErr.message });
  }

  return json(200, { ok: true, message: "Convite enviado para " + email });
});
