/**
 * Kerry's self-service calendar pages: /private-retreat-intake, /discovery-call,
 * whatever she adds next in the admin's Calendars tab at schedule.kerrykott.com.
 * One file serves all of them, matching the pattern already proven on Jodi
 * Kahn's site (jodi-kahn/functions/[slug].js).
 *
 * The kerry-forms Worker owns the actual list (one KV blob, edited via
 * admin.html's Calendars tab). This Function asks it "what's at this slug?"
 * on every request, so a calendar Kerry adds is live immediately - no Pages
 * redeploy needed.
 *
 * Falls through to normal static/404 handling (context.next()) for any path
 * that isn't a calendar slug, so it never shadows /admin, /application,
 * /intake, /waitlist, /f, /embed-test, or robots.txt.
 */

const WORKER_BASE = 'https://kerry-forms.miriam-68c.workers.dev';
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LOGO_URL = 'https://assets.cdn.filesafe.space/ps7itsG5PeLgg7TDwnGV/media/6a47eac4989afcfcc93100ed.png';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function renderPage(cal, slug) {
  const name = esc(cal.name);
  const meta = esc([cal.duration, cal.platform].filter(Boolean).join(' | '));
  const description = esc(cal.description);
  const embedUrl = esc(cal.embedUrl);
  const canonical = 'https://schedule.kerrykott.com/' + slug;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — Kerry Kott</title>
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="${canonical}">
<link href="https://fonts.googleapis.com/css2?family=Sorts+Mill+Goudy:ital@0;1&family=EB+Garamond:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">
<style>
#ef-cal{
  --cream:#F5F0EB; --ink:#0A0A0A; --border:#C7BCAD; --muted:#3A3630; --panel:#FBF9F6;
  --font-display:"EB Garamond",Georgia,"Times New Roman",serif;
  --font-body:"Sorts Mill Goudy",Georgia,"Times New Roman",serif;
  background:var(--cream); color:var(--ink); font-family:var(--font-body);
  -webkit-font-smoothing:antialiased; line-height:1.5; min-height:100vh;
}
#ef-cal *{box-sizing:border-box;}
#ef-cal .ef-cal-shell{max-width:1160px;margin:0 auto;padding:48px 24px 64px;}
#ef-cal .ef-cal-logo{display:block;width:300px;max-width:75%;height:auto;margin:0 auto 40px;}
#ef-cal .ef-cal-card{
  background:#fff; border:1px solid var(--border); border-radius:8px;
  display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.6fr); gap:40px;
  padding:48px 44px;
}
#ef-cal .ef-cal-info{padding:4px 0 0;}
#ef-cal .ef-cal-name{
  font-family:var(--font-display); font-weight:700; font-size:clamp(24px,2.6vw,28px);
  line-height:1.2; margin:0 0 8px; color:var(--ink);
}
#ef-cal .ef-cal-meta{font-size:14px;color:var(--muted);margin:0 0 22px;}
#ef-cal .ef-cal-desc{font-size:16px;line-height:1.75;margin:0;white-space:pre-wrap;}
#ef-cal .ef-cal-widget{
  background:#fff; border:1px solid rgba(16,24,40,.12); border-radius:8px;
  overflow-x:auto; overflow-y:hidden; align-self:start;
}
#ef-cal .ef-cal-widget iframe{width:100%;min-width:360px;border:none;height:420px;display:block;}
@media (max-width:760px){
  #ef-cal .ef-cal-shell{padding:32px 14px 48px;}
  #ef-cal .ef-cal-card{grid-template-columns:1fr;padding:24px 16px;gap:22px;}
}
</style>
</head>
<body>
<div id="ef-cal">
  <div class="ef-cal-shell">
    <img class="ef-cal-logo" src="${LOGO_URL}" alt="Kerry Kott">
    <div class="ef-cal-card">
      <div class="ef-cal-info">
        <h1 class="ef-cal-name">${name}</h1>
        <p class="ef-cal-meta">${meta}</p>
        <p class="ef-cal-desc">${description}</p>
      </div>
      <div class="ef-cal-widget">
        <iframe id="ef-cal-iframe" src="${embedUrl}" scrolling="auto" title="Book a time"></iframe>
      </div>
    </div>
  </div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/iframe-resizer/4.3.9/iframeResizer.min.js"></script>
<script>
(function(){
  // GHL's booking widget already speaks the iframe-resizer child protocol
  // (it posts "[iFrameSizer]..." handshake messages on load - confirmed by
  // capturing them directly), but nothing happens with them unless the
  // PARENT half of iframe-resizer is running to complete the handshake.
  // Once it is, the widget reports its real height continuously via a
  // MutationObserver on every step of the flow (date -> time slot ->
  // booking form -> deposit/payment, whatever a given calendar has), not
  // just once at load - unlike the widget's one-shot "highlevel.setHeight"
  // message, which only ever reports the height of the FIRST screen and
  // would leave later, taller steps clipped.
  //
  // checkOrigin:false: the widget lives on a different subdomain
  // (links.kerrykott.com) than this page - that's expected, not a
  // cross-site risk, since it's Kerry's own GHL calendar.
  //
  // Do NOT use GHL's form_embed.js here instead - that script is for
  // forms/surveys, hides every iframe until an "iframeLoaded" message the
  // booking widget never sends, and the calendar would stay invisible
  // forever.
  if(window.iFrameResize){
    window.iFrameResize({ checkOrigin: false, heightCalculationMethod: 'lowestElement' }, '#ef-cal-iframe');
  }
})();
</script>
</body>
</html>`;
}

export async function onRequestGet(context) {
  const slug = context.params.slug;
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return context.next();

  let cal;
  try {
    const res = await fetch(WORKER_BASE + '/calendar?slug=' + encodeURIComponent(slug));
    if (!res.ok) return context.next();
    cal = await res.json();
  } catch (err) {
    return context.next();
  }
  if (!cal || !cal.embedUrl) return context.next();

  return new Response(renderPage(cal, slug), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, follow'
    }
  });
}
