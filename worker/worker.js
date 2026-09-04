// Kerry Kott — form handler (Cloudflare Worker)
// Kerry's forms (application / intake / waitlist) live on GitHub Pages and
// POST here. This Worker holds the GHL key as a secret and calls the
// LeadConnector API directly: no inbound webhooks, no workflow needed just
// to create the contact.
//   1) upsert the contact (dedupes on email/phone)
//   2) add the stage's tag via the tags endpoint (this is what fires her
//      GHL workflow automation)
//   3) remove any tags the stage says to remove (e.g. abandoned-cart
//      "Started" tag once the application is "Complete")
// Adding a tag this way APPENDS. Never put `tags` in the upsert body: GHL
// replaces the whole array and wipes every other tag the contact has.
//
// Form field config (labels, options, tags, GHL field keys) is NOT hardcoded
// here anymore — it lives in KV under `config:<formKey>` and is edited by
// Kerry herself through admin.html. This Worker just reads it at request
// time and executes what it says.
//
// Secrets (set in Cloudflare, never in this file):
//   env.GHL_PIT           — GHL Private Integration Token
//   env.ADMIN_PASSWORD    — password for admin.html
// Bindings:
//   env.CONFIG             — KV namespace holding config:<formKey> docs

const BASE = "https://services.leadconnectorhq.com";
const LOCATION_ID = "ps7itsG5PeLgg7TDwnGV";
const GHL_VERSION = "2021-07-28";

// Folder to create new custom fields in, per form. Waitlist has no folder —
// it only ever collects standard (native) contact fields, so it's absent
// on purpose: any attempt to create a custom field for it is rejected.
const CUSTOM_FIELD_FOLDERS = {
  application: "pGU3e8A5Yza3PDw7sBdA", // Retreat Application
  intake: "6J4UdKoukdLrxniDCVwa",      // Retreat Intake
  waitlist: null,                       // deliberately none — waitlist stays standard-fields-only
};
// Default folder for any form not listed above (new/duplicated forms via
// "+ Add Form"). `null` in CUSTOM_FIELD_FOLDERS (waitlist) overrides this;
// `undefined` (not in the map at all) falls through to it.
const MISC_FOLDER_ID = "A1hF3AhG1cwppMQIJOUh"; // "Misc Forms"

// Our field `type` -> GHL customField `dataType`.
const TYPE_TO_DATATYPE = {
  text: "TEXT",
  tel: "TEXT",
  date: "TEXT",
  email: "TEXT",
  textarea: "LARGE_TEXT",
  radio: "LARGE_TEXT",
  "checkbox-group": "LARGE_TEXT",
  checkbox: "LARGE_TEXT",
  select: "TEXT",
};

const ALLOWED_ORIGINS = [
  "https://kerrykott.com",
  "https://www.kerrykott.com",
  "https://go.kerrykott.com",
  "https://admin.kerrykott.com",
  "https://kerry-kott.pages.dev",
];

function allowed(origin) {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Cloudflare Pages preview deploys (e.g. 9fb72902.kerry-kott.pages.dev).
  if (/^https:\/\/[a-z0-9-]+\.kerry-kott\.pages\.dev$/i.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.squarespace\.com$/i.test(origin)) return true;
  // Local preview while building.
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
  // A page opened straight off disk (file://) sends Origin "null". Allowed so
  // the form can be tested by just opening the .html file. This is not a
  // security hole: the endpoint is public and unauthenticated either way, and
  // it uses no cookies, so CORS was never what was protecting it.
  if (origin === "null") return true;
  return false;
}

function corsHeaders(origin) {
  const ok = allowed(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// GHL silently drops any phone that is not E.164, so normalise before sending.
function e164(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  if (s.startsWith("+")) return "+" + s.slice(1).replace(/\D/g, "");
  const d = s.replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return "+" + d;
}

function ghlHeaders(env) {
  return {
    Authorization: `Bearer ${env.GHL_PIT}`,
    Version: GHL_VERSION,
    "Content-Type": "application/json",
  };
}

async function loadConfig(env, formKey) {
  const raw = await env.CONFIG.get(`config:${formKey}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveConfig(env, formKey, cfg) {
  await env.CONFIG.put(`config:${formKey}`, JSON.stringify(cfg));
}

// The registry is the list of forms the admin shows on its home screen and
// as tabs. Each entry: { key, label, path, kind }. `path` is the hosted
// page's URL path (no leading slash needed beyond SITE_ORIGIN + "/" + path);
// `kind` is "custom" (its own hand-built HTML file) or "generic" (served by
// the shared f.html template via ?form=<key>).
const DEFAULT_REGISTRY = [
  { key: "application", label: "Application", path: "application", kind: "custom", minHeight: 900 },
  { key: "intake", label: "Intake", path: "intake", kind: "custom", minHeight: 900 },
  { key: "waitlist", label: "Waitlist", path: "waitlist", kind: "custom", minHeight: 700 },
];

async function loadRegistry(env) {
  const raw = await env.CONFIG.get("registry");
  if (!raw) return DEFAULT_REGISTRY;
  try { return JSON.parse(raw); } catch { return DEFAULT_REGISTRY; }
}

async function saveRegistry(env, registry) {
  await env.CONFIG.put("registry", JSON.stringify(registry));
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "form";
}

// Constant-time-ish string compare (not truly timing-safe on all runtimes,
// but avoids the crudest short-circuit compare).
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function requireAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/.exec(auth);
  const pw = m ? m[1] : "";
  return safeEqual(pw, env.ADMIN_PASSWORD || "");
}

// ---------- /submit ----------

async function handleSubmit(request, env, cors, formKey) {
  let d;
  try { d = await request.json(); }
  catch { return json({ error: "Bad JSON" }, 400, cors); }

  // Honeypot: silently accept and drop bot fills.
  if (d.company_website) return json({ ok: true }, 200, cors);

  const cfg = await loadConfig(env, formKey);
  if (!cfg) return json({ error: "Unknown form" }, 400, cors);

  const stageId = new URL(request.url).searchParams.get("stage");
  const stage = cfg.stages.find((s) => s.id === stageId);
  if (!stage) return json({ error: "Unknown stage" }, 400, cors);

  const email = (d.email || "").trim().toLowerCase();
  const phone = e164(d.phone);
  if (!email && !phone) return json({ error: "Email or phone required" }, 400, cors);

  const headers = ghlHeaders(env);

  // Build the upsert body from standard fields.
  const body = {
    locationId: LOCATION_ID,
    source: cfg.source,
  };
  if (email) body.email = email;
  if (phone) body.phone = phone;
  if (d.firstName || d.first_name) body.firstName = (d.firstName || d.first_name || "").trim();
  if (d.lastName || d.last_name) body.lastName = (d.lastName || d.last_name || "").trim();
  if (d.country) body.country = d.country;
  if (d.dateOfBirth || d.date_of_birth) body.dateOfBirth = d.dateOfBirth || d.date_of_birth;

  // Build customFields from every non-standard field in this stage.
  // IMPORTANT: GHL's /contacts/upsert silently ignores customFields
  // addressed by `key`/`field_key` — verified by testing. It only applies
  // entries addressed by the field's real GHL `id`. So every non-standard
  // field must carry a `ghlFieldId` (populated at creation time, or backfilled
  // for pre-existing fields) in addition to the human-readable `ghlKey`.
  const customFields = [];
  for (const f of stage.fields) {
    if (f.standard) continue;
    if (!f.ghlFieldId) continue; // shouldn't happen post-save, but be safe
    const val = d[f.id];
    if (val === undefined || val === null || val === "") continue;
    customFields.push({ id: f.ghlFieldId, field_value: val });
  }
  if (customFields.length) body.customFields = customFields;

  const up = await fetch(`${BASE}/contacts/upsert`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  if (!up.ok) return json({ error: "Upsert failed", detail: await up.text() }, 502, cors);

  const contactId = (await up.json()).contact?.id;
  if (!contactId) return json({ error: "No contact id" }, 502, cors);

  // A stage can carry an `exit` gate (e.g. an eligibility question) — if the
  // submitted answer matches, apply the exit tag(s) INSTEAD of the stage's
  // normal tag/removeTags and tell the client to stop (not advance/succeed).
  // Never both: someone who's screened out never gets the stage's own tag.
  if (stage.exit && d[stage.exit.field] === stage.exit.equals) {
    const exitTags = Array.isArray(stage.exit.tag) ? stage.exit.tag : [stage.exit.tag];
    const tagRes = await fetch(`${BASE}/contacts/${contactId}/tags`, {
      method: "POST", headers, body: JSON.stringify({ tags: exitTags }),
    });
    if (!tagRes.ok) return json({ error: "Tag failed", detail: await tagRes.text() }, 502, cors);
    return json({ ok: true, contactId, exited: true, message: stage.exit.message }, 200, cors);
  }

  // Add the stage tag(s) (this is what fires her workflow). NEVER put `tags`
  // in the upsert body above — see the header comment.
  if (stage.tag) {
    const tags = Array.isArray(stage.tag) ? stage.tag : [stage.tag];
    const tagRes = await fetch(`${BASE}/contacts/${contactId}/tags`, {
      method: "POST", headers, body: JSON.stringify({ tags }),
    });
    if (!tagRes.ok) return json({ error: "Tag failed", detail: await tagRes.text() }, 502, cors);
  }

  // Remove any tags this stage says to remove (e.g. abandoned-cart Started
  // tag once Complete fires).
  if (stage.removeTags && stage.removeTags.length) {
    const rmRes = await fetch(`${BASE}/contacts/${contactId}/tags`, {
      method: "DELETE", headers, body: JSON.stringify({ tags: stage.removeTags }),
    });
    if (!rmRes.ok) return json({ error: "Tag removal failed", detail: await rmRes.text() }, 502, cors);
  }

  return json({ ok: true, contactId }, 200, cors);
}

// ---------- /config ----------

async function handleConfigGet(env, cors, formKey) {
  const cfg = await loadConfig(env, formKey);
  if (!cfg) return json({ error: "Unknown form" }, 404, cors);
  return json(cfg, 200, cors);
}

// ---------- /admin/login ----------

async function handleAdminLogin(request, env, cors) {
  let d;
  try { d = await request.json(); }
  catch { return json({ error: "Bad JSON" }, 400, cors); }
  if (safeEqual(d.password || "", env.ADMIN_PASSWORD || "")) {
    return json({ ok: true }, 200, cors);
  }
  return json({ error: "Wrong password" }, 401, cors);
}

// ---------- /admin/config (GET) ----------

async function handleAdminConfigGet(request, env, cors, formKey) {
  if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401, cors);
  return handleConfigGet(env, cors, formKey);
}

// ---------- /admin/config (POST — save, creating GHL custom fields as needed) ----------

async function createCustomField(env, folderId, name, dataType) {
  const headers = ghlHeaders(env);
  const res = await fetch(`${BASE}/locations/${LOCATION_ID}/customFields`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, dataType, parentId: folderId }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Custom field creation failed: ${detail}`);
  }
  const out = await res.json();
  return out.customField; // { id, fieldKey, ... }
}

async function handleAdminConfigSave(request, env, cors) {
  if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401, cors);

  let d;
  try { d = await request.json(); }
  catch { return json({ error: "Bad JSON" }, 400, cors); }

  const formKey = d.form;
  const cfg = d.config;
  if (!formKey || !cfg || !Array.isArray(cfg.stages)) {
    return json({ error: "Bad config payload" }, 400, cors);
  }

  const folderId = (formKey in CUSTOM_FIELD_FOLDERS) ? CUSTOM_FIELD_FOLDERS[formKey] : MISC_FOLDER_ID;

  try {
    for (const stage of cfg.stages) {
      for (const f of stage.fields || []) {
        if (f.standard) continue;
        if (f.ghlFieldId) continue; // already exists in GHL
        if (!folderId) {
          throw new Error(
            `Cannot add custom field "${f.label}" to "${formKey}" — this form has no GHL custom-field folder.`
          );
        }
        const dataType = TYPE_TO_DATATYPE[f.type] || "TEXT";
        const created = await createCustomField(env, folderId, f.label, dataType);
        f.ghlKey = created.fieldKey;
        f.ghlFieldId = created.id;
        f.ghlName = f.label;
        f.dataType = dataType;
      }
    }
  } catch (err) {
    return json({ error: "Save failed", detail: String(err && err.message || err) }, 502, cors);
  }

  await saveConfig(env, formKey, cfg);
  return json(cfg, 200, cors);
}

// ---------- /admin/registry ----------

async function handleRegistryGet(request, env, cors) {
  if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401, cors);
  return json(await loadRegistry(env), 200, cors);
}

async function handleRegistrySave(request, env, cors) {
  if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401, cors);
  let d;
  try { d = await request.json(); }
  catch { return json({ error: "Bad JSON" }, 400, cors); }
  if (!Array.isArray(d)) return json({ error: "Registry must be an array" }, 400, cors);
  await saveRegistry(env, d);
  return json(d, 200, cors);
}

// ---------- /admin/duplicate-form ----------

async function handleDuplicateForm(request, env, cors) {
  if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401, cors);
  let d;
  try { d = await request.json(); }
  catch { return json({ error: "Bad JSON" }, 400, cors); }

  const sourceKey = d.sourceKey;
  const newLabel = (d.newLabel || "").trim();
  if (!sourceKey || !newLabel) return json({ error: "sourceKey and newLabel are required" }, 400, cors);

  const registry = await loadRegistry(env);
  const sourceEntry = registry.find((f) => f.key === sourceKey);
  if (!sourceEntry) return json({ error: "Unknown source form" }, 400, cors);

  const sourceCfg = await loadConfig(env, sourceKey);
  if (!sourceCfg) return json({ error: "Source form has no config" }, 400, cors);
  if ((sourceCfg.stages || []).length > 1) {
    return json({ error: `"${sourceEntry.label}" has multiple steps (like an abandoned-cart flow) — only single-step forms can be duplicated right now.` }, 400, cors);
  }

  let newKey = slugify(newLabel);
  let suffix = 2;
  while (registry.some((f) => f.key === newKey)) { newKey = `${slugify(newLabel)}-${suffix}`; suffix++; }

  // Deep clone via JSON round-trip (config is plain data, no functions).
  const newCfg = JSON.parse(JSON.stringify(sourceCfg));
  newCfg.title = newLabel;
  newCfg.source = newLabel;
  // Strip GHL field bindings on every non-standard field — the clone is a
  // separate form and must never write into the SAME GHL custom field as
  // its source (that would corrupt both forms' data). The next admin save
  // auto-creates fresh fields for it, same as adding a brand-new field.
  for (const stage of newCfg.stages || []) {
    for (const f of stage.fields || []) {
      if (f.standard) continue;
      delete f.ghlFieldId;
      delete f.ghlKey;
      delete f.ghlName;
    }
  }

  await saveConfig(env, newKey, newCfg);
  registry.push({ key: newKey, label: newLabel, path: "f", kind: "generic", minHeight: 700 });
  await saveRegistry(env, registry);

  return json({ ok: true, key: newKey, label: newLabel }, 200, cors);
}

// ---------- router ----------

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const path = url.pathname.replace(/\/+$/, "") || "/";

    // GET /config?form=<key> — public
    if (request.method === "GET" && path === "/config") {
      const formKey = url.searchParams.get("form");
      if (!formKey) return json({ error: "Missing form" }, 400, cors);
      return handleConfigGet(env, cors, formKey);
    }

    // POST /submit?form=<key>&stage=<stageId> — public
    if (request.method === "POST" && path === "/submit") {
      const formKey = url.searchParams.get("form");
      if (!formKey) return json({ error: "Missing form" }, 400, cors);
      return handleSubmit(request, env, cors, formKey);
    }

    // POST /admin/login
    if (request.method === "POST" && path === "/admin/login") {
      return handleAdminLogin(request, env, cors);
    }

    // GET /admin/config?form=<key> — protected
    if (request.method === "GET" && path === "/admin/config") {
      const formKey = url.searchParams.get("form");
      if (!formKey) return json({ error: "Missing form" }, 400, cors);
      return handleAdminConfigGet(request, env, cors, formKey);
    }

    // POST /admin/config — protected
    if (request.method === "POST" && path === "/admin/config") {
      return handleAdminConfigSave(request, env, cors);
    }

    // GET /admin/registry — protected
    if (request.method === "GET" && path === "/admin/registry") {
      return handleRegistryGet(request, env, cors);
    }

    // POST /admin/registry — protected
    if (request.method === "POST" && path === "/admin/registry") {
      return handleRegistrySave(request, env, cors);
    }

    // POST /admin/duplicate-form — protected
    if (request.method === "POST" && path === "/admin/duplicate-form") {
      return handleDuplicateForm(request, env, cors);
    }

    // ---- Legacy support: bare POST / (or POST /?form=waitlist) with no
    // /submit path and no ?stage=, from the old worker.js contract. The
    // live waitlist page has already been rewritten to use /submit?stage=
    // as part of this same deploy, but keep this so any cached/old copy of
    // the page (or a stray browser tab) doesn't silently start failing
    // mid-migration. Waitlist's only stage is "complete".
    if (request.method === "POST" && path === "/") {
      const formKey = url.searchParams.get("form") || "waitlist";
      if (formKey === "waitlist" && !url.searchParams.get("stage")) {
        url.searchParams.set("stage", "complete");
        const patched = new Request(url.toString(), request);
        return handleSubmit(patched, env, cors, formKey);
      }
    }

    return json({ error: "Not found" }, 404, cors);
  },
};
