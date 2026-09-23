/*
 * Sizes Kerry's embedded forms on her Squarespace pages.
 *
 * The admin's "Copy iframe embed" snippet is just the iframe plus
 * <script src="https://admin.kerrykott.com/embed.js">. All of the behaviour
 * lives here, so a fix deployed to this file is live on every page that
 * embeds a form, with nothing re-pasted in Squarespace. Served with
 * max-age=0, so the change shows on the next page load.
 *
 * Safe to load more than once on a page (one snippet per form): the first
 * copy does the work and later copies just ask the new iframe for its size.
 */
(function(){
  var FRAMES = 'iframe[id^="ef-iframe-"]';

  function requestSizes(){
    var frames = document.querySelectorAll(FRAMES);
    for(var i=0;i<frames.length;i++){
      try{ frames[i].contentWindow.postMessage({type:"ef-request-size"}, "*"); }catch(e){}
    }
  }

  if(window.__efEmbed){ requestSizes(); return; }
  window.__efEmbed = true;

  // Squarespace Fluid Engine pins each Code Block to a fixed number of grid
  // rows per breakpoint (whatever it was dragged to in the editor). Sizing
  // the iframe to the form doesn't shrink that block, so any rows it spans
  // past the form's real height show as dead space under the Submit button
  // (measured on /connect at phone width: block 934px, form 704px).
  //
  // For every embedded form in a section, this works out how many of its
  // rows the form actually fills. It then deletes the leftover rows that
  // nothing else in the section uses, and moves every block below them up by
  // the same number of rows. Rows a neighbouring block still occupies are
  // kept, so content beside or below the form is never overlapped or cut
  // off. Each pass first undoes the previous one, then remeasures, because
  // the grid differs per breakpoint and the form's height changes (errors,
  // confirmation screen).
  function fit(){
    var frames = document.querySelectorAll(FRAMES + "[data-ef-h]");
    var grids = [];
    for(var i=0;i<frames.length;i++){
      var fb = frames[i].closest(".fe-block"), fg = fb && fb.parentElement;
      if(fg && /fluid-engine/.test(fg.className) && grids.indexOf(fg) < 0) grids.push(fg);
    }
    grids.forEach(function(g){
      var kids = [].slice.call(g.children);
      if(g.getAttribute("data-ef-rows") !== null) g.style.gridTemplateRows = g.getAttribute("data-ef-rows");
      kids.forEach(function(k){ if(k.getAttribute("data-ef-row") !== null) k.style.gridRow = k.getAttribute("data-ef-row"); });
      var gs = getComputedStyle(g);
      var rows = gs.gridTemplateRows.split(" ").map(parseFloat), gap = parseFloat(gs.rowGap) || 0;
      if(rows.some(isNaN)) return;
      var spans = [];
      for(var j=0;j<kids.length;j++){
        var cs = getComputedStyle(kids[j]);
        var a = parseInt(cs.gridRowStart,10), z = parseInt(cs.gridRowEnd,10);
        if(!(a > 0 && z > a)) return;
        var fr = kids[j].querySelector(FRAMES + "[data-ef-h]");
        var h = fr ? parseFloat(fr.getAttribute("data-ef-h")) : 0;
        var keep = z;
        if(h > 0){
          var sum = 0, r = a;
          while(r < z){ sum += rows[r-1]; if(sum >= h) break; sum += gap; r++; }
          // Stop one row short of covering the form: the rows are
          // minmax(24px,auto), so the grid stretches them to the form's exact
          // height instead of leaving up to a row's worth of slack below it.
          keep = Math.max(a + 1, Math.min(r, z));
        }
        spans.push({k:kids[j], a:a, z:z, keep:keep});
      }
      var removed = [];
      spans.forEach(function(s){
        for(var r=s.keep;r<s.z;r++){
          var used = spans.some(function(o){ return o.a <= r && r < o.keep; });
          if(!used && removed.indexOf(r) < 0) removed.push(r);
        }
      });
      if(!removed.length) return;
      function shift(line){ return line - removed.filter(function(r){ return r < line; }).length; }
      if(g.getAttribute("data-ef-rows") === null) g.setAttribute("data-ef-rows", g.style.gridTemplateRows);
      g.style.gridTemplateRows = rows.filter(function(x,idx){ return removed.indexOf(idx+1) < 0; })
        .map(function(x){ return "minmax(" + x + "px,auto)"; }).join(" ");
      spans.forEach(function(s){
        if(s.k.getAttribute("data-ef-row") === null) s.k.setAttribute("data-ef-row", s.k.style.gridRow);
        s.k.style.gridRow = shift(s.a) + " / " + shift(s.keep);
      });
    });
  }

  window.addEventListener("message", function(e){
    if(!e.data || e.data.type !== "ef-resize" || typeof e.data.height !== "number") return;
    var frames = document.querySelectorAll(FRAMES);
    for(var i=0;i<frames.length;i++){
      var f = frames[i];
      if(f.contentWindow !== e.source) continue;
      // min-height is only the size before the first real measurement;
      // left in place it floors the iframe and leaves dead space.
      f.style.minHeight = "0";
      f.style.height = e.data.height + "px";
      f.setAttribute("data-ef-h", e.data.height);
      fit();
    }
  });
  window.addEventListener("resize", fit);
  requestSizes();
})();
