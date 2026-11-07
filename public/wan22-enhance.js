/* wan22-templates add-on interface layer
   Drop-in: no build step needed, no dependency on the app bundle's internals.
   Load AFTER the app bundle. Re-applies itself if the app rebuilds its DOM. */
(function () {
  'use strict';

  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var STEP_LABELS = [
    ['motion', '1 Motion', 'req', 'Required'],
    ['photo', '2 Photo', 'req', 'Required'],
    ['faces', '3 Second face', 'cond', 'Required for this template'],
    ['prompt', '4 Prompt', 'opt', 'Optional'],
    ['generate', '5 Generate', '', ''],
    ['extend', '6 Extend', 'opt', 'Optional']
  ];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function one(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }
  function all(sel) { try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { return []; } }

  // ---------- stepper ----------
  function buildStepper() {
    if (document.getElementById('enh-stepper')) return document.getElementById('enh-stepper');
    var header = one('header.top');
    if (!header) return null;
    var ol = el('ol', 'enh-stepper');
    ol.id = 'enh-stepper';
    ol.setAttribute('aria-label', 'Steps');
    STEP_LABELS.forEach(function (row) {
      var li = el('li');
      li.dataset.step = row[0];
      li.appendChild(document.createTextNode(row[1]));
      if (row[2]) li.appendChild(el('span', 'tag is-' + row[2], row[3]));
      li.addEventListener('click', function () {
        var target = sectionFor(row[0]);
        if (target) target.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
      });
      ol.appendChild(li);
    });
    header.parentNode.insertBefore(ol, header.nextSibling);
    return ol;
  }

  function sectionFor(key) {
    if (key === 'motion') return one('#template-rail');
    if (key === 'photo') return one('#upload-section');
    if (key === 'faces') return one('#second-face-section');
    if (key === 'prompt') return one('#prompt');
    if (key === 'generate') return one('#btn-generate');
    if (key === 'extend') return one('.extend-box');
    return null;
  }

  function state() {
    var selected = one('.tcard.active');
    var still = one('#photo-preview');
    var stillReady = !!still && !still.hidden && !!still.getAttribute('src');
    var faceSection = one('#second-face-section');
    var needsFace = !!faceSection && !faceSection.hidden;
    var faceShot = one('#second-face-preview');
    var faceReady = !!faceShot && !faceShot.hidden && !!faceShot.getAttribute('src');
    var result = one('#result-panel');
    return {
      motion: !!selected,
      photo: stillReady,
      faces: needsFace ? faceReady : 'skip',
      generate: !!result && !result.hidden
    };
  }

  function syncStepper() {
    var ol = buildStepper();
    if (!ol) return;
    var s = state();
    // prompt is optional, so it never holds the pointer
    var order = ['motion', 'photo', 'faces', 'generate'];
    var current = null;
    for (var i = 0; i < order.length; i++) {
      var key = order[i];
      if (s[key] === 'skip') continue;
      if (s[key] !== true) { current = key; break; }
    }
    all('#enh-stepper li').forEach(function (li) {
      var key = li.dataset.step;
      var done = s[key] === true || s[key] === 'skip' || (key === 'generate' && s.generate) || (key === 'extend' && s.generate);
      li.classList.toggle('is-done', !!done);
      li.classList.toggle('is-current', key === current);
    });
  }

  // ---------- required / optional badges ----------
  var BADGES = [
    ['#upload-section h2', 'req', 'Required'],
    ['#second-face-section h2', 'cond', 'Required for this template'],
    ['#selected-panel h3', '', ''],
    ['#panel-motions .section.actions h2', '', '']
  ];

  function tagHeading(node, kind, label) {
    if (!node || !kind) return;
    if (node.querySelector('.enh-badge')) return;
    var span = el('span', 'enh-badge is-' + kind, label);
    node.appendChild(span);
  }

  function tagSections() {
    // photo / second face
    tagHeading(one('#upload-section h2'), 'req', 'Required');
    var faceSection = one('#second-face-section');
    if (faceSection && !faceSection.hidden) tagHeading(faceSection.querySelector('h2'), 'cond', 'Required for this template');

    // prompt + negative prompt
    var promptSection = one('#prompt') && one('#prompt').closest('section');
    if (promptSection) tagHeading(promptSection.querySelector('h2'), 'opt', 'Optional, pre-filled');
    var negSection = one('#negative-prompt') && one('#negative-prompt').closest('section');
    if (negSection) tagHeading(negSection.querySelector('h2'), 'opt', 'Optional, pre-filled');

    // extend target seconds
    var target = one('#extend-target') && one('#extend-target').closest('label');
    if (target && !target.querySelector('.enh-badge')) target.querySelector('label, span') || target.appendChild(el('span', 'enh-badge is-opt', 'Optional'));
    if (target && !target.querySelector('.enh-badge')) target.appendChild(el('span', 'enh-badge is-opt', 'Optional'));

    // extend negative prompt
    var extNeg = one('#extend-negative-prompt') && one('#extend-negative-prompt').closest('label');
    if (extNeg && !extNeg.querySelector('.enh-badge')) extNeg.appendChild(el('span', 'enh-badge is-opt', 'Optional'));
  }

  // ---------- next action line ----------
  function nextCopy(s) {
    if (!s.motion) return 'Next: scroll the motions and tap one. That unlocks the photo upload.';
    if (!s.photo) return 'Next: upload your still. JPG or PNG, face or full body.';
    if (s.faces !== 'skip' && s.faces !== true) return 'Next: upload the second face. This template has two people.';
    if (!s.generate) return 'Next: tap Generate. It runs on Runpod, and the first run can take a few minutes while the worker starts.';
    return 'Next: Download the clip, or extend it in the Space for a longer version.';
  }

  function syncNextLine() {
    var actions = one('#btn-generate') && one('#btn-generate').closest('section');
    if (!actions) return;
    var line = document.getElementById('enh-next');
    if (!line) {
      line = el('p', 'enh-next');
      line.id = 'enh-next';
      var status = one('#gen-status');
      if (status && status.parentNode === actions) actions.insertBefore(line, status.nextSibling);
      else actions.appendChild(line);
    }
    line.textContent = nextCopy(state());
  }

  // ---------- engine clear copy ----------
  function engineNotes() {
    var actions = one('#btn-generate') && one('#btn-generate').closest('section');
    if (actions && !actions.querySelector('.enh-engine')) {
      var bar = el('p', 'enh-engine');
      bar.appendChild(el('span', 'engine-chip is-runpod', 'Runpod'));
      bar.appendChild(document.createTextNode(' Generate renders on Runpod. First run may start the worker.'));
      actions.insertBefore(bar, actions.firstChild);
    }
    var box = one('.extend-box');
    if (box && !box.querySelector('.enh-engine-space')) {
      var line = el('p', 'enh-engine-space');
      line.appendChild(el('span', 'engine-chip is-space', 'Hugging Face Space'));
      line.appendChild(document.createTextNode(' Extend runs in the Space and cannot continue a Runpod clip.'));
      var summary = box.querySelector('summary');
      if (summary && summary.nextSibling) box.insertBefore(line, summary.nextSibling);
      else box.appendChild(line);
    }
  }

  // ---------- running timer (real elapsed time, never a fake percentage) ----------
  var started = 0;
  var timer = null;
  function startTimer() {
    var btn = one('#btn-generate');
    if (!btn) return;
    started = Date.now();
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      var line = document.getElementById('enh-run');
      if (!line) return;
      var secs = Math.floor((Date.now() - started) / 1000);
      var mm = Math.floor(secs / 60);
      var ss = String(secs % 60).padStart(2, '0');
      line.textContent = 'Working · ' + mm + ':' + ss + ' · leave this tab open';
      if (secs > 900) { clearInterval(timer); timer = null; }
    }, 1000);
  }
  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    var line = document.getElementById('enh-run');
    if (line) line.remove();
  }
  function syncRunPill() {
    var result = one('#result-panel');
    var btn = one('#btn-generate');
    if (!btn) return;
    var statusText = ((one('#gen-status') || {}).textContent || '').trim();
    var resultHidden = !result || result.hidden;
    var running = btn.disabled && resultHidden && statusText.length > 0;
    var actions = btn.closest('section');
    var pill = document.getElementById('enh-run');
    if (running && !pill && actions) {
      pill = el('p', 'enh-run');
      pill.id = 'enh-run';
      pill.textContent = 'Working · 0:00 · leave this tab open';
      actions.appendChild(pill);
      startTimer();
    }
    if (!running && pill) stopTimer();
  }

  // ---------- copy tweaks ----------
  function copyTweaks() {
    var hint = one('#upload-hint');
    if (hint && /Pick a motion above/.test(hint.textContent) && !hint.dataset.enh) {
      hint.dataset.enh = '1';
      hint.textContent = 'Locked: choose a motion first. One tap on a clip above unlocks this.';
    }
    var sub = one('.top .sub');
    if (sub && !sub.dataset.enh) {
      sub.dataset.enh = '1';
      sub.textContent = '1 Scroll · 2 Tap a motion · 3 Upload your still · 4 Generate';
    }
  }

  function applyAll() {
    try { buildStepper(); } catch (e) {}
    try { syncStepper(); } catch (e) {}
    try { tagSections(); } catch (e) {}
    try { syncNextLine(); } catch (e) {}
    try { engineNotes(); } catch (e) {}
    try { syncRunPill(); } catch (e) {}
    try { copyTweaks(); } catch (e) {}
  }

  function boot() {
    applyAll();
    // re-apply when the app swaps panels, selects a tile, unhides a section or finishes a render
    var pending = null;
    var observer = new MutationObserver(function () {
      if (pending) return;
      pending = setTimeout(function () { pending = null; applyAll(); }, 120);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'disabled'] });
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#btn-generate')) setTimeout(applyAll, 60);
      if (t.closest('.tcard')) setTimeout(applyAll, 60);
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
