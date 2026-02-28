/* ============================================================
   MARKVOID — Line-Based Markdown Editor
   ============================================================ */

(function () {
  'use strict';

  // ── CONFIG ──────────────────────────────────────────────────
  const STORAGE_KEY = 'md_editor_document_v1';
  const AUTOSAVE_DELAY = 1000;

  // ── STATE ───────────────────────────────────────────────────
  let lines = ['']; // array of raw markdown strings
  let activeLineIdx = 0;
  let fenceStates = []; // per-line fence tracking: {inFence, lang}
  let undoStack = [];
  let redoStack = [];
  let autosaveTimer = null;
  let lastSavedContent = '';

  // ── CROSS-LINE SELECTION STATE ───────────────────────────────
  // True while mouse button is held down (potential drag selection)
  let mouseIsDown = false;
  // Whether a cross-line selection is currently active
  let crossLineSelActive = false;

  // Keyboard-driven selection anchor (in lines[] coordinates)
  // When Shift+Arrow extends selection across lines, we track:
  //   ksel.anchorLine / ksel.anchorOffset  — where selection started
  //   ksel.focusLine  / ksel.focusOffset   — where it ends (moves)
  let ksel = null; // null = no keyboard cross-line selection active

  // ── MARKDOWN ENGINE ─────────────────────────────────────────
  const md = window.markdownit({
    html: false,
    linkify: true,
    typographer: false,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; } catch (_) {}
      }
      try { return hljs.highlightAuto(code).value; } catch (_) {}
      return '';
    }
  });

  // ── DOM REFS ─────────────────────────────────────────────────
  const container = document.getElementById('line-container');
  const statusPos = document.getElementById('status-pos');
  const statusWords = document.getElementById('status-words');
  const statusLines = document.getElementById('status-lines');
  const autosaveEl = document.getElementById('autosave-indicator');
  const fileInput = document.getElementById('file-input');
  const findModal = document.getElementById('find-modal');
  const modalOverlay = document.getElementById('modal-overlay');

  // ── FENCE STATE COMPUTATION ──────────────────────────────────
  function computeFenceStates() {
    fenceStates = [];
    let inFence = false;
    let fenceLang = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      fenceStates.push({ inFence, fenceLang });
      if (line.startsWith('```')) {
        if (!inFence) {
          inFence = true;
          fenceLang = line.slice(3).trim();
        } else {
          inFence = false;
          fenceLang = '';
        }
      }
    }
  }

  // ── RENDER A SINGLE LINE ─────────────────────────────────────
  function renderLine(idx) {
    const raw = lines[idx] || '';
    // Determine context: are we inside a fence?
    const state = fenceStates[idx] || { inFence: false };

    let html;
    if (state.inFence || raw.startsWith('```')) {
      // Render as a code block chunk: wrap in pre/code for the fence
      // But we do full fence rendering via multi-line context trick
      html = md.renderInline(raw) || '';
      // For fence opening/closing lines, render the whole block context later
      // For now just show raw in styled span
      html = `<span style="color:var(--fg-dim)">${escapeHtml(raw)}</span>`;
    } else {
      // Render full inline md for the line
      // We use a full block render then strip wrapper <p> for inline lines
      const rendered = md.render(raw);
      html = stripOuterP(rendered);
    }

    return html || '';
  }

  // Render a line using block-level markdown (better for headings, lists, etc.)
  function renderLineBlock(idx) {
    const raw = lines[idx] || '';
    const state = fenceStates[idx] || { inFence: false };
    if (state.inFence) {
      return `<span class="in-fence">${escapeHtml(raw)}</span>`;
    }
    if (raw.startsWith('```')) {
      // Opening or closing fence — show styled
      return `<span style="color:var(--accent2);opacity:0.7">${escapeHtml(raw)}</span>`;
    }
    if (!raw.trim()) return '';
    const rendered = md.render(raw);
    return rendered.trim();
  }

  function stripOuterP(html) {
    return html.replace(/^<p>([\s\S]*?)<\/p>\n?$/, '$1');
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── BUILD ALL LINE ELEMENTS ──────────────────────────────────
  function buildAllLines() {
    computeFenceStates();
    container.innerHTML = '';
    for (let i = 0; i < lines.length; i++) {
      const el = createLineEl(i);
      container.appendChild(el);
    }
  }

  function createLineEl(idx) {
    const lineEl = document.createElement('div');
    lineEl.className = 'editor-line';
    lineEl.dataset.idx = idx;

    const gutter = document.createElement('div');
    gutter.className = 'line-gutter';
    gutter.textContent = idx + 1;

    const content = document.createElement('div');
    content.className = 'line-content';

    const raw = document.createElement('textarea');
    raw.className = 'line-raw';
    raw.value = lines[idx] || '';
    raw.rows = 1;
    raw.spellcheck = false;
    raw.autocomplete = 'off';
    raw.autocorrect = 'off';
    raw.autocapitalize = 'off';

    const rendered = document.createElement('div');
    rendered.className = 'line-rendered';

    const html = renderLineBlock(idx);
    rendered.innerHTML = html || '';
    if (!html) rendered.classList.add('empty');
    else rendered.classList.remove('empty');

    content.appendChild(raw);
    content.appendChild(rendered);
    lineEl.appendChild(gutter);
    lineEl.appendChild(content);

    // Auto-resize textarea
    function autoResize() {
      raw.style.height = 'auto';
      raw.style.height = raw.scrollHeight + 'px';
    }

    // Events
    raw.addEventListener('input', () => {
      autoResize();
      lines[idx] = raw.value;
      computeFenceStates();
      updateRendered(idx);
      scheduleAutosave();
      pushUndo();
      updateStatus(idx, raw);
    });

    raw.addEventListener('focus', () => {
      setActiveLine(idx);
      updateStatus(idx, raw);
    });

    raw.addEventListener('blur', () => {
      switchToRendered(idx);
    });

    raw.addEventListener('keydown', (e) => {
      handleLineKeydown(e, idx, raw);
    });

    raw.addEventListener('paste', (e) => {
      handlePaste(e, idx, raw);
    });

    rendered.addEventListener('mousedown', (e) => {
      mouseIsDown = true;
      crossLineSelActive = false;
    });

    rendered.addEventListener('click', (e) => {
      // Only switch to raw if this is a simple click, not end of a drag
      if (!crossLineSelActive) {
        switchToRaw(idx);
      }
    });

    lineEl.addEventListener('mousedown', (e) => {
      mouseIsDown = true;
      crossLineSelActive = false;
    });

    lineEl.addEventListener('click', (e) => {
      if (crossLineSelActive) return;
      if (e.target === lineEl || e.target === content || e.target === gutter) {
        switchToRaw(idx);
      }
    });

    // Drag and drop images
    lineEl.addEventListener('dragover', (e) => { e.preventDefault(); });
    lineEl.addEventListener('drop', (e) => { handleDrop(e, idx); });

    // Init size
    requestAnimationFrame(() => autoResize());

    return lineEl;
  }

  function getLineEl(idx) {
    return container.querySelector(`.editor-line[data-idx="${idx}"]`);
  }

  function updateRendered(idx) {
    const lineEl = getLineEl(idx);
    if (!lineEl) return;
    const rendered = lineEl.querySelector('.line-rendered');
    const html = renderLineBlock(idx);
    rendered.innerHTML = html || '';
    if (!html) rendered.classList.add('empty');
    else rendered.classList.remove('empty');
  }

  function switchToRaw(idx) {
    setActiveLine(idx);
    const lineEl = getLineEl(idx);
    if (!lineEl) return;
    lineEl.classList.add('editing');
    const raw = lineEl.querySelector('.line-raw');
    raw.value = lines[idx] || '';
    raw.focus();
    // auto-resize
    raw.style.height = 'auto';
    raw.style.height = raw.scrollHeight + 'px';
  }

  function switchToRendered(idx) {
    const lineEl = getLineEl(idx);
    if (!lineEl) return;
    lineEl.classList.remove('editing');
    computeFenceStates();
    updateRendered(idx);
  }

  function setActiveLine(idx) {
    // Remove active from previous
    const prev = container.querySelector('.editor-line.active');
    if (prev) prev.classList.remove('active');
    activeLineIdx = idx;
    const lineEl = getLineEl(idx);
    if (lineEl) lineEl.classList.add('active');
    // Update gutter numbering
    updateGutterNumbers();
  }

  function updateGutterNumbers() {
    const gutters = container.querySelectorAll('.line-gutter');
    gutters.forEach((g, i) => { g.textContent = i + 1; });
    // Update data-idx too (needed after insertions)
    const lineEls = container.querySelectorAll('.editor-line');
    lineEls.forEach((el, i) => { el.dataset.idx = i; });
  }

  // ── KEYBOARD HANDLING ────────────────────────────────────────
  function handleLineKeydown(e, idx, raw) {
    const val = raw.value;
    const sel = raw.selectionStart;

    // If there's a keyboard cross-line selection and user types/deletes, handle it
    if (ksel && ksel.focusLine !== ksel.anchorLine) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        deleteKsel();
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        e.preventDefault();
        const saved = ksel;
        deleteKsel(e.key);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        deleteKsel('\n');
        return;
      }
    }

    // Enter: split line or insert new
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const before = val.slice(0, sel);
      const after = val.slice(sel);

      // Smart continuation for lists
      let prefix = '';
      const listMatch = before.match(/^(\s*)([-*+]|\d+\.)\s/);
      if (listMatch) {
        // If line is empty bullet, remove bullet
        if (before.trim() === listMatch[0].trim() || before.trim() === listMatch[2]) {
          lines[idx] = '';
          raw.value = '';
          raw.style.height = 'auto';
          raw.style.height = raw.scrollHeight + 'px';
          computeFenceStates();
          updateRendered(idx);
          return;
        }
        prefix = listMatch[1];
        if (listMatch[2].match(/\d+/)) {
          prefix += (parseInt(listMatch[2]) + 1) + '. ';
        } else {
          prefix += listMatch[2] + ' ';
        }
      }

      lines[idx] = before;
      lines.splice(idx + 1, 0, prefix + after);

      rebuildFromIndex(idx);
      requestAnimationFrame(() => {
        switchToRaw(idx + 1);
        const nextRaw = getLineEl(idx + 1)?.querySelector('.line-raw');
        if (nextRaw) {
          nextRaw.setSelectionRange(prefix.length, prefix.length);
        }
      });
      pushUndo();
      scheduleAutosave();
      return;
    }

    // Backspace at start: merge with previous
    if (e.key === 'Backspace' && sel === 0 && idx > 0 && raw.selectionEnd === 0) {
      e.preventDefault();
      const prevContent = lines[idx - 1];
      const cursor = prevContent.length;
      lines[idx - 1] = prevContent + val;
      lines.splice(idx, 1);
      rebuildFromIndex(idx - 1);
      requestAnimationFrame(() => {
        switchToRaw(idx - 1);
        const prevRaw = getLineEl(idx - 1)?.querySelector('.line-raw');
        if (prevRaw) prevRaw.setSelectionRange(cursor, cursor);
      });
      pushUndo();
      scheduleAutosave();
      return;
    }

    // Delete at end: merge with next
    if (e.key === 'Delete' && sel === val.length && idx < lines.length - 1) {
      e.preventDefault();
      lines[idx] = val + lines[idx + 1];
      lines.splice(idx + 1, 1);
      rebuildFromIndex(idx);
      requestAnimationFrame(() => {
        switchToRaw(idx);
        const r = getLineEl(idx)?.querySelector('.line-raw');
        if (r) r.setSelectionRange(val.length, val.length);
      });
      pushUndo();
      scheduleAutosave();
      return;
    }

    // Arrow up / Shift+ArrowUp
    if (e.key === 'ArrowUp') {
      if (idx > 0) {
        if (e.shiftKey) {
          e.preventDefault();
          // Start or extend keyboard selection upward
          if (!ksel) {
            // Anchor at current cursor position
            ksel = { anchorLine: idx, anchorOffset: raw.selectionStart,
                     focusLine: idx, focusOffset: raw.selectionStart };
          }
          ksel.focusLine = Math.max(0, ksel.focusLine - 1);
          // focusOffset: go to end of previous line (column-matching is nice but end is simpler)
          ksel.focusOffset = (lines[ksel.focusLine] || '').length;
          applyKselVisual();
        } else {
          clearKsel();
          e.preventDefault();
          switchToRendered(idx);
          switchToRaw(idx - 1);
        }
      } else if (e.shiftKey) {
        // At top line — just let browser handle within-line shift
      }
      return;
    }

    // Arrow down / Shift+ArrowDown
    if (e.key === 'ArrowDown') {
      if (idx < lines.length - 1) {
        if (e.shiftKey) {
          e.preventDefault();
          if (!ksel) {
            ksel = { anchorLine: idx, anchorOffset: raw.selectionStart,
                     focusLine: idx, focusOffset: raw.selectionStart };
          }
          ksel.focusLine = Math.min(lines.length - 1, ksel.focusLine + 1);
          ksel.focusOffset = 0;
          applyKselVisual();
        } else {
          clearKsel();
          e.preventDefault();
          switchToRendered(idx);
          switchToRaw(idx + 1);
        }
      } else if (e.shiftKey) {
        // Bottom line — extend to end of current line
        if (!ksel) {
          ksel = { anchorLine: idx, anchorOffset: raw.selectionStart,
                   focusLine: idx, focusOffset: raw.selectionStart };
        }
        ksel.focusOffset = (lines[idx] || '').length;
        applyKselVisual();
      }
      return;
    }

    // Shift+End: extend to end of current line, possibly starting cross-line sel
    if (e.key === 'End' && e.shiftKey) {
      // Let the browser handle within-line; clear ksel if it was cross-line
      if (ksel && ksel.focusLine !== ksel.anchorLine) {
        e.preventDefault();
        ksel.focusLine = idx;
        ksel.focusOffset = (lines[idx] || '').length;
        applyKselVisual();
        return;
      }
    }

    // Shift+Home: similar
    if (e.key === 'Home' && e.shiftKey) {
      if (ksel && ksel.focusLine !== ksel.anchorLine) {
        e.preventDefault();
        ksel.focusLine = idx;
        ksel.focusOffset = 0;
        applyKselVisual();
        return;
      }
    }

    // Any non-shift arrow clears ksel
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && ksel) {
      clearKsel();
    }

    // Tab: insert 2 spaces
    if (e.key === 'Tab') {
      e.preventDefault();
      const newVal = val.slice(0, sel) + '  ' + val.slice(sel);
      raw.value = newVal;
      raw.setSelectionRange(sel + 2, sel + 2);
      lines[idx] = newVal;
      computeFenceStates();
      updateRendered(idx);
      scheduleAutosave();
      return;
    }

    // Ctrl+Z
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      app.undo();
      return;
    }

    // Ctrl+Y
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      e.preventDefault();
      app.redo();
      return;
    }

    // Ctrl+F
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      app.openFind();
      return;
    }

    // Ctrl+H
    if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
      e.preventDefault();
      app.openFindReplace();
      return;
    }

    // Ctrl+A — select all document text
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      app.selectAll();
      return;
    }
  }

  // ── KEYBOARD SELECTION HELPERS ───────────────────────────────

  // Normalise ksel so start <= end in document order
  function kselNormalized() {
    if (!ksel) return null;
    const { anchorLine, anchorOffset, focusLine, focusOffset } = ksel;
    if (anchorLine < focusLine || (anchorLine === focusLine && anchorOffset <= focusOffset)) {
      return { startLine: anchorLine, startOffset: anchorOffset,
               endLine: focusLine, endOffset: focusOffset };
    }
    return { startLine: focusLine, startOffset: focusOffset,
             endLine: anchorLine, endOffset: anchorOffset };
  }

  // Paint the visual browser selection to match ksel
  function applyKselVisual() {
    if (!ksel) return;
    const norm = kselNormalized();
    if (!norm) return;

    // Make sure all lines in range are in rendered mode (not editing textarea)
    // except we need the anchor line in editing mode for the textarea selection
    const { startLine, endLine } = norm;

    // Switch all lines in range to rendered so the DOM text nodes are accessible
    for (let i = startLine; i <= endLine; i++) {
      if (getLineEl(i)?.classList.contains('editing')) {
        switchToRendered(i);
      }
    }

    // Now set the browser selection from startLine's rendered div to endLine's rendered div
    requestAnimationFrame(() => {
      const startEl = getLineEl(norm.startLine)?.querySelector('.line-rendered');
      const endEl   = getLineEl(norm.endLine)?.querySelector('.line-rendered');
      if (!startEl || !endEl) return;

      const startTextNode = findTextNodeAtOffset(startEl, norm.startOffset,
        lines[norm.startLine] || '');
      const endTextNode   = findTextNodeAtOffset(endEl, norm.endOffset,
        lines[norm.endLine] || '');

      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.setStart(startTextNode.node, startTextNode.offset);
      range.setEnd(endTextNode.node, endTextNode.offset);
      sel.addRange(range);
      crossLineSelActive = true;
    });
  }

  // Map a character offset in the raw line to a {node, offset} in the rendered DOM
  function findTextNodeAtOffset(container, rawOffset, rawLine) {
    // Get all text nodes
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const renderedText = container.textContent || '';
    // Map rawOffset -> rendered offset by ratio
    const ratio = rawLine.length > 0 ? (rawOffset / rawLine.length) : 0;
    const targetOffset = Math.round(ratio * renderedText.length);

    let pos = 0;
    let lastNode = null;
    let lastNodeOffset = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const len = node.textContent.length;
      if (pos + len >= targetOffset) {
        return { node, offset: Math.min(targetOffset - pos, len) };
      }
      pos += len;
      lastNode = node;
      lastNodeOffset = len;
    }
    // Fallback: end of container
    if (lastNode) return { node: lastNode, offset: lastNodeOffset };
    // Empty container fallback
    return { node: container, offset: 0 };
  }

  function clearKsel(switchToRawAfter) {
    if (!ksel) return;
    const focusLine = ksel.focusLine;
    const focusOffset = ksel.focusOffset;
    ksel = null;
    crossLineSelActive = false;
    window.getSelection()?.removeAllRanges();
    if (switchToRawAfter !== false) {
      switchToRaw(focusLine);
      requestAnimationFrame(() => {
        const r = getLineEl(focusLine)?.querySelector('.line-raw');
        if (r) r.setSelectionRange(focusOffset, focusOffset);
      });
    }
  }

  // Delete the ksel range, optionally inserting a replacement string
  function deleteKsel(insert) {
    if (!ksel) return;
    const norm = kselNormalized();
    if (!norm) return;
    const { startLine, startOffset, endLine, endOffset } = norm;

    const before = (lines[startLine] || '').slice(0, startOffset);
    const after  = (lines[endLine]   || '').slice(endOffset);

    let newLines;
    if (insert === '\n') {
      newLines = [before, after];
    } else {
      newLines = [before + (insert || '') + after];
    }

    lines.splice(startLine, endLine - startLine + 1, ...newLines);
    if (!lines.length) lines = [''];

    ksel = null;
    crossLineSelActive = false;
    window.getSelection()?.removeAllRanges();

    buildAllLines();
    const cursorLine = insert === '\n' ? startLine + 1 : startLine;
    const cursorCol  = insert === '\n' ? 0 : before.length + (insert ? insert.length : 0);
    requestAnimationFrame(() => {
      switchToRaw(cursorLine);
      const r = getLineEl(cursorLine)?.querySelector('.line-raw');
      if (r) r.setSelectionRange(cursorCol, cursorCol);
    });
    pushUndo();
    scheduleAutosave();
  }

  // Get ksel as a getCrossLineSelection-compatible object (for copy/cut/delete in global handler)
  function getKselAsCross() {
    if (!ksel) return null;
    const norm = kselNormalized();
    if (!norm || norm.startLine === norm.endLine) return null;
    return norm;
  }

  // ── REBUILD FROM INDEX ───────────────────────────────────────
  // Partial rebuild for performance: remove old elements from idx onwards, rebuild
  function rebuildFromIndex(fromIdx) {
    // Remove all elements from fromIdx
    const allEls = Array.from(container.querySelectorAll('.editor-line'));
    for (let i = fromIdx; i < allEls.length; i++) {
      allEls[i].remove();
    }
    computeFenceStates();
    // Re-append
    for (let i = fromIdx; i < lines.length; i++) {
      const el = createLineEl(i);
      container.appendChild(el);
    }
    updateGutterNumbers();
    updateStatusBar();
  }

  // ── PASTE HANDLING ───────────────────────────────────────────
  function handlePaste(e, idx, raw) {
    const clipHTML = e.clipboardData.getData('text/html');
    const clipText = e.clipboardData.getData('text/plain');

    if (clipHTML && clipHTML.length > 0) {
      e.preventDefault();
      const converted = htmlToMarkdown(clipHTML);
      insertTextAtCursor(converted, idx, raw);
    } else if (clipText) {
      e.preventDefault();
      insertTextAtCursor(clipText, idx, raw);
    }
  }

  function insertTextAtCursor(text, idx, raw) {
    const sel = raw.selectionStart;
    const selEnd = raw.selectionEnd;
    const before = raw.value.slice(0, sel);
    const after = raw.value.slice(selEnd);
    const full = before + text + after;

    // Split by newlines
    const parts = full.split('\n');
    if (parts.length === 1) {
      lines[idx] = full;
      raw.value = full;
      const newPos = sel + text.length;
      raw.setSelectionRange(newPos, newPos);
      computeFenceStates();
      updateRendered(idx);
    } else {
      lines.splice(idx, 1, ...parts);
      rebuildFromIndex(idx);
      requestAnimationFrame(() => {
        const newIdx = idx + parts.length - 1;
        switchToRaw(newIdx);
        const r = getLineEl(newIdx)?.querySelector('.line-raw');
        if (r) {
          const lastLen = parts[parts.length - 1].length;
          r.setSelectionRange(lastLen, lastLen);
        }
      });
    }
    scheduleAutosave();
    pushUndo();
  }

  // ── HTML → MARKDOWN ──────────────────────────────────────────
  function htmlToMarkdown(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    return nodeToMarkdown(doc.body).trim();
  }

  function nodeToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    const children = () => Array.from(node.childNodes).map(nodeToMarkdown).join('');

    switch (tag) {
      case 'script': case 'style': return '';
      case 'b': case 'strong': return `**${children()}**`;
      case 'i': case 'em': return `*${children()}*`;
      case 'del': case 's': return `~~${children()}~~`;
      case 'code': return '`' + node.textContent + '`';
      case 'pre': {
        const codeEl = node.querySelector('code');
        const lang = (codeEl?.className || '').replace('language-', '');
        return '\n```' + lang + '\n' + (codeEl?.textContent || node.textContent) + '\n```\n';
      }
      case 'a': return `[${children()}](${node.getAttribute('href') || ''})`;
      case 'img': {
        const src = node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || '';
        return `![${alt}](${src})`;
      }
      case 'h1': return `\n# ${children()}\n`;
      case 'h2': return `\n## ${children()}\n`;
      case 'h3': return `\n### ${children()}\n`;
      case 'h4': return `\n#### ${children()}\n`;
      case 'h5': return `\n##### ${children()}\n`;
      case 'h6': return `\n###### ${children()}\n`;
      case 'p': return `\n${children()}\n`;
      case 'br': return '\n';
      case 'hr': return '\n---\n';
      case 'blockquote': return `\n> ${children().trim().split('\n').join('\n> ')}\n`;
      case 'ul': return '\n' + Array.from(node.children).map(li => `- ${nodeToMarkdown(li).trim()}`).join('\n') + '\n';
      case 'ol': return '\n' + Array.from(node.children).map((li, i) => `${i + 1}. ${nodeToMarkdown(li).trim()}`).join('\n') + '\n';
      case 'li': return children();
      case 'table': return convertTableToMd(node);
      case 'thead': case 'tbody': case 'tfoot': return children();
      case 'tr': return children();
      case 'th': case 'td': return children();
      case 'div': case 'section': case 'article': return '\n' + children() + '\n';
      case 'span': return children();
      default: return children();
    }
  }

  function convertTableToMd(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';
    const cells = rows.map(row =>
      Array.from(row.querySelectorAll('th,td')).map(cell =>
        cell.textContent.replace(/\|/g, '\\|').trim()
      )
    );
    const maxCols = Math.max(...cells.map(r => r.length));
    const normalized = cells.map(row => {
      while (row.length < maxCols) row.push('');
      return row;
    });
    const header = '| ' + normalized[0].join(' | ') + ' |';
    const sep = '| ' + normalized[0].map(() => '---').join(' | ') + ' |';
    const body = normalized.slice(1).map(row => '| ' + row.join(' | ') + ' |');
    return '\n' + [header, sep, ...body].join('\n') + '\n';
  }

  // ── DRAG & DROP IMAGES ───────────────────────────────────────
  function handleDrop(e, idx) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    files.forEach(file => insertImageFile(file, idx));
  }

  function insertImageFile(file, idx) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const b64 = e.target.result;
      const md = `![${file.name}](${b64})`;
      lines.splice(idx + 1, 0, md);
      rebuildFromIndex(idx);
      scheduleAutosave();
    };
    reader.readAsDataURL(file);
  }

  // ── UNDO / REDO ──────────────────────────────────────────────
  let undoPushTimer = null;
  function pushUndo() {
    clearTimeout(undoPushTimer);
    undoPushTimer = setTimeout(() => {
      const snapshot = lines.slice();
      if (undoStack.length && JSON.stringify(undoStack[undoStack.length - 1]) === JSON.stringify(snapshot)) return;
      undoStack.push(snapshot);
      if (undoStack.length > 200) undoStack.shift();
      redoStack = [];
    }, 300);
  }

  // ── AUTOSAVE ─────────────────────────────────────────────────
  function scheduleAutosave() {
    setSaving();
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveDocument, AUTOSAVE_DELAY);
  }

  function setSaving() {
    autosaveEl.textContent = '◌ SAVING…';
    autosaveEl.className = 'saving';
  }

  function setSaved() {
    autosaveEl.textContent = '● SAVED';
    autosaveEl.className = 'saved';
  }

  function saveDocument() {
    const content = lines.join('\n');
    const theme = document.body.getAttribute('data-theme') || 'retro-neon';
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        content,
        lastSaved: Date.now(),
        theme
      }));
      lastSavedContent = content;
    } catch (ex) {
      console.warn('localStorage save failed', ex);
    }
    setSaved();
  }

  function loadDocument() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.theme) app.setTheme(data.theme, true);
      if (data.content !== undefined) {
        setContent(data.content);
      }
    } catch (_) {}
  }

  function setContent(text) {
    lines = text.split('\n');
    if (!lines.length) lines = [''];
    undoStack = [];
    redoStack = [];
    buildAllLines();
    updateStatusBar();
    requestAnimationFrame(() => {
      if (lines.length > 0) {
        const firstEl = getLineEl(0);
        if (firstEl) firstEl.querySelector('.line-rendered').click();
      }
    });
  }

  // ── STATUS BAR ───────────────────────────────────────────────
  function updateStatus(idx, raw) {
    const col = raw ? raw.selectionStart + 1 : 1;
    statusPos.textContent = `Ln ${idx + 1}, Col ${col}`;
    updateStatusBar();
  }

  function updateStatusBar() {
    const total = lines.length;
    const wordCount = lines.join(' ').split(/\s+/).filter(w => w).length;
    statusLines.textContent = `${total} lines`;
    statusWords.textContent = `${wordCount} words`;
  }

  // ── FIND & REPLACE ───────────────────────────────────────────
  let findMode = 'find';

  function clearHighlights() {
    container.querySelectorAll('.search-highlight').forEach(el => {
      el.outerHTML = el.innerHTML;
    });
  }

  // ── PUBLIC API ───────────────────────────────────────────────
  const app = {
    newDocument() {
      if (!confirm('Create a new document? Unsaved changes will be lost.')) return;
      setContent('');
    },

    uploadFile() {
      fileInput.click();
    },

    downloadFile() {
      const content = lines.join('\n');
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const fname = `document-${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`;
      const blob = new Blob([content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      a.click();
      URL.revokeObjectURL(url);
    },

    undo() {
      if (!undoStack.length) return;
      const current = lines.slice();
      redoStack.push(current);
      const prev = undoStack.pop();
      lines = prev;
      buildAllLines();
      scheduleAutosave();
    },

    redo() {
      if (!redoStack.length) return;
      const current = lines.slice();
      undoStack.push(current);
      const next = redoStack.pop();
      lines = next;
      buildAllLines();
      scheduleAutosave();
    },

    openFind() {
      findMode = 'find';
      document.getElementById('modal-title').textContent = 'FIND';
      document.getElementById('replace-row').style.display = 'none';
      document.getElementById('replace-one-btn').style.display = 'none';
      document.getElementById('replace-all-btn').style.display = 'none';
      findModal.classList.remove('hidden');
      modalOverlay.classList.remove('hidden');
      requestAnimationFrame(() => document.getElementById('find-input').focus());
    },

    openFindReplace() {
      findMode = 'replace';
      document.getElementById('modal-title').textContent = 'FIND & REPLACE';
      document.getElementById('replace-row').style.display = 'flex';
      document.getElementById('replace-one-btn').style.display = 'inline-block';
      document.getElementById('replace-all-btn').style.display = 'inline-block';
      findModal.classList.remove('hidden');
      modalOverlay.classList.remove('hidden');
      requestAnimationFrame(() => document.getElementById('find-input').focus());
    },

    closeFind() {
      findModal.classList.add('hidden');
      modalOverlay.classList.add('hidden');
      clearHighlights();
      // Re-render all visible rendered lines
      lines.forEach((_, i) => {
        const lineEl = getLineEl(i);
        if (lineEl && !lineEl.classList.contains('editing')) {
          updateRendered(i);
        }
      });
    },

    findHighlight() {
      clearHighlights();
      const term = document.getElementById('find-input').value;
      if (!term) return;
      const caseSensitive = document.getElementById('opt-case').checked;
      const useRegex = document.getElementById('opt-regex').checked;

      let regex;
      try {
        const flags = caseSensitive ? 'g' : 'gi';
        regex = useRegex ? new RegExp(term, flags) : new RegExp(escapeRegex(term), flags);
      } catch (_) { return; }

      lines.forEach((line, i) => {
        const lineEl = getLineEl(i);
        if (!lineEl || lineEl.classList.contains('editing')) return;
        const rendered = lineEl.querySelector('.line-rendered');
        if (!rendered) return;
        // Highlight in rendered text
        const text = rendered.innerHTML;
        const highlighted = rendered.innerHTML.replace(/<[^>]*>|([^<]+)/g, (match, textPart) => {
          if (!textPart) return match; // it's a tag
          return textPart.replace(regex, m => `<mark class="search-highlight">${escapeHtml(m)}</mark>`);
        });
        rendered.innerHTML = highlighted;
      });
    },

    replaceOne() {
      const term = document.getElementById('find-input').value;
      const replacement = document.getElementById('replace-input').value;
      if (!term) return;

      const caseSensitive = document.getElementById('opt-case').checked;
      const useRegex = document.getElementById('opt-regex').checked;
      const flags = caseSensitive ? '' : 'i';

      let regex;
      try {
        regex = useRegex ? new RegExp(term, flags) : new RegExp(escapeRegex(term), flags);
      } catch (_) { return; }

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          lines[i] = lines[i].replace(regex, replacement);
          updateRendered(i);
          break;
        }
      }
      scheduleAutosave();
      pushUndo();
    },

    replaceAll() {
      const term = document.getElementById('find-input').value;
      const replacement = document.getElementById('replace-input').value;
      if (!term) return;

      const caseSensitive = document.getElementById('opt-case').checked;
      const useRegex = document.getElementById('opt-regex').checked;
      const flags = caseSensitive ? 'g' : 'gi';

      let regex;
      try {
        regex = useRegex ? new RegExp(term, flags) : new RegExp(escapeRegex(term), flags);
      } catch (_) { return; }

      lines = lines.map(line => line.replace(regex, replacement));
      buildAllLines();
      scheduleAutosave();
      pushUndo();
    },

    bulletify() {
      // Get selected lines or active line
      const selected = getSelectedLines();
      if (selected.length === 0) selected.push(activeLineIdx);

      selected.forEach(i => {
        const line = lines[i] || '';
        const trimmed = line.trimStart();
        if (!trimmed.startsWith('- ') && !trimmed.startsWith('* ')) {
          lines[i] = '- ' + line.trimStart();
        }
      });

      rebuildFromIndex(Math.min(...selected));
      scheduleAutosave();
      pushUndo();
    },

    unicodeToAscii() {
      const MAP = {
        '\u2018': "'", '\u2019': "'", // ' '
        '\u201C': '"', '\u201D': '"', // " "
        '\u2014': '--',               // —
        '\u2013': '-',                // –
        '\u2026': '...',              // …
        '\u00A0': ' ',                // NBSP
      };
      const inFenceSet = new Set();
      computeFenceStates();
      fenceStates.forEach((s, i) => { if (s.inFence) inFenceSet.add(i); });

      lines = lines.map((line, i) => {
        if (inFenceSet.has(i)) return line;
        return line.replace(/[\u2018\u2019\u201C\u201D\u2014\u2013\u2026\u00A0]/g,
          c => MAP[c] || c);
      });
      buildAllLines();
      scheduleAutosave();
      pushUndo();
    },

    selectAll() {
      // Switch active line to rendered so all lines are accessible as DOM text nodes
      const activeRaw = container.querySelector('.editor-line.editing .line-raw');
      if (activeRaw) switchToRendered(activeLineIdx);

      // Track as ksel spanning entire document
      ksel = {
        anchorLine: 0, anchorOffset: 0,
        focusLine: lines.length - 1,
        focusOffset: (lines[lines.length - 1] || '').length
      };
      crossLineSelActive = true;

      // Use the Selection API to visually select all content
      const selection = window.getSelection();
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(container);
      selection.addRange(range);

      // Copy handler returns raw markdown
      document.oncopy = (e) => {
        const sel = window.getSelection();
        if (sel && sel.toString()) {
          e.clipboardData.setData('text/plain', lines.join('\n'));
          e.preventDefault();
          document.oncopy = null;
        }
      };
    },

    setTheme(theme, silent) {
      document.documentElement.setAttribute('data-theme', theme);
      document.body.setAttribute('data-theme', theme);

      // Swap hljs theme
      const hljsLink = document.getElementById('hljs-theme');
      if (theme === 'white') {
        hljsLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
      } else {
        hljsLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css';
      }

      if (!silent) saveDocument();
    }
  };

  // ── HELPERS ──────────────────────────────────────────────────
  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function getSelectedLines() {
    // Return sorted array of line indices that overlap the current browser selection
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];
    const range = sel.getRangeAt(0);
    const result = [];
    const allEls = container.querySelectorAll('.editor-line');
    allEls.forEach((el) => {
      const i = parseInt(el.dataset.idx);
      if (range.intersectsNode(el)) result.push(i);
    });
    return result;
  }

  // Given the current browser selection, return {startLine, startOffset, endLine, endOffset}
  // working on the raw lines[] data
  function getCrossLineSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);

    function lineIdxOf(node) {
      let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      while (el && !el.classList?.contains('editor-line')) el = el.parentElement;
      return el ? parseInt(el.dataset.idx) : -1;
    }

    function offsetInLine(node, offset, lineIdx) {
      // For rendered lines, map DOM offset to character offset in raw line text
      // Approximate: use the text content length ratio
      const lineEl = getLineEl(lineIdx);
      if (!lineEl) return 0;
      // If the line is in editing mode (textarea), just return offset
      if (lineEl.classList.contains('editing')) return offset;
      const rendered = lineEl.querySelector('.line-rendered');
      if (!rendered) return 0;
      const fullText = rendered.textContent || '';
      // Walk text nodes up to the anchor node to get character position
      let charPos = 0;
      const walker = document.createTreeWalker(rendered, NodeFilter.SHOW_TEXT);
      let found = false;
      while (walker.nextNode()) {
        const tnode = walker.currentNode;
        if (tnode === node) {
          charPos += offset;
          found = true;
          break;
        }
        charPos += tnode.textContent.length;
      }
      if (!found) charPos = offset;
      // Map rendered text position back to raw markdown position (best effort)
      const rawLine = lines[lineIdx] || '';
      // Simple heuristic: ratio of rendered text length to raw length
      if (fullText.length === 0) return 0;
      return Math.round((charPos / fullText.length) * rawLine.length);
    }

    const startLine = lineIdxOf(range.startContainer);
    const endLine = lineIdxOf(range.endContainer);
    if (startLine === -1 || endLine === -1) return null;
    if (startLine === endLine) return null; // single-line, let textarea handle it

    const startOffset = offsetInLine(range.startContainer, range.startOffset, startLine);
    const endOffset = offsetInLine(range.endContainer, range.endOffset, endLine);

    return { startLine, startOffset, endLine, endOffset };
  }

  // Delete content covered by a cross-line selection
  function deleteSelection(crossSel) {
    if (!crossSel) return false;
    const { startLine, startOffset, endLine, endOffset } = crossSel;
    if (startLine === endLine) return false;

    const before = (lines[startLine] || '').slice(0, startOffset);
    const after = (lines[endLine] || '').slice(endOffset);
    const merged = before + after;

    // Replace the range with a single merged line
    lines.splice(startLine, endLine - startLine + 1, merged);
    if (!lines.length) lines = [''];

    buildAllLines();
    // Place cursor at merge point
    requestAnimationFrame(() => {
      switchToRaw(startLine);
      const r = getLineEl(startLine)?.querySelector('.line-raw');
      if (r) r.setSelectionRange(before.length, before.length);
    });
    pushUndo();
    scheduleAutosave();
    crossLineSelActive = false;
    window.getSelection()?.removeAllRanges();
    return true;
  }

  // ── FILE INPUT ───────────────────────────────────────────────
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setContent(ev.target.result);
      saveDocument();
    };
    reader.readAsText(file);
    fileInput.value = '';
  });

  // ── GLOBAL MOUSE TRACKING ────────────────────────────────────
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest('#editor-pane')) {
      mouseIsDown = true;
      crossLineSelActive = false;
      ksel = null; // clear keyboard selection when mouse is used
    }
  });

  document.addEventListener('mouseup', () => {
    if (!mouseIsDown) return;
    mouseIsDown = false;
    // Check if a cross-line selection was made
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      if (container.contains(range.startContainer) && container.contains(range.endContainer)) {
        const startEl = range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement : range.startContainer;
        const endEl = range.endContainer.nodeType === Node.TEXT_NODE
          ? range.endContainer.parentElement : range.endContainer;
        const startLine = startEl?.closest?.('.editor-line');
        const endLine = endEl?.closest?.('.editor-line');
        if (startLine && endLine && startLine !== endLine) {
          // It's a real cross-line drag — keep it, don't switch to raw
          crossLineSelActive = true;
          return;
        }
      }
    }
    crossLineSelActive = false;
  });

  // Clear cross-line selection when user clicks elsewhere
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#editor-pane')) {
      crossLineSelActive = false;
    }
  });

  // ── KEYBOARD SHORTCUTS (GLOBAL) ──────────────────────────────
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); app.openFind(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'h') { e.preventDefault(); app.openFindReplace(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveDocument(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      if (!e.target.closest('.modal-box')) { e.preventDefault(); app.selectAll(); }
    }

    // Handle Delete/Backspace on cross-line selection (mouse OR keyboard)
    if ((e.key === 'Delete' || e.key === 'Backspace') && (crossLineSelActive || ksel)) {
      const crossSel = getCrossLineSelection() || getKselAsCross();
      if (crossSel) {
        e.preventDefault();
        deleteSelection(crossSel);
        ksel = null;
        return;
      }
    }

    // Handle typing to replace cross-line selection (mouse selection only — ksel handled in line handler)
    if (crossLineSelActive && !ksel && !e.ctrlKey && !e.metaKey && !e.altKey
        && e.key.length === 1) {
      const crossSel = getCrossLineSelection();
      if (crossSel) {
        e.preventDefault();
        deleteSelection(crossSel);
        // Then insert the typed character into the now-active line
        requestAnimationFrame(() => {
          const r = getLineEl(crossSel.startLine)?.querySelector('.line-raw');
          if (r && document.activeElement === r) {
            const pos = r.selectionStart;
            const newVal = r.value.slice(0, pos) + e.key + r.value.slice(pos);
            r.value = newVal;
            lines[crossSel.startLine] = newVal;
            r.setSelectionRange(pos + 1, pos + 1);
            r.style.height = 'auto';
            r.style.height = r.scrollHeight + 'px';
            computeFenceStates();
            updateRendered(crossSel.startLine);
            scheduleAutosave();
          }
        });
        return;
      }
    }

    // Handle copy on cross-line selection (mouse or keyboard)
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && (crossLineSelActive || ksel)) {
      const crossSel = getCrossLineSelection() || getKselAsCross();
      if (crossSel) {
        const { startLine, startOffset, endLine, endOffset } = crossSel;
        const parts = [];
        for (let i = startLine; i <= endLine; i++) {
          const l = lines[i] || '';
          if (i === startLine && i === endLine) parts.push(l.slice(startOffset, endOffset));
          else if (i === startLine) parts.push(l.slice(startOffset));
          else if (i === endLine) parts.push(l.slice(0, endOffset));
          else parts.push(l);
        }
        navigator.clipboard?.writeText(parts.join('\n')).catch(() => {});
        e.preventDefault();
        return;
      }
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'x' && (crossLineSelActive || ksel)) {
      const crossSel = getCrossLineSelection() || getKselAsCross();
      if (crossSel) {
        const { startLine, startOffset, endLine, endOffset } = crossSel;
        const parts = [];
        for (let i = startLine; i <= endLine; i++) {
          const l = lines[i] || '';
          if (i === startLine && i === endLine) parts.push(l.slice(startOffset, endOffset));
          else if (i === startLine) parts.push(l.slice(startOffset));
          else if (i === endLine) parts.push(l.slice(0, endOffset));
          else parts.push(l);
        }
        navigator.clipboard?.writeText(parts.join('\n')).catch(() => {});
        e.preventDefault();
        ksel = null;
        deleteSelection(crossSel);
        return;
      }
    }

    if (e.key === 'Escape') { app.closeFind(); crossLineSelActive = false; ksel = null; }
  });

  // ── CLICK OUTSIDE MENU TO CLOSE ──────────────────────────────
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-item')) {
      document.querySelectorAll('.dropdown').forEach(d => d.style.display = '');
    }
  });

  // ── EDITOR PANE CLICK (BLANK AREA) ───────────────────────────
  document.getElementById('editor-pane').addEventListener('click', (e) => {
    if (e.target === document.getElementById('editor-pane') ||
        e.target === container) {
      // Click on blank space: focus last line
      const lastIdx = lines.length - 1;
      switchToRaw(lastIdx);
    }
  });

  // ── NOTES MANAGEMENT ────────────────────────────────────────
  // Storage layout:
  //   mv_notes_index  → { activeId, notes: [{id, name},...] }
  //   mv_note_{id}    → { content, lastSaved }
  //   mv_theme        → string

  const NOTES_INDEX_KEY = 'mv_notes_index';
  const NOTE_KEY = id => `mv_note_${id}`;
  const VALID_NAME = /^[a-zA-Z0-9_ ]+$/;

  const notes = {
    index: { activeId: null, notes: [] }, // loaded from storage

    // ── Load/Save index ──────────────────────────────────────
    loadIndex() {
      try {
        const raw = localStorage.getItem(NOTES_INDEX_KEY);
        if (raw) this.index = JSON.parse(raw);
      } catch (_) {}
      // Ensure always an array
      if (!Array.isArray(this.index.notes)) this.index.notes = [];
    },

    saveIndex() {
      localStorage.setItem(NOTES_INDEX_KEY, JSON.stringify(this.index));
    },

    saveNoteContent(id, content) {
      localStorage.setItem(NOTE_KEY(id), JSON.stringify({ content, lastSaved: Date.now() }));
    },

    loadNoteContent(id) {
      try {
        const raw = localStorage.getItem(NOTE_KEY(id));
        if (raw) return JSON.parse(raw).content || '';
      } catch (_) {}
      return '';
    },

    deleteNoteStorage(id) {
      localStorage.removeItem(NOTE_KEY(id));
    },

    // ── Generate unique ID ───────────────────────────────────
    genId() {
      return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    },

    // ── Save current editor content to active note ───────────
    flushCurrent() {
      if (!this.index.activeId) return;
      const content = lines.join('\n');
      this.saveNoteContent(this.index.activeId, content);
    },

    // ── Switch to a note ─────────────────────────────────────
    switchTo(id) {
      if (id === this.index.activeId) return;

      // Save current before switching
      this.flushCurrent();

      this.index.activeId = id;
      this.saveIndex();

      const content = this.loadNoteContent(id);
      setContent(content || '');

      this.renderList();
    },

    // ── Create new note ──────────────────────────────────────
    createNote(name) {
      name = (name || 'Untitled').trim();
      if (!VALID_NAME.test(name)) name = 'Untitled';

      // Deduplicate name
      const existing = this.index.notes.map(n => n.name);
      let finalName = name;
      let count = 2;
      while (existing.includes(finalName)) {
        finalName = `${name} ${count++}`;
      }

      const id = this.genId();
      this.index.notes.push({ id, name: finalName });

      // Save current, switch to new
      this.flushCurrent();
      this.index.activeId = id;
      this.saveIndex();
      this.saveNoteContent(id, '');
      setContent('');
      this.renderList();

      // Immediately put new note into rename mode
      requestAnimationFrame(() => this.startRename(id));
    },

    // ── Delete a note ────────────────────────────────────────
    deleteNote(id) {
      const entry = this.index.notes.find(n => n.id === id);
      if (!entry) return;
      if (!confirm(`Delete note "${entry.name}"?`)) return;

      this.deleteNoteStorage(id);
      this.index.notes = this.index.notes.filter(n => n.id !== id);

      if (this.index.activeId === id) {
        // Switch to another note
        const next = this.index.notes[0];
        if (next) {
          this.index.activeId = next.id;
          const content = this.loadNoteContent(next.id);
          setContent(content || '');
        } else {
          // No notes left — create a default one
          this.index.activeId = null;
          this.saveIndex();
          this.renderList();
          this.createNote('Untitled');
          return;
        }
      }

      this.saveIndex();
      this.renderList();
    },

    // ── Start inline rename ───────────────────────────────────
    startRename(id) {
      const row = document.querySelector(`.note-entry[data-id="${id}"]`);
      if (!row) return;
      const nameEl = row.querySelector('.note-name');
      if (!nameEl) return;

      const current = this.index.notes.find(n => n.id === id)?.name || '';

      // Replace name span with input
      const input = document.createElement('input');
      input.className = 'note-name-input';
      input.value = current;
      input.maxLength = 60;
      nameEl.replaceWith(input);

      // Hide action buttons during rename
      row.querySelector('.note-actions').style.display = 'none';

      input.focus();
      input.select();

      const commit = () => {
        let val = input.value.trim().replace(/[^a-zA-Z0-9_ ]/g, '').trim();
        if (!val) val = current;

        // Deduplicate
        const existing = this.index.notes.filter(n => n.id !== id).map(n => n.name);
        let finalName = val;
        let count = 2;
        while (existing.includes(finalName)) finalName = `${val} ${count++}`;

        const note = this.index.notes.find(n => n.id === id);
        if (note) note.name = finalName;
        this.saveIndex();
        this.renderList();
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = current; input.blur(); }
        // Filter invalid chars live
        if (e.key.length === 1 && !VALID_NAME.test(e.key)) e.preventDefault();
      });

      input.addEventListener('blur', commit);
    },

    // ── Render the sidebar list ───────────────────────────────
    renderList() {
      const list = document.getElementById('notes-list');
      if (!list) return;
      list.innerHTML = '';

      this.index.notes.forEach(({ id, name }) => {
        const row = document.createElement('div');
        row.className = 'note-entry' + (id === this.index.activeId ? ' active' : '');
        row.dataset.id = id;

        const icon = document.createElement('div');
        icon.className = 'note-icon';
        icon.textContent = '▸';

        const nameEl = document.createElement('div');
        nameEl.className = 'note-name';
        nameEl.textContent = name;
        nameEl.title = name;

        const actions = document.createElement('div');
        actions.className = 'note-actions';

        const renameBtn = document.createElement('button');
        renameBtn.className = 'note-btn';
        renameBtn.textContent = '✎';
        renameBtn.title = 'Rename';
        renameBtn.addEventListener('click', (e) => { e.stopPropagation(); this.startRename(id); });

        const delBtn = document.createElement('button');
        delBtn.className = 'note-btn del';
        delBtn.textContent = '✕';
        delBtn.title = 'Delete';
        delBtn.addEventListener('click', (e) => { e.stopPropagation(); this.deleteNote(id); });

        actions.appendChild(renameBtn);
        actions.appendChild(delBtn);

        row.appendChild(icon);
        row.appendChild(nameEl);
        row.appendChild(actions);

        row.addEventListener('click', () => this.switchTo(id));
        // Double-click to rename
        row.addEventListener('dblclick', (e) => { e.stopPropagation(); this.startRename(id); });

        list.appendChild(row);
      });
    },

    // ── Boot ─────────────────────────────────────────────────
    init() {
      this.loadIndex();

      if (this.index.notes.length === 0) {
        // First run — migrate old single document if present
        let migratedContent = '';
        try {
          const old = localStorage.getItem(STORAGE_KEY);
          if (old) {
            const parsed = JSON.parse(old);
            migratedContent = parsed.content || '';
            if (parsed.theme) app.setTheme(parsed.theme, true);
          }
        } catch (_) {}

        const id = this.genId();
        this.index.notes = [{ id, name: 'Untitled' }];
        this.index.activeId = id;
        this.saveNoteContent(id, migratedContent);
        this.saveIndex();
      }

      // Ensure activeId is valid
      if (!this.index.notes.find(n => n.id === this.index.activeId)) {
        this.index.activeId = this.index.notes[0].id;
        this.saveIndex();
      }

      this.renderList();

      const content = this.loadNoteContent(this.index.activeId);
      return content;
    }
  };

  // Expose notes globally too
  window.notes = notes;

  // ── SIDEBAR RESIZE ───────────────────────────────────────────
  (function initSidebarResize() {
    const handle = document.getElementById('sidebar-resize');
    const sidebar = document.getElementById('sidebar');
    if (!handle || !sidebar) return;

    let dragging = false;
    let startX = 0;
    let startW = 0;

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = sidebar.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const delta = e.clientX - startX;
      const newW = Math.max(120, Math.min(480, startW + delta));
      sidebar.style.flex = `0 0 ${newW}px`;
      sidebar.style.width = `${newW}px`;
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  })();

  // ── PATCH saveDocument to flush through notes system ────────
  // Override scheduleAutosave to also call notes.saveNoteContent
  const _origSaveDocument = saveDocument;
  function saveDocument() {
    const content = lines.join('\n');
    const theme = document.body.getAttribute('data-theme') || 'retro-neon';
    if (notes.index.activeId) {
      notes.saveNoteContent(notes.index.activeId, content);
    }
    // Also save theme
    try { localStorage.setItem('mv_theme', theme); } catch (_) {}
    setSaved();
    lastSavedContent = content;
  }

  // ── INIT ─────────────────────────────────────────────────────
  function init() {
    // Load theme first
    try {
      const theme = localStorage.getItem('mv_theme');
      if (theme) app.setTheme(theme, true);
    } catch (_) {}

    // Boot notes system — returns content of active note
    const content = notes.init();

    const WELCOME = `# Welcome to MarkVoid

Start typing your Markdown here. Each line renders independently.

## Features

- **Line-based editing** — click any line to edit it
- **Live rendering** — Markdown renders when you leave a line
- **Multiple notes** — manage notes in the left sidebar
- **Themes** — choose from Retro Neon, Black, White, or Red
- **Keyboard shortcuts** — Ctrl+F to find, Ctrl+H to replace
- **Auto-save** — your work is saved automatically

## Quick Tips

> Use the menu bar for file operations, find/replace, and tools.

\`\`\`js
// Code blocks are syntax highlighted
const msg = "Hello, MarkVoid!";
console.log(msg);
\`\`\`

| Feature | Status |
|---------|--------|
| Live render | ✓ |
| Notes sidebar | ✓ |
| Autosave | ✓ |
`;

    setContent(content || WELCOME);
    undoStack.push(lines.slice());
  }

  // Expose app globally
  window.app = app;

  init();

})();
