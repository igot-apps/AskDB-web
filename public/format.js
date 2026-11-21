// Tiny, safe Markdown-ish formatter for AI answers (HTML is always escaped first).
(function () {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }

  function format(md) {
    const lines = esc(md || '').split(/\r?\n/);
    let html = '', list = null, para = [], code = null;
    const flushPara = () => { if (para.length) { html += `<p>${inline(para.join('<br>'))}</p>`; para = []; } };
    const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const line of lines) {
      if (code !== null) {
        if (/^```/.test(line)) { html += `<pre><code>${code}</code></pre>`; code = null; }
        else code += line + '\n';
        continue;
      }
      if (/^```/.test(line)) { flushPara(); flushList(); code = ''; continue; }
      let m;
      if ((m = /^#{1,4}\s+(.*)/.exec(line))) { flushPara(); flushList(); html += `<h4>${inline(m[1])}</h4>`; continue; }
      if ((m = /^\s*[-*•]\s+(.*)/.exec(line))) { flushPara(); if (list !== 'ul') { flushList(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; continue; }
      if ((m = /^\s*\d+[.)]\s+(.*)/.exec(line))) { flushPara(); if (list !== 'ol') { flushList(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; continue; }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      flushList(); para.push(line);
    }
    if (code !== null) html += `<pre><code>${code}</code></pre>`;
    flushPara(); flushList();
    return html;
  }

  window.fmt = { format, esc };
})();
