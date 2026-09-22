/**
 * Kerry's per-mentee mentorship booking page:
 * schedule.kerrykott.com/mentorship-call/<contactId>
 *
 * One shared GHL calendar (the mentorship-call calendar) is booked by every
 * mentee, so this page's job is to show THIS contact's package + session
 * count above the same shared widget — not a distinct calendar per mentee,
 * unlike [slug].js next door. <contactId> is the GHL contact id, used as an
 * unguessable-enough slug (this is the same "unique link" emailed to the
 * mentee and shown to Kerry in admin.html's Mentorship tab).
 *
 * The kerry-forms Worker owns the actual lookup (reads Package/Sessions
 * Allowed/Sessions Left live off the GHL contact, plus a same-period
 * booking count for the pace line), so a session decrement from a booking
 * is reflected here immediately on next load — no redeploy needed.
 */

const WORKER_BASE = 'https://kerry-forms.miriam-68c.workers.dev';
const CALENDAR_WIDGET_URL = 'https://links.kerrykott.com/widget/booking/uY9PQylQAOc1mXKdmuST';
const LOGO_URL = 'https://assets.cdn.filesafe.space/ps7itsG5PeLgg7TDwnGV/media/6a47eac4989afcfcc93100ed.png';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function paceLine(mentee) {
  if (!mentee.pace) return '';
  const noun = mentee.pace.period === 'week' ? 'this week' : 'this month';
  return `${mentee.pace.used} of ${mentee.pace.cap} sessions booked ${noun}`;
}

function renderPage(mentee, contactId) {
  const firstName = esc((mentee.name || '').split(' ')[0] || 'there');
  const pkg = esc(mentee.package);
  const canonical = 'https://schedule.kerrykott.com/mentorship-call/' + contactId;
  const pace = esc(paceLine(mentee));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your Mentorship Calls — Kerry Kott</title>
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="${canonical}">
<link href="https://fonts.googleapis.com/css2?family=Sorts+Mill+Goudy:ital@0;1&family=EB+Garamond:ital,wght@0,400..700;1,400..700&display=swap" rel="stylesheet">
<style>
#mc{
  --cream:#F5F0EB; --ink:#0A0A0A; --border:#C7BCAD; --muted:#3A3630; --panel:#FBF9F6; --accent:#a8463c;
  --font-display:"EB Garamond",Georgia,"Times New Roman",serif;
  --font-body:"Sorts Mill Goudy",Georgia,"Times New Roman",serif;
  background:var(--cream); color:var(--ink); font-family:var(--font-body);
  -webkit-font-smoothing:antialiased; line-height:1.5; min-height:100vh;
}
#mc *{box-sizing:border-box;}
#mc .mc-shell{max-width:1160px;margin:0 auto;padding:48px 24px 64px;}
#mc .mc-logo{display:block;width:300px;max-width:75%;height:auto;margin:0 auto 40px;}
#mc .mc-card{
  background:#fff; border:1px solid var(--border); border-radius:8px;
  display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.6fr); gap:40px;
  padding:48px 44px;
}
#mc .mc-info{padding:4px 0 0;}
#mc .mc-greeting{
  font-family:var(--font-display); font-weight:700; font-size:clamp(24px,2.6vw,28px);
  line-height:1.2; margin:0 0 6px; color:var(--ink);
}
#mc .mc-package{font-size:15px;color:var(--muted);margin:0 0 26px;}
#mc .mc-stats{list-style:none;margin:0 0 22px;padding:0;border-top:1px solid var(--border);}
#mc .mc-stats li{
  display:flex;justify-content:space-between;gap:16px;padding:12px 0;
  border-bottom:1px solid var(--border);font-size:16px;
}
#mc .mc-stats li span:first-child{color:var(--muted);}
#mc .mc-stats li span:last-child{font-weight:600;}
#mc .mc-stats li.mc-left span:last-child{color:var(--accent);}
#mc .mc-pace{font-size:13px;color:var(--muted);margin:0;font-style:italic;}
#mc .mc-none{
  font-size:16px;line-height:1.75;padding:18px 20px;background:var(--panel);
  border:1px solid var(--border);border-radius:8px;color:var(--ink);
}
#mc .mc-widget{
  background:#fff; border:1px solid rgba(16,24,40,.12); border-radius:8px;
  overflow-x:auto; overflow-y:hidden; align-self:start;
}
#mc .mc-widget iframe{width:100%;min-width:360px;border:none;height:420px;display:block;}
@media (max-width:760px){
  #mc .mc-shell{padding:32px 14px 48px;}
  #mc .mc-card{grid-template-columns:1fr;padding:24px 16px;gap:22px;}
}
</style>
</head>
<body>
<div id="mc">
  <div class="mc-shell">
    <img class="mc-logo" src="${LOGO_URL}" alt="Kerry Kott">
    <div class="mc-card">
      <div class="mc-info">
        <h1 class="mc-greeting">Hi ${firstName},&nbsp;book&nbsp;your&nbsp;next&nbsp;call</h1>
        <p class="mc-package">${pkg} Mentorship</p>
        ${mentee.sessionsLeft > 0 ? `
        <ul class="mc-stats">
          <li><span>Sessions included</span><span>${mentee.sessionsAllowed}</span></li>
          <li><span>Booked so far</span><span>${mentee.sessionsBooked}</span></li>
          <li class="mc-left"><span>Sessions left</span><span>${mentee.sessionsLeft}</span></li>
        </ul>
        ${pace ? `<p class="mc-pace">${pace}</p>` : ''}
        ` : `
        <p class="mc-none">You've used all ${mentee.sessionsAllowed} of your included sessions. Reach out to Kerry if you'd like to add more.</p>
        `}
      </div>
      <div class="mc-widget">
        <iframe id="mc-iframe" src="${CALENDAR_WIDGET_URL}" scrolling="auto" title="Book a time"></iframe>
      </div>
    </div>
  </div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/iframe-resizer/4.3.9/iframeResizer.min.js"></script>
<script>
(function(){
  // Same iframe-resizer parent/child handshake as the calendar pages next
  // door (see functions/[slug].js) - checkOrigin:false because the widget
  // lives on links.kerrykott.com, a different subdomain than this page, by
  // design (Kerry's own GHL calendar), not a cross-site risk.
  if(window.iFrameResize){
    window.iFrameResize({ checkOrigin: false, heightCalculationMethod: 'lowestElement' }, '#mc-iframe');
  }
})();
</script>
</body>
</html>`;
}

export async function onRequestGet(context) {
  const contactId = context.params.id;
  if (typeof contactId !== 'string' || !contactId) return context.next();

  let mentee;
  try {
    const res = await fetch(WORKER_BASE + '/mentee?id=' + encodeURIComponent(contactId));
    if (!res.ok) return context.next();
    mentee = await res.json();
  } catch (err) {
    return context.next();
  }
  if (!mentee || !mentee.package) return context.next();

  return new Response(renderPage(mentee, contactId), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex, follow',
    },
  });
}
