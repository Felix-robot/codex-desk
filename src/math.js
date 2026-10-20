// Parse math before Markdown consumes TeX escapes, then typeset only sanitized placeholders.
(() => {
  const escape = (s) => s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function readMath(src, block = false) {
    const leading = block ? (src.match(/^ {0,3}/)?.[0] || '') : '';
    const text = src.slice(leading.length);
    const open = text.startsWith('$$') ? '$$' : text.startsWith('\\[') ? '\\[' : !block && text.startsWith('\\(') ? '\\(' : !block && text.startsWith('$') && !/\s|\$/.test(text[1] || ' ') ? '$' : null;
    if (!open) return;
    const close = open === '\\[' ? '\\]' : open === '\\(' ? '\\)' : open;
    let end = open.length;
    while ((end = text.indexOf(close, end)) >= 0) {
      let slashes = 0; for (let i = end - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
      if (slashes % 2 || open === '$' && (/\s/.test(text[end - 1] || '') || /\d/.test(text[end + 1] || ''))) { end += close.length; continue; }
      const tex = text.slice(open.length, end);
      if (!tex.trim() || open === '$' && tex.includes('\n')) return;
      const raw = leading + text.slice(0, end + close.length);
      return { type: block ? 'deskMathBlock' : 'deskMathInline', raw, text: tex.trim(), display: open === '$$' || open === '\\[' };
    }
  }
  const renderer = (token) => `<span class="math-source${token.display ? ' math-display' : ''}" data-tex="${escape(token.text)}" data-raw="${escape(token.raw)}"></span>${token.type === 'deskMathBlock' ? '\n' : ''}`;
  marked.use({ extensions: [
    { name:'deskMathBlock', level:'block', start:(src) => src.search(/^(?: {0,3})(?:\$\$|\\\[)/m), tokenizer:(src) => readMath(src,true), renderer },
    { name:'deskMathInline', level:'inline', start:(src) => src.search(/\$|\\\(|\\\[/), tokenizer:(src) => readMath(src), renderer },
  ] });
  const cache = new Map();
  window.typesetMath = (root) => {
    for (const element of root.querySelectorAll('.math-source')) {
      const tex = element.dataset.tex || ''; const display = element.classList.contains('math-display');
      try {
        if (tex.length > 20000) throw new Error('公式过长');
        const key = `${display}:${tex}`;
        if (!cache.has(key)) {
          if (cache.size >= 256) cache.delete(cache.keys().next().value);
          cache.set(key, katex.renderToString(tex, { displayMode:display, output:'htmlAndMathml', throwOnError:true, trust:false, strict:'ignore', maxExpand:1000, maxSize:20, macros:{} }));
        }
        element.innerHTML = cache.get(key);
      } catch {
        element.classList.add('math-fallback'); element.textContent = element.dataset.raw || tex;
        element.title = '公式暂时无法排版，保留原文';
      }
    }
  };
})();
