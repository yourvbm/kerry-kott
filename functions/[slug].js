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
<link href="https://fonts.googleapis.com/css2?family=Sorts+Mill+Goudy:ital@0;1&family=Playfair+Display:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">
<style>
@font-face {
  font-family: 'sunflora-hksqi6';
  font-style: normal; font-weight: 400; font-display: swap;
  src: url('https://file.squarespace-cdn.com/content/v2/namespaces/fonts/libraries/5fad387af44df56affb45c67/assets/37ab1441-81a8-45bc-8fea-80033769339c/font.woff2') format('woff2');
}
#ef-cal{
  --cream:#F5F0EB; --ink:#2A221E; --border:#C7BCAD; --muted:#8C8073; --panel:#FBF9F6;
  --font-display:"sunflora-hksqi6","Playfair Display",Georgia,"Times New Roman",serif;
  --font-body:"Sorts Mill Goudy",Georgia,"Times New Roman",serif;
  background:var(--cream); color:var(--ink); font-family:var(--font-body);
  -webkit-font-smoothing:antialiased; line-height:1.5; min-height:100vh;
}
#ef-cal *{box-sizing:border-box;}
#ef-cal .ef-cal-shell{max-width:900px;margin:0 auto;padding:44px 24px 64px;}
#ef-cal .ef-cal-logo{display:block;width:220px;max-width:70%;height:auto;margin:0 auto 36px;}
#ef-cal .ef-cal-card{
  background:var(--panel); border:1.5px solid var(--border); border-radius:20px;
  display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.1fr); overflow:hidden;
}
#ef-cal .ef-cal-info{padding:44px 40px;}
#ef-cal .ef-cal-name{
  font-family:var(--font-display); font-weight:700; font-size:clamp(24px,3vw,30px);
  line-height:1.2; margin:0 0 8px;
}
#ef-cal .ef-cal-meta{font-size:15px;color:var(--muted);margin:0 0 22px;}
#ef-cal .ef-cal-desc{font-size:16px;line-height:1.65;margin:0;white-space:pre-wrap;}
#ef-cal .ef-cal-widget{border-left:1.5px solid var(--border);background:#fff;padding:18px;display:flex;}
#ef-cal .ef-cal-widget iframe{width:100%;border:none;min-height:560px;display:block;}
@media (max-width:760px){
  #ef-cal .ef-cal-card{grid-template-columns:1fr;border-radius:16px;}
  #ef-cal .ef-cal-info{padding:30px 26px;}
  #ef-cal .ef-cal-widget{border-left:none;border-top:1.5px solid var(--border);padding:14px;}
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
<script>
(function(){
  // The GHL booking widget posts its real content height on every resize
  // (including the date-picker -> booking-form jump) as
  // ["highlevel.setHeight", {height, id}]. Nothing applies it unless we
  // listen - and GHL's own form_embed.js is the WRONG fix here: it hides
  // the iframe until an "iframeLoaded" message the booking widget never
  // sends, so the calendar would stay invisible forever.
  var iframe = document.getElementById('ef-cal-iframe');
  window.addEventListener('message', function(e){
    if(e.source !== iframe.contentWindow) return;
    var data = e.data;
    try{ if(typeof data === 'string') data = JSON.parse(data); }catch(err){ return; }
    if(!Array.isArray(data) || data[0] !== 'highlevel.setHeight') return;
    var h = data[1] && data[1].height;
    if(typeof h === 'number' && h > 0){
      iframe.style.height = h + 'px';
      iframe.style.minHeight = h + 'px';
    }
  });
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
