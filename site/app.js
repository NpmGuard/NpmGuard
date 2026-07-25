/* NpmGuard explainer — no dependencies, no scroll-jacking.
 *
 * Three behaviours, in order of importance:
 *   1. reveal-on-enter    — entrance transitions only; never scroll-linked,
 *                           never pinned, never a scroll hijack.
 *   2. the hero exhibit   — a timed replay of one real audit.
 *   3. theme + copy       — small chrome.
 *
 * Reduced motion is handled by CSS (everything lands instantly). The JS still
 * runs so no content is missing; it just stops pacing things out.
 */
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* --- 1. Reveal on enter ------------------------------------------------ */

  var revealables = document.querySelectorAll('.reveal, .stage__viz, .spine, .codeblock, #problem .card');

  if (!('IntersectionObserver' in window)) {
    revealables.forEach(function (el) { el.classList.add('in-view'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in-view');
        io.unobserve(entry.target);           // entrance only — it never plays back
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });

    // Stagger siblings inside a grid: 40ms per item, capped at 6 items.
    document.querySelectorAll('.grid-2, .grid-3, .grid-4').forEach(function (grid) {
      Array.prototype.slice.call(grid.children).forEach(function (child, i) {
        child.style.setProperty('--reveal-delay', Math.min(i, 5) * 40 + 'ms');
      });
    });

    revealables.forEach(function (el) { io.observe(el); });
  }

  /* --- 2. The hero exhibit ----------------------------------------------- */

  var exhibit = document.getElementById('exhibit');

  if (exhibit) {
    var steps  = exhibit.querySelectorAll('[data-step]');
    var events = exhibit.querySelectorAll('[data-ev]');
    var stamp  = document.getElementById('hero-stamp');
    var replay = document.getElementById('replay');
    var timers = [];

    function clear() {
      timers.forEach(clearTimeout);
      timers = [];
    }

    function at(ms, fn) { timers.push(setTimeout(fn, ms)); }

    function settle() {
      steps.forEach(function (s) { s.classList.add('is-on'); });
      events.forEach(function (e) {
        e.classList.add('is-on');
        if (e.hasAttribute('data-cited')) e.classList.add('is-cited');
      });
      if (stamp) stamp.classList.add('is-revealed');
    }

    function reset() {
      steps.forEach(function (s) { s.classList.remove('is-on'); });
      events.forEach(function (e) { e.classList.remove('is-on', 'is-cited'); });
      if (stamp) stamp.classList.remove('is-revealed');
    }

    function play() {
      clear();
      if (reduced.matches) { settle(); return; }

      reset();

      var t = 120;

      // Steps 01–04 arrive one after another.
      for (var i = 0; i < 4 && i < steps.length; i++) {
        (function (el, when) { at(when, function () { el.classList.add('is-on'); }); })(steps[i], t);
        t += 520;
      }

      // Step 05 opens, then the recording fills in event by event.
      if (steps[4]) {
        at(t, function () { steps[4].classList.add('is-on'); });
        t += 340;
        events.forEach(function (ev) {
          at(t, function () { ev.classList.add('is-on'); });
          t += 210;
        });
      }

      // The three cited events light up together — the citation IS the finding.
      t += 260;
      at(t, function () {
        events.forEach(function (ev) {
          if (ev.hasAttribute('data-cited')) ev.classList.add('is-cited');
        });
      });

      // Then the verdict. No bounce, no scale, no celebration — it crossfades
      // in and its border goes 1px → 2px.
      t += 420;
      at(t, function () {
        if (steps[5]) steps[5].classList.add('is-on');
        at(140, function () { if (stamp) stamp.classList.add('is-revealed'); });
      });
    }

    // Play once the exhibit is actually on screen, not on page load.
    if ('IntersectionObserver' in window) {
      var heroIo = new IntersectionObserver(function (entries) {
        if (!entries[0].isIntersecting) return;
        heroIo.disconnect();
        play();
      }, { threshold: 0.35 });
      heroIo.observe(exhibit);
    } else {
      play();
    }

    if (replay) replay.addEventListener('click', play);
    reduced.addEventListener('change', function () { clear(); settle(); });
  }

  /* --- 3. The journey ----------------------------------------------------- */
  /* Each stage's visual PERFORMS its step the first time you reach it. The
   * trigger is "this element is on screen", never "the scrollbar is at X" —
   * so scrolling stays entirely the reader's, at any speed, in any direction. */

  function once(el, fn) {
    if (!('IntersectionObserver' in window)) { fn(el); return; }
    var o = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      o.disconnect();
      fn(el);
    }, { threshold: 0.4, rootMargin: '0px 0px -8% 0px' });
    o.observe(el);
  }

  /* 3a. Generic sequencer: reveal [data-seq-item] children one at a time. */
  function sequence(root, done) {
    var items = root.querySelectorAll('[data-seq-item]');
    var gap = parseInt(root.getAttribute('data-seq-gap') || '260', 10);

    if (reduced.matches) {
      items.forEach(function (el) { el.classList.add('is-on'); });
      if (done) done();
      return;
    }
    items.forEach(function (el, i) {
      setTimeout(function () { el.classList.add('is-on'); }, i * gap);
    });
    if (done) setTimeout(done, items.length * gap);
  }

  /* 3b. Typewriter — the package's pitch is written out, not pasted in. */
  function typeInto(el, text, cps, then) {
    var caret = el.querySelector('.caret');
    if (reduced.matches) {
      el.insertBefore(document.createTextNode(text), caret || null);
      if (caret) caret.classList.add('is-off');
      if (then) then();
      return;
    }
    var node = document.createTextNode('');
    el.insertBefore(node, caret || null);
    var i = 0;
    (function tick() {
      node.nodeValue = text.slice(0, ++i);
      if (i < text.length) { setTimeout(tick, 1000 / cps); return; }
      if (caret) setTimeout(function () { caret.classList.add('is-off'); }, 900);
      if (then) then();
    })();
  }

  /* 3c. Count a number up, so the recording visibly accumulates. */
  function countTo(el, target, ms) {
    if (reduced.matches) { el.textContent = String(target); return; }
    var start = performance.now();
    (function frame(now) {
      var t = Math.min(1, (now - start) / ms);
      el.textContent = String(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) requestAnimationFrame(frame);
    })(start);
  }

  document.querySelectorAll('[data-seq], [data-fx]').forEach(function (root) {
    var fx = root.getAttribute('data-fx');

    once(root, function () {
      root.classList.add('fx-on');

      if (fx === 'type') {
        // The README lands, then the one-sentence purpose is typed beneath it.
        sequence(root);
        var line = root.querySelector('.typeline');
        var chips = root.querySelector('.chiprow');
        if (chips) chips.style.opacity = '0';
        setTimeout(function () {
          typeInto(line, line.getAttribute('data-type'), 42, function () {
            if (!chips) return;
            chips.style.transition = 'opacity var(--dur-enter) var(--ease-out)';
            chips.style.opacity = '1';
          });
        }, reduced.matches ? 0 : 1650);
        return;
      }

      if (fx === 'scan') {
        // A read head passes over the file, then the guilty lines light up.
        setTimeout(function () { root.classList.add('fx-done'); },
                   reduced.matches ? 0 : 1250);
        return;
      }

      if (fx === 'fire') {
        // Arm the bench, then press the trigger — exactly once.
        sequence(root, function () {
          setTimeout(function () { root.classList.add('fx-fired'); },
                     reduced.matches ? 0 : 200);
        });
        return;
      }

      if (fx === 'record') {
        // Four sensors accumulate events in parallel.
        root.querySelectorAll('.rail__c').forEach(function (c, i) {
          setTimeout(function () {
            countTo(c, parseInt(c.getAttribute('data-count'), 10), 2200);
          }, reduced.matches ? 0 : i * 160);
        });
        return;
      }

      if (fx === 'judge') {
        // The uncited ruling arrives and is thrown out; the cited one stands.
        sequence(root, function () {
          var stamp = root.querySelector('[data-stamp]');
          root.querySelectorAll('[data-cite]').forEach(function (c, i) {
            setTimeout(function () { c.classList.add('is-on'); },
                       reduced.matches ? 0 : 260 + i * 170);
          });
          setTimeout(function () { if (stamp) stamp.classList.add('is-revealed'); },
                     reduced.matches ? 0 : 900);
        });
        return;
      }

      if (fx === 'term') { playTerm(root); return; }

      sequence(root);
    });
  });

  /* 3d. Step rail — reflects where the reader is. It is a readout, not a
   *     controller: it never moves the page and never blocks the scroll. */
  (function () {
    var bar = document.getElementById('stepbar');
    var stages = document.querySelectorAll('.stages .stage');
    if (!bar || !stages.length || !('IntersectionObserver' in window)) return;

    var nodes = bar.querySelectorAll('.stepbar__node');
    var active = -1;

    function mark(i) {
      if (i === active) return;
      active = i;
      nodes.forEach(function (n, k) {
        n.classList.toggle('is-active', k === i);
        n.classList.toggle('is-done', k < i);
      });
    }

    var rail = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) mark(Array.prototype.indexOf.call(stages, e.target));
      });
    }, { rootMargin: '-45% 0px -45% 0px' });

    stages.forEach(function (s) { rail.observe(s); });
  })();

  /* 3e. The terminal — what this actually looks like on your machine. */
  function playTerm(root) {
    var cmdEl = root.querySelector('[data-type-term]');
    var caret = root.querySelector('.term__line--cmd .caret');
    var outs  = root.querySelectorAll('[data-term-out]');

    function showOut(from) {
      outs.forEach(function (l, i) {
        setTimeout(function () { l.classList.add('is-on'); },
                   reduced.matches ? 0 : from + i * 190);
      });
    }

    if (reduced.matches) {
      cmdEl.textContent = cmdEl.getAttribute('data-type-term');
      if (caret) caret.classList.add('is-off');
      showOut(0);
      return;
    }

    cmdEl.textContent = '';
    if (caret) caret.classList.remove('is-off');
    outs.forEach(function (l) { l.classList.remove('is-on'); });

    var text = cmdEl.getAttribute('data-type-term');
    var i = 0;
    (function tick() {
      cmdEl.textContent = text.slice(0, ++i);
      if (i < text.length) { setTimeout(tick, 34); return; }
      if (caret) caret.classList.add('is-off');
      showOut(420);
    })();
  }

  var termReplay = document.getElementById('term-replay');
  if (termReplay) {
    termReplay.addEventListener('click', function () {
      playTerm(document.getElementById('term'));
    });
  }

  /* --- 4. Theme ----------------------------------------------------------- */

  var root  = document.documentElement;
  var toggle = document.getElementById('theme');

  var stored = null;
  try { stored = localStorage.getItem('npmguard-theme'); } catch (e) { /* private mode */ }
  if (stored === 'light' || stored === 'dark') root.setAttribute('data-theme', stored);

  function currentIsDark() {
    var explicit = root.getAttribute('data-theme');
    if (explicit) return explicit === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = currentIsDark() ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('npmguard-theme', next); } catch (e) { /* ignore */ }
    });
  }

  /* --- 5. Copy ------------------------------------------------------------ */

  var copy = document.getElementById('copy');
  if (copy && navigator.clipboard) {
    copy.addEventListener('click', function () {
      navigator.clipboard.writeText(copy.getAttribute('data-copy')).then(function () {
        var was = copy.textContent;
        copy.textContent = 'Copied';
        setTimeout(function () { copy.textContent = was; }, 1600);
      });
    });
  }
})();
