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
//   env.GHL_PIT               — GHL Private Integration Token
//   env.MASTER_ADMIN_PASSWORD — Miriam's own cross-client fallback login
//   env.MENTORSHIP_WEBHOOK_SECRET — shared secret for /webhook/session-booked
// Kerry's own admin password is NOT a secret — it's a salted hash in KV
// (see PASSWORD_KV_KEY below), self-resettable via /forgot-password.
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

// Reverse of the above, for offering existing GHL fields to attach to a
// form. Only TEXT/LARGE_TEXT are listed as candidates (the only dataTypes
// this tool ever creates) — other GHL dataTypes (SINGLE_OPTIONS, DATE,
// FILE_UPLOAD, etc.) don't have a form-field equivalent here.
const DATATYPE_TO_TYPE = {
  TEXT: "text",
  LARGE_TEXT: "textarea",
};

const ALLOWED_ORIGINS = [
  "https://kerrykott.com",
  "https://www.kerrykott.com",
  "https://go.kerrykott.com",
  "https://admin.kerrykott.com",
  "https://schedule.kerrykott.com",
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

// ---------- Calendars (schedule.kerrykott.com) ----------
// One KV blob holding every calendar page Kerry has generated. Each entry:
//   { id, slug, name, duration, platform, description, embedUrl }
// `id` is assigned once and never changes (stable identity while editing);
// `slug` is the public URL segment on schedule.kerrykott.com and can be
// renamed freely as long as it stays unique. No per-calendar GHL side
// effects, so unlike forms this is a single wholesale get/save, same shape
// as the forms registry.

async function loadCalendars(env) {
  const raw = await env.CONFIG.get("calendars");
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveCalendars(env, calendars) {
  await env.CONFIG.put("calendars", JSON.stringify(calendars));
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Kerry may paste GHL's whole <iframe> embed snippet instead of the bare
// widget URL — pull the src out rather than reject it.
function extractEmbedUrl(raw) {
  const s = String(raw || "").trim();
  const m = /<iframe[^>]*\ssrc=["']([^"']+)["']/i.exec(s);
  return (m ? m[1] : s).trim();
}

function genCalId() {
  return "cal_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function handleCalendarGet(request, env, cors) {
  const slug = new URL(request.url).searchParams.get("slug");
  if (!slug) return json({ error: "Missing slug" }, 400, cors);
  const calendars = await loadCalendars(env);
  const cal = calendars.find((c) => c.slug === slug);
  if (!cal) return json({ error: "Not found" }, 404, cors);
  return json(cal, 200, cors);
}

async function handleAdminCalendarsGet(request, env, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, cors);
  return json(await loadCalendars(env), 200, cors);
}

async function handleAdminCalendarsSave(request, env, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, cors);
  let d;
  try { d = await request.json(); }
  catch { return json({ error: "Bad JSON" }, 400, cors); }
  if (!Array.isArray(d)) return json({ error: "Calendars must be an array" }, 400, cors);

  const seenSlugs = new Set();
  const out = [];
  for (const c of d) {
    const name = String(c.name || "").trim();
    const slug = String(c.slug || "").trim().toLowerCase();
    const embedUrl = extractEmbedUrl(c.embedUrl);
    if (!name) return json({ error: "Every calendar needs a name." }, 400, cors);
    if (!slug || !SLUG_RE.test(slug)) {
      return json({ error: `"${name}" has an invalid slug — use lowercase letters, numbers, and hyphens only.` }, 400, cors);
    }
    if (seenSlugs.has(slug)) {
      return json({ error: `The slug "${slug}" is used by more than one calendar.` }, 400, cors);
    }
    seenSlugs.add(slug);
    if (!embedUrl) return json({ error: `"${name}" needs a GHL calendar embed link.` }, 400, cors);
    out.push({
      id: c.id || genCalId(),
      slug,
      name,
      duration: String(c.duration || "").trim(),
      platform: String(c.platform || "").trim(),
      description: String(c.description || "").trim(),
      embedUrl,
    });
  }

  await saveCalendars(env, out);
  return json(out, 200, cors);
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

// Miriam's own password, the same across every client admin, checked
// independently of Kerry's own password so it keeps working no matter what
// she sets or resets hers to. Value lives in
// ~/Desktop/Claude/ADMIN/master-admin-password.txt. Kerry is never given
// this one — it's Miriam's fallback, not Kerry's login.
function isMasterPassword(candidate, env) {
  return !!env.MASTER_ADMIN_PASSWORD && safeEqual(candidate, env.MASTER_ADMIN_PASSWORD);
}

/* ------------------------------------------------------------------------
 * Kerry's own admin password. Lives ONLY as a salted hash in KV (never as a
 * Worker secret, which is what made the last incident possible — changing
 * it required a code deploy Miriam had to do by hand, and it silently
 * invalidated whatever Kerry had memorized). A "Forgot password?" flow
 * below lets her reset it herself via a one-time emailed link — the same
 * pattern already proven on Jodi Kahn's admin (jodi-kahn/worker/worker.js).
 * ------------------------------------------------------------------------ */

const PASSWORD_KV_KEY = "admin:password_hash";
const RESET_KV_KEY = "admin:reset_token";
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const ADMIN_RESET_EMAIL = "kerrykott@gmail.com";
const ADMIN_ORIGIN = "https://admin.kerrykott.com";

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function passwordHash(password) {
  return sha256Hex(LOCATION_ID + ":" + password);
}

async function checkOwnPassword(candidate, env) {
  if (!candidate) return false;
  const stored = await env.CONFIG.get(PASSWORD_KV_KEY);
  if (!stored) return false;
  return safeEqual(await passwordHash(candidate), stored);
}

async function requireAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/.exec(auth);
  const pw = m ? m[1] : "";
  if (!pw) return false;
  if (isMasterPassword(pw, env)) return true;
  return checkOwnPassword(pw, env);
}

// Emails a one-time reset link through Kerry's own GHL account (the same
// PIT this Worker already holds), sent as a normal conversation message.
// GHL's send API is contact-based, so this upserts a small internal contact
// for the admin's own reset address rather than emailing a bare address.
async function sendResetEmail(env, resetUrl) {
  const upsertRes = await fetch(`${BASE}/contacts/upsert`, {
    method: "POST",
    headers: ghlHeaders(env),
    body: JSON.stringify({
      locationId: LOCATION_ID,
      email: ADMIN_RESET_EMAIL,
      firstName: "Kerry Kott",
      lastName: "(admin account)",
      source: "admin.kerrykott.com password reset",
    }),
  });
  if (!upsertRes.ok) throw new Error(`contact upsert ${upsertRes.status}`);
  const upserted = await upsertRes.json();
  const contactId = (upserted.contact && upserted.contact.id) || upserted.id;
  if (!contactId) throw new Error("no contact id returned");

  const html = `<div>Someone asked to reset the password for admin.kerrykott.com.</div>`
    + `<div>Set a new one here: <a href="${resetUrl}">${resetUrl}</a></div>`
    + `<div>This link works once and expires in 30 minutes. If this wasn't you, ignore this email — the current password stays the same.</div>`;

  const sendRes = await fetch(`${BASE}/conversations/messages`, {
    method: "POST",
    headers: ghlHeaders(env),
    body: JSON.stringify({ type: "Email", contactId, subject: "Reset your admin password", html }),
  });
  if (!sendRes.ok) throw new Error(`send ${sendRes.status}`);
}

// POST /forgot-password — public on purpose (it's how access gets recovered)
async function handleForgotPassword(env, cors) {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const record = JSON.stringify({ hash: tokenHash, expires: Date.now() + RESET_TOKEN_TTL_MS });
  await env.CONFIG.put(RESET_KV_KEY, record, { expirationTtl: Math.ceil(RESET_TOKEN_TTL_MS / 1000) });

  try {
    await sendResetEmail(env, `${ADMIN_ORIGIN}/?reset=${token}`);
  } catch (err) {
    return json({ error: "Could not send the email." }, 502, cors);
  }
  return json({ ok: true, email: ADMIN_RESET_EMAIL }, 200, cors);
}

// POST /admin/reset-password — public but token-gated, not password-gated
async function handleAdminResetPassword(request, env, cors) {
  let d;
  try { d = await request.json(); }
  catch { return json({ error: "Bad JSON" }, 400, cors); }
  const token = String(d.token || "");
  const password = String(d.password || "");
  if (!token) return json({ error: "Missing token" }, 400, cors);
  if (password.length < 6) return json({ error: "Please choose a password of at least 6 characters." }, 400, cors);

  const raw = await env.CONFIG.get(RESET_KV_KEY);
  let record = null;
  try { record = JSON.parse(raw || "null"); } catch { record = null; }
  const expiredMsg = "That link has expired. Request a new one from the sign-in page.";
  if (!record || !record.hash || !record.expires) return json({ error: expiredMsg }, 400, cors);
  if (Date.now() > record.expires) return json({ error: expiredMsg }, 400, cors);
  if ((await sha256Hex(token)) !== record.hash) {
    return json({ error: "That link is not valid. Request a new one from the sign-in page." }, 400, cors);
  }

  await env.CONFIG.put(PASSWORD_KV_KEY, await passwordHash(password));
  await env.CONFIG.delete(RESET_KV_KEY); // one-time use: can't replay the same email link

  return json({ ok: true }, 200, cors);
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
  // submitted answer matches, tell the client to stop (not advance/succeed),
  // but still tag the contact with BOTH the stage's own tag(s) (they signed
  // up for whatever this stage/form is — e.g. the waitlist — same as anyone
  // else) AND the exit tag(s) (e.g. "Not Female"), plus honor removeTags,
  // same as the normal path below.
  if (stage.exit && d[stage.exit.field] === stage.exit.equals) {
    const exitTags = Array.isArray(stage.exit.tag) ? stage.exit.tag : [stage.exit.tag];
    const baseTags = stage.tag ? (Array.isArray(stage.tag) ? stage.tag : [stage.tag]) : [];
    const tags = [...baseTags, ...exitTags];
    if (tags.length) {
      const tagRes = await fetch(`${BASE}/contacts/${contactId}/tags`, {
        method: "POST", headers, body: JSON.stringify({ tags }),
      });
      if (!tagRes.ok) return json({ error: "Tag failed", detail: await tagRes.text() }, 502, cors);
    }
    if (stage.removeTags && stage.removeTags.length) {
      const rmRes = await fetch(`${BASE}/contacts/${contactId}/tags`, {
        method: "DELETE", headers, body: JSON.stringify({ tags: stage.removeTags }),
      });
      if (!rmRes.ok) return json({ error: "Tag removal failed", detail: await rmRes.text() }, 502, cors);
    }
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
  const supplied = d.password || "";
  if (isMasterPassword(supplied, env) || (await checkOwnPassword(supplied, env))) {
    return json({ ok: true }, 200, cors);
  }
  return json({ error: "Wrong password" }, 401, cors);
}

// ---------- /admin/config (GET) ----------

async function handleAdminConfigGet(request, env, cors, formKey) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, cors);
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
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, cors);

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

// ---------- /admin/ghl-fields (GET) ----------
// Lists existing GHL custom fields so the admin can attach a form question
// to one already in use elsewhere, instead of always creating a new field.

async function handleAdminGhlFields(request, env, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, cors);

  const res = await fetch(`${BASE}/locations/${LOCATION_ID}/customFields`, {
    headers: ghlHeaders(env),
  });
  if (!res.ok) {
    const detail = await res.text();
    return json({ error: "Couldn't load GHL fields", detail }, 502, cors);
  }
  const out = await res.json();
  const fields = (out.customFields || [])
    .filter((f) => DATATYPE_TO_TYPE[f.dataType])
    .map((f) => ({
      id: f.id,
      fieldKey: f.fieldKey,
      name: f.name,
      dataType: f.dataType,
      type: DATATYPE_TO_TYPE[f.dataType],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return json(fields, 200, cors);
}

// ---------- /admin/registry ----------

async function handleRegistryGet(request, env, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, cors);
  return json(await loadRegistry(env), 200, cors);
}

async function handleRegistrySave(request, env, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, cors);
  let d;
  try { d = await request.json(); }
  catch { return json({ error: "Bad JSON" }, 400, cors); }
  if (!Array.isArray(d)) return json({ error: "Registry must be an array" }, 400, cors);
  await saveRegistry(env, d);
  return json(d, 200, cors);
}

// ---------- /admin/duplicate-form ----------

async function handleDuplicateForm(request, env, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, cors);
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
  // NOTE: `newLabel` names the ADMIN tab (registry.label) only — it never
  // touches `title` (also the visible heading on the live page, if any).
  // That stays whatever the source form had; renaming a form in the admin
  // must never change what its live page says.
  const newCfg = JSON.parse(JSON.stringify(sourceCfg));
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

// ---------- /admin/delete-form ----------

async function handleDeleteForm(request, env, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, cors);
  let d;
  try { d = await request.json(); }
  catch { return json({ error: "Bad JSON" }, 400, cors); }

  const key = d.key;
  if (!key) return json({ error: "key is required" }, 400, cors);

  const registry = await loadRegistry(env);
  if (!registry.some((f) => f.key === key)) return json({ error: "Unknown form" }, 400, cors);

  const next = registry.filter((f) => f.key !== key);
  await saveRegistry(env, next);
  await env.CONFIG.delete(`config:${key}`);

  return json({ ok: true }, 200, cors);
}

// ---------- Mentorship (schedule.kerrykott.com/mentorship-call/<contactId>) ----------
// One shared GHL calendar (MENTORSHIP_CALENDAR_ID) is used by every mentee.
// Package/Sessions Allowed/Sessions Left/Booking Link are set on the contact
// by Kerry's purchase workflow (one per package). This Worker never writes
// Package or Sessions Allowed — only Sessions Left, on booking or manual
// adjustment from the admin's Mentorship tab.

const MENTORSHIP_CALENDAR_ID = "uY9PQylQAOc1mXKdmuST";

const MENTORSHIP_FIELD_IDS = {
  package: "8c24ZFdqWDLd5uSiA9Fh",         // Package
  sessionsAllowed: "IRisq29ma9xrQoNbYFM7", // Sessions Allowed
  sessionsLeft: "qY4MBCDZDzPlZmjlhca4",    // Sessions Left
  bookingLink: "ceM8hz091LYP5Iqs5WIz",     // Booking Link
};

// Pace is informational only (shown to Kerry and the mentee) — booking is
// never blocked for exceeding it.
const PACKAGE_RULES = {
  "1-Month": { period: "week", cap: 1 },
  "3-Month": { period: "month", cap: 2 },
  "6-Month": { period: "month", cap: 2 },
};

async function getContact(env, contactId) {
  const res = await fetch(`${BASE}/contacts/${contactId}`, { headers: ghlHeaders(env) });
  if (!res.ok) return null;
  const out = await res.json();
  return out.contact || null;
}

function cfValue(contact, fieldId) {
  const cf = (contact.customFields || []).find((f) => f.id === fieldId);
  return cf ? cf.value : "";
}

async function setSessionsLeft(env, contactId, value) {
  const res = await fetch(`${BASE}/contacts/${contactId}`, {
    method: "PUT",
    headers: ghlHeaders(env),
    body: JSON.stringify({
      customFields: [{ id: MENTORSHIP_FIELD_IDS.sessionsLeft, field_value: value }],
    }),
  });
  return res.ok;
}

// Mon–Sun for "week", calendar-month for "month", both in UTC.
function currentPeriodWindow(period) {
  const now = new Date();
  if (period === "week") {
    const diffToMonday = (now.getUTCDay() + 6) % 7;
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday));
    const end = new Date(start.getTime() + 7 * 86400000);
    return { start, end };
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

async function fetchAppointments(env, contactId, start, end) {
  const params = new URLSearchParams({
    locationId: LOCATION_ID,
    calendarId: MENTORSHIP_CALENDAR_ID,
    contactId,
    startTime: String(start.getTime()),
    endTime: String(end.getTime()),
  });
  try {
    const res = await fetch(`${BASE}/calendars/events?${params}`, { headers: ghlHeaders(env) });
    if (!res.ok) return [];
    const out = await res.json();
    return (out.events || []).filter((e) => e.appointmentStatus !== "cancelled");
  } catch {
    return [];
  }
}

async function countAppointmentsInWindow(env, contactId, start, end) {
  return (await fetchAppointments(env, contactId, start, end)).length;
}

// All-time appointment history for a mentee (no window) — the ground truth
// for "how many has this person actually booked", since Sessions Left
// floors at 0 and stops reflecting reality once someone books past their
// allotment.
const EPOCH_START = new Date(0);
const FAR_FUTURE = new Date(Date.now() + 10 * 365 * 86400000);
async function listAllAppointments(env, contactId) {
  const events = await fetchAppointments(env, contactId, EPOCH_START, FAR_FUTURE);
  return events
    .map((e) => e.startTime)
    .filter(Boolean)
    .sort();
}

function mentorshipSummary(contact) {
  const pkg = cfValue(contact, MENTORSHIP_FIELD_IDS.package);
  if (!pkg) return null;
  const allowed = Number(cfValue(contact, MENTORSHIP_FIELD_IDS.sessionsAllowed)) || 0;
  const left = Number(cfValue(contact, MENTORSHIP_FIELD_IDS.sessionsLeft)) || 0;
  return {
    name: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.contactName || "",
    email: contact.email || "",
    package: pkg,
    sessionsAllowed: allowed,
    sessionsBooked: Math.max(allowed - left, 0),
    sessionsLeft: left,
  };
}

// GET /mentee?id=<contactId> — public (the personalized booking page reads this)
async function handleMenteeGet(request, env, cors) {
  const contactId = new URL(request.url).searchParams.get("id");
  if (!contactId) return json({ error: "Missing id" }, 400, cors);
  const contact = await getContact(env, contactId);
  if (!contact) return json({ error: "Not found" }, 404, cors);
  const summary = mentorshipSummary(contact);
  if (!summary) return json({ error: "Not found" }, 404, cors);

  let pace = null;
  const rule = PACKAGE_RULES[summary.package];
  if (rule) {
    const { start, end } = currentPeriodWindow(rule.period);
    const used = await countAppointmentsInWindow(env, contactId, start, end);
    pace = { used, cap: rule.cap, period: rule.period };
  }

  return json({ ...summary, pace }, 200, cors);
}

// GET /admin/mentees — protected (the admin's Mentorship tab)
async function handleAdminMenteesGet(request, env, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, cors);
  const res = await fetch(`${BASE}/contacts/search`, {
    method: "POST",
    headers: ghlHeaders(env),
    body: JSON.stringify({
      locationId: LOCATION_ID,
      pageLimit: 100,
      filters: [{ field: `customFields.${MENTORSHIP_FIELD_IDS.package}`, operator: "exists" }],
    }),
  });
  if (!res.ok) return json({ error: "Couldn't load mentees from GHL" }, 502, cors);
  const out = await res.json();
  const base = (out.contacts || [])
    .map((c) => {
      const summary = mentorshipSummary(c);
      return summary && { contactId: c.id, ...summary };
    })
    .filter(Boolean);

  const mentees = await Promise.all(base.map(async (m) => {
    const sessions = await listAllAppointments(env, m.contactId);
    const rule = PACKAGE_RULES[m.package];
    let pace = null;
    if (rule) {
      const { start, end } = currentPeriodWindow(rule.period);
      const used = await countAppointmentsInWindow(env, m.contactId, start, end);
      pace = { used, cap: rule.cap, period: rule.period };
    }
    return {
      ...m,
      sessions,
      sessionsBooked: sessions.length, // ground truth — the field's derived value floors at sessionsAllowed
      overAllotment: sessions.length > m.sessionsAllowed,
      pace,
      overPace: !!(pace && pace.used > pace.cap),
    };
  }));

  return json(mentees, 200, cors);
}

// POST /admin/mentees/adjust {contactId, delta} — protected. Manual +1/-1 to
// Sessions Left (comping a session, fixing a mistake), clamped to
// [0, sessionsAllowed].
async function handleAdminMenteeAdjust(request, env, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: "Unauthorized" }, 401, cors);
  let d;
  try { d = await request.json(); }
  catch { return json({ error: "Bad JSON" }, 400, cors); }
  const contactId = d.contactId;
  const delta = Number(d.delta);
  if (!contactId || !delta) return json({ error: "contactId and delta required" }, 400, cors);

  const contact = await getContact(env, contactId);
  const summary = contact && mentorshipSummary(contact);
  if (!summary) return json({ error: "Not found" }, 404, cors);

  const next = Math.max(0, Math.min(summary.sessionsAllowed, summary.sessionsLeft + delta));
  const ok = await setSessionsLeft(env, contactId, next);
  if (!ok) return json({ error: "Couldn't update GHL" }, 502, cors);
  return json({ ok: true, sessionsLeft: next }, 200, cors);
}

// POST /webhook/session-booked {contactId} — called by Kerry's "Mentorship
// call booked" GHL workflow (Appointment Created on the mentorship calendar).
// Decrements Sessions Left by 1, floored at 0. Guarded by a shared secret
// (env.MENTORSHIP_WEBHOOK_SECRET) since it's a public endpoint, unlike every
// other handler here which is gated on Kerry's admin password.
async function handleSessionBookedWebhook(request, env, cors) {
  const secret = request.headers.get("X-Webhook-Secret") || "";
  if (!env.MENTORSHIP_WEBHOOK_SECRET || !safeEqual(secret, env.MENTORSHIP_WEBHOOK_SECRET)) {
    return json({ error: "Unauthorized" }, 401, cors);
  }
  let d;
  try { d = await request.json(); }
  catch { return json({ error: "Bad JSON" }, 400, cors); }
  const contactId = d.contactId;
  if (!contactId) return json({ error: "contactId required" }, 400, cors);

  const contact = await getContact(env, contactId);
  const summary = contact && mentorshipSummary(contact);
  if (!summary) return json({ error: "Not found" }, 404, cors);

  const next = Math.max(0, summary.sessionsLeft - 1);
  const ok = await setSessionsLeft(env, contactId, next);
  if (!ok) return json({ error: "Couldn't update GHL" }, 502, cors);
  return json({ ok: true, sessionsLeft: next }, 200, cors);
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

    // POST /forgot-password — public (how Kerry recovers access herself)
    if (request.method === "POST" && path === "/forgot-password") {
      return handleForgotPassword(env, cors);
    }

    // POST /admin/reset-password — public but token-gated, not password-gated
    if (request.method === "POST" && path === "/admin/reset-password") {
      return handleAdminResetPassword(request, env, cors);
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

    // GET /admin/ghl-fields — protected
    if (request.method === "GET" && path === "/admin/ghl-fields") {
      return handleAdminGhlFields(request, env, cors);
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

    // POST /admin/delete-form — protected
    if (request.method === "POST" && path === "/admin/delete-form") {
      return handleDeleteForm(request, env, cors);
    }

    // GET /calendar?slug=<slug> — public (cal.html on schedule.kerrykott.com)
    if (request.method === "GET" && path === "/calendar") {
      return handleCalendarGet(request, env, cors);
    }

    // GET /admin/calendars — protected
    if (request.method === "GET" && path === "/admin/calendars") {
      return handleAdminCalendarsGet(request, env, cors);
    }

    // POST /admin/calendars — protected (saves the whole list)
    if (request.method === "POST" && path === "/admin/calendars") {
      return handleAdminCalendarsSave(request, env, cors);
    }

    // GET /mentee?id=<contactId> — public (schedule.kerrykott.com/mentorship-call/<id>)
    if (request.method === "GET" && path === "/mentee") {
      return handleMenteeGet(request, env, cors);
    }

    // GET /admin/mentees — protected
    if (request.method === "GET" && path === "/admin/mentees") {
      return handleAdminMenteesGet(request, env, cors);
    }

    // POST /admin/mentees/adjust — protected
    if (request.method === "POST" && path === "/admin/mentees/adjust") {
      return handleAdminMenteeAdjust(request, env, cors);
    }

    // POST /webhook/session-booked — called by the GHL "session booked" workflow
    if (request.method === "POST" && path === "/webhook/session-booked") {
      return handleSessionBookedWebhook(request, env, cors);
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
