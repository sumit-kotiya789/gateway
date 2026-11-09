// Hosted checkout motion (D-108): a small 3D model per invoice state, a confetti rain when the payment confirms, and a
// thank-you screen once it settles. Pure CSS 3D (layered extrusions, cubes) plus a canvas for confetti: no library,
// nothing fetched, works under the page's nonce-only CSP (no style attributes: every transform lives in the stylesheet)
// and inside the widget iframe. prefers-reduced-motion turns all of it off. Never animate opacity on (or above) a 3D
// model: opacity < 1 flattens preserve-3d into a plane.
import { html, raw, type SafeHtml } from './html.js';

/** Which model each status shows. `settle`: confirmed, waiting for settlement; `medal`: settled (thank-you screen). */
export const MODEL_OF: Record<string, string> = {
  created: 'coin',
  pending: 'coin',
  detected: 'detect',
  confirming: 'blocks',
  paid: 'settle',
  overpaid: 'settle',
  settled: 'medal',
  underpaid: 'partial',
  expired: 'glass',
  cancelled: 'cross',
  failed: 'cross',
  late_payment: 'shield',
  held: 'shield',
  partially_paid: 'shield',
};

/** Colour of the status panel. Anything not listed waits (green pulse). */
export const TONE_OF: Record<string, string> = {
  paid: 'ok',
  overpaid: 'ok',
  settled: 'ok',
  underpaid: 'warn',
  late_payment: 'warn',
  held: 'warn',
  partially_paid: 'warn',
  expired: 'bad',
  cancelled: 'bad',
  failed: 'bad',
};

const LAYERS = 9;

/** A shape extruded into 3D: the same face stacked LAYERS times, 1px apart; first and last layers carry the face. */
function extruded(cls: string, face: SafeHtml | string = ''): SafeHtml {
  const layers = Array.from({ length: LAYERS }, (_, i) => (i === 0 || i === LAYERS - 1 ? html`<i>${face}</i>` : raw('<i></i>')));
  return html`<div class="ex ${cls}">${layers}</div>`;
}

const TICK = raw(
  '<svg viewBox="0 0 24 24"><path class="tick" d="M6.5 12.5l3.6 3.6 7.4-8.2" pathLength="1" fill="none" stroke="#031007" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
);
const CROSS = raw('<svg viewBox="0 0 24 24"><path d="M8 8l8 8M16 8l-8 8" fill="none" stroke="#2a0606" stroke-width="3" stroke-linecap="round"/></svg>');
const BANG = raw('<svg viewBox="0 0 24 24"><path d="M12 7v6.5M12 17v.4" fill="none" stroke="#1b1000" stroke-width="3" stroke-linecap="round"/></svg>');
const SAND = raw('<svg viewBox="0 0 36 54"><path d="M9 48h18l-9-9z" fill="rgba(27,16,0,.55)"/><path d="M13 12h10l-5 5z" fill="rgba(27,16,0,.35)"/></svg>');

const coin = (symbol: string) => html`<div class="bob"><div class="spin">${extruded('coin', html`<b>${symbol}</b>`)}</div></div>`;
const cube = raw('<div class="cube"><i class="f1"></i><i class="f2"></i><i class="f3"></i><i class="f4"></i><i class="f5"></i><i class="f6"></i></div>');
const medal = html`<div class="pop"><div class="sway">${extruded('medal', TICK)}</div></div>`;

/** Every model, stacked; the panel's data-model attribute shows one. */
export function sceneModels(symbol: string, progress: number): SafeHtml {
  const sym = Array.from(symbol).slice(0, 4).join('');
  return html`
<div class="m m-coin"><span class="ring"></span><span class="ring r2"></span><span class="spark s1"></span><span class="spark s2"></span><span class="spark s3"></span><span class="spark s4"></span>${coin(sym)}<span class="shadow"></span></div>
<div class="m m-blocks"><div class="iso"><div class="slot k1">${cube}</div><div class="slot k2">${cube}</div><div class="slot k3">${cube}</div></div><span class="shadow wide"></span></div>
<div class="m m-medal"><span class="orbit"></span>${medal}<span class="shadow"></span></div>
<div class="m m-partial"><svg class="pring" viewBox="0 0 76 76"><circle class="track" cx="38" cy="38" r="34"/><circle id="arc" class="arc" cx="38" cy="38" r="34" pathLength="100" stroke-dasharray="${String(progress)} 100"/></svg>${coin(sym)}</div>
<div class="m m-glass"><div class="sway slow">${extruded('glass', SAND)}</div><span class="shadow"></span></div>
<div class="m m-shield"><div class="sway slow">${extruded('shield', BANG)}</div><span class="shadow"></span></div>
<div class="m m-cross"><div class="sway slow">${extruded('medal bad', CROSS)}</div><span class="shadow"></span></div>`;
}

/** The thank-you screen's big medal with rays and a halo. */
export const HERO = html`<div class="hero" id="hero" aria-hidden="true"><span class="rays"></span><span class="halo"></span><div class="stage big"><div class="m m-medal">${medal}<span class="shadow"></span></div></div></div>`;

const z = (i: number) => i - (LAYERS - 1) / 2;
const LAYER_CSS = Array.from({ length: LAYERS }, (_, i) => `.ex>i:nth-child(${String(i + 1)}){transform:translateZ(${String(z(i))}px)${i === 0 ? ' rotateY(180deg)' : ''}}`).join('');

export const SCENE_CSS = `
.state{display:grid;grid-template-columns:76px 1fr;align-items:center;gap:14px;margin-top:18px;padding:12px 16px 12px 10px;border-radius:18px;
border:1px solid var(--line);background:rgba(255,255,255,.03);transition:background .5s,border-color .5s}
.state-text{display:grid;gap:3px;min-width:0}
.state-text strong{font-size:15px;font-weight:600;letter-spacing:-.005em}
.state-text span{font-size:13px;line-height:1.45;color:var(--muted)}
.state.swap .state-text{animation:fadeUp .5s ease-out}
.state[data-tone=ok]{border-color:rgba(52,214,92,.42);background:linear-gradient(135deg,rgba(52,214,92,.16),rgba(52,214,92,.04))}
.state[data-tone=ok] strong{color:#b8ffc8}
.state[data-tone=warn]{border-color:rgba(245,185,71,.38);background:linear-gradient(135deg,rgba(245,185,71,.12),rgba(245,185,71,.03))}
.state[data-tone=warn] strong{color:#ffe2ad}
.state[data-tone=bad]{border-color:rgba(255,107,107,.38);background:linear-gradient(135deg,rgba(255,107,107,.11),rgba(255,107,107,.03))}
.state[data-tone=bad] strong{color:#ffd0d0}
.stage{position:relative;width:76px;height:76px;perspective:420px}
.m{position:absolute;inset:0;display:none;transform-style:preserve-3d}
.state[data-model=coin] .m-coin,.state[data-model=detect] .m-coin,.state[data-model=blocks] .m-blocks,.state[data-model=settle] .m-medal,
.state[data-model=medal] .m-medal,.state[data-model=partial] .m-partial,.state[data-model=glass] .m-glass,.state[data-model=shield] .m-shield,
.state[data-model=cross] .m-cross,.hero .m-medal{display:block}
.bob,.spin,.pop,.sway{position:absolute;inset:0;transform-style:preserve-3d}
.ex{position:absolute;transform-style:preserve-3d}
.ex>i{position:absolute;inset:0;background:var(--edge)}
.ex>i:first-child,.ex>i:last-child{background:var(--face)}
.ex>i>b,.ex>i>svg{position:absolute;inset:0;margin:auto}
${LAYER_CSS}
.shadow{position:absolute;left:22px;right:22px;bottom:2px;height:7px;border-radius:50%;background:radial-gradient(closest-side,rgba(0,0,0,.6),transparent);
animation:shade 2.6s ease-in-out infinite}
.shadow.wide{left:16px;right:16px}

/* coin: waiting (slow spin, radar rings) and detected (fast spin, sparks) */
.coin{left:14px;top:11px;width:48px;height:48px;--edge:linear-gradient(90deg,#0b6a26,#1fb84a 50%,#0b6a26);
--face:radial-gradient(circle at 34% 28%,#c4ffd2,#45e46c 42%,#0d7f2a 100%)}
.coin>i{border-radius:50%}
.coin>i:first-child,.coin>i:last-child{box-shadow:inset 0 0 0 3px rgba(3,16,7,.22),inset 0 -6px 10px rgba(3,16,7,.25)}
.coin b{display:grid;place-items:center;font:800 11px/1 var(--font);letter-spacing:.02em;color:#031007}
.bob{animation:bob 2.6s ease-in-out infinite}
.spin{animation:spinY 3.6s linear infinite}
.ring{position:absolute;inset:6px;border-radius:50%;border:1.5px solid rgba(52,214,92,.55);animation:radar 2.4s ease-out infinite}
.ring.r2{animation-delay:1.2s}
.spark{display:none;position:absolute;left:36px;top:34px;width:5px;height:5px;border-radius:50%;background:#b8ffc8;box-shadow:0 0 8px #7dff9b}
.s1{--dx:-26px;--dy:-22px}.s2{--dx:26px;--dy:-24px;animation-delay:.35s!important}.s3{--dx:-24px;--dy:20px;animation-delay:.7s!important}
.s4{--dx:25px;--dy:18px;animation-delay:1.05s!important}
.state[data-model=detect] .spin{animation-duration:.85s}
.state[data-model=detect] .ring{animation-duration:1.2s;border-color:rgba(125,255,155,.75)}
.state[data-model=detect] .ring.r2{animation-delay:.6s}
.state[data-model=detect] .spark{display:block;animation:spark 1.4s ease-out infinite}

/* blocks: confirmations stacking up */
.iso{position:absolute;left:29px;top:50px;width:18px;height:18px;transform-style:preserve-3d;transform:rotateX(-24deg) rotateY(45deg);
animation:iso 10s linear infinite}
.slot{position:absolute;inset:0;transform-style:preserve-3d}
.k2{transform:translateY(-19px)}.k3{transform:translateY(-38px)}
.cube{position:absolute;inset:0;transform-style:preserve-3d;animation:drop 3.6s cubic-bezier(.3,.8,.3,1) infinite backwards}
.k2 .cube{animation-delay:.55s}.k3 .cube{animation-delay:1.1s}
.cube>i{position:absolute;inset:0;border:1px solid rgba(184,255,200,.45);background:linear-gradient(160deg,rgba(69,228,108,.85),rgba(11,106,38,.9));
box-shadow:inset 0 0 10px rgba(184,255,200,.35)}
.cube .f1{transform:translateZ(9px)}.cube .f2{transform:rotateY(180deg) translateZ(9px)}.cube .f3{transform:rotateY(90deg) translateZ(9px);background:linear-gradient(160deg,rgba(52,214,92,.95),rgba(11,106,38,.95))}
.cube .f4{transform:rotateY(-90deg) translateZ(9px)}.cube .f5{transform:rotateX(90deg) translateZ(9px);background:linear-gradient(160deg,#e2ffe8,#5df07f)}
.cube .f6{transform:rotateX(-90deg) translateZ(9px)}

/* medal: confirmed (settle: an orbit while the merchant side finishes) and settled (thank-you) */
.medal{left:12px;top:10px;width:52px;height:52px;--edge:linear-gradient(90deg,#0b6a26,#29c957 50%,#0b6a26);
--face:radial-gradient(circle at 34% 26%,#e2ffe8,#5df07f 38%,#19b347 70%,#0b6a26)}
.medal>i{border-radius:50%}
.medal>i:first-child,.medal>i:last-child{box-shadow:inset 0 0 0 3px rgba(255,255,255,.28),inset 0 -8px 14px rgba(3,16,7,.28),0 0 18px rgba(52,214,92,.35)}
.medal svg{width:30px;height:30px}
.tick{stroke-dasharray:1;stroke-dashoffset:1;animation:draw .7s .35s ease-out forwards}
.medal.bad{--edge:linear-gradient(90deg,#6e1515,#c94646 50%,#6e1515);--face:radial-gradient(circle at 34% 26%,#ffe0e0,#ff8a8a 40%,#c94646 75%,#6e1515)}
.medal.bad>i:first-child,.medal.bad>i:last-child{box-shadow:inset 0 0 0 3px rgba(255,255,255,.22),inset 0 -8px 14px rgba(40,4,4,.3)}
.pop{animation:pop .75s cubic-bezier(.2,1.5,.4,1) both}
.sway{animation:sway 3.4s ease-in-out infinite}
.sway.slow{animation-duration:5s}
.orbit{display:none;position:absolute;inset:2px;border-radius:50%;border:1.5px dashed rgba(184,255,200,.55);transform:rotateX(70deg);
animation:orbit 3.2s linear infinite}
.orbit::after{content:"";position:absolute;top:-4px;left:50%;width:7px;height:7px;margin-left:-3.5px;border-radius:50%;background:#e2ffe8;box-shadow:0 0 10px #7dff9b}
.state[data-model=settle] .orbit{display:block}

/* partial payment: progress ring around a coin */
.pring{position:absolute;inset:0;transform:rotate(-90deg)}
.pring circle{fill:none;stroke-width:4}
.pring .track{stroke:rgba(255,255,255,.1)}
.pring .arc{stroke:var(--warn);stroke-linecap:round;transition:stroke-dasharray .8s ease-out;filter:drop-shadow(0 0 4px rgba(245,185,71,.6))}
.m-partial .coin{left:18px;top:18px;width:40px;height:40px}
.m-partial .coin b{font-size:9px}

/* expired: hourglass; review: shield */
.glass{left:20px;top:9px;width:36px;height:54px;--edge:#7a6533;--face:linear-gradient(180deg,#fff0cc,#f5b947)}
.glass>i{clip-path:polygon(8% 0,92% 0,92% 9%,58% 50%,92% 91%,92% 100%,8% 100%,8% 91%,42% 50%,8% 9%)}
.state[data-tone=bad] .glass{--edge:#5c3a3a;--face:linear-gradient(180deg,#ffe0e0,#d98a8a)}
.shield{left:16px;top:9px;width:44px;height:54px;--edge:linear-gradient(90deg,#7a5410,#e0a43a 50%,#7a5410);--face:linear-gradient(170deg,#fff0cc,#f5b947 55%,#b8801f)}
.shield>i{clip-path:polygon(50% 0,94% 14%,94% 48%,80% 74%,50% 100%,20% 74%,6% 48%,6% 14%)}
.shield svg,.glass svg{width:100%;height:100%}
.shield svg{width:26px;height:26px}

/* thank-you screen */
.done{text-align:center;padding:2px 0 0}
.hero{position:relative;height:156px;display:grid;place-items:center;margin:-6px 0 4px;animation:rise .7s ease-out both}
.rays{position:absolute;left:50%;top:50%;width:320px;height:320px;margin:-160px 0 0 -160px;border-radius:50%;
background:repeating-conic-gradient(from 0deg,rgba(52,214,92,.18) 0deg 5deg,transparent 5deg 20deg);
-webkit-mask:radial-gradient(circle,#000 16%,transparent 60%);mask:radial-gradient(circle,#000 16%,transparent 60%);animation:rot 26s linear infinite}
.halo{position:absolute;left:50%;top:50%;width:130px;height:130px;margin:-65px 0 0 -65px;border-radius:50%;
background:radial-gradient(circle,rgba(52,214,92,.5),transparent 66%);filter:blur(6px);animation:halo 2.8s ease-in-out infinite}
.stage.big{transform:scale(1.65);z-index:1}
.thanks{font-size:30px;font-weight:700;letter-spacing:-.02em;margin:4px 0 6px;background:linear-gradient(90deg,#fff,#b8ffc8 60%,#7dff9b);
-webkit-background-clip:text;background-clip:text;color:transparent;animation:fadeUp .6s .15s both}
.done-msg{color:var(--fg2);margin:0 auto 16px;max-width:340px;animation:fadeUp .6s .25s both}
.receipt{text-align:left;animation:fadeUp .6s .35s both}
.receipt code{font:12px/1.4 var(--mono);color:var(--fg2)}
.close-hint{font-size:12.5px;margin:14px 0 0;animation:fadeUp .6s .45s both}
#fx{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:50}

@keyframes spinY{to{transform:rotateY(360deg)}}
@keyframes bob{50%{transform:translateY(-5px)}}
@keyframes shade{50%{transform:scaleX(.78);opacity:.45}}
@keyframes radar{0%{transform:scale(.55);opacity:.8}100%{transform:scale(1.28);opacity:0}}
@keyframes spark{0%{transform:translate(0,0) scale(.4);opacity:0}25%{opacity:1}100%{transform:translate(var(--dx),var(--dy)) scale(1);opacity:0}}
@keyframes iso{to{transform:rotateX(-24deg) rotateY(405deg)}}
@keyframes drop{0%{transform:translateY(-14px) scale(.001)}6%{transform:translateY(-14px) scale(1)}18%{transform:translateY(0) scale(1)}88%{transform:translateY(0) scale(1)}100%{transform:translateY(0) scale(.001)}}
@keyframes pop{0%{transform:scale(.2)}100%{transform:scale(1)}}
@keyframes sway{0%,100%{transform:rotateY(-20deg)}50%{transform:rotateY(20deg)}}
@keyframes orbit{to{transform:rotateX(70deg) rotateZ(360deg)}}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes rot{to{transform:rotate(360deg)}}
@keyframes halo{50%{transform:scale(1.15);opacity:.7}}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}}
@keyframes rise{from{transform:translateY(14px)}}
@media (prefers-reduced-motion:reduce){.tick{stroke-dashoffset:0}.ring,.spark,.orbit::after,.rays{display:none!important}}
`;

/**
 * Client side: maps a status to its model and tone, and the confetti (rain on confirmation, a burst on the thank-you
 * screen). Exposes window.gwScene for the checkout script.
 */
export const SCENE_JS = `
(function(){
  var calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var fx = document.getElementById('fx'); var ctx = fx && fx.getContext ? fx.getContext('2d') : null;
  var parts = [], raf = 0, W = 0, H = 0;
  var COLORS = ['#34d65c', '#7dff9b', '#b8ffc8', '#ffffff', '#19b347', '#f5d76e', '#e2ffe8'];
  function size(){ var d = window.devicePixelRatio || 1; W = window.innerWidth; H = window.innerHeight; fx.width = W * d; fx.height = H * d; ctx.setTransform(d, 0, 0, d, 0, 0); }
  function piece(x, y, vx, vy){
    return { x: x, y: y, vx: vx, vy: vy, r: Math.random() * 6.3, vr: (Math.random() - 0.5) * 0.3, t: Math.random() * 6.3, vt: 0.05 + Math.random() * 0.12,
      w: 6 + Math.random() * 6, h: 9 + Math.random() * 8, c: COLORS[Math.floor(Math.random() * COLORS.length)], round: Math.random() < 0.25 };
  }
  function frame(){
    ctx.clearRect(0, 0, W, H);
    parts = parts.filter(function(p){
      p.vy = Math.min(p.vy + 0.07, 4.6); p.vx *= 0.985; p.x += p.vx + Math.sin(p.t) * 0.7; p.y += p.vy; p.r += p.vr; p.t += p.vt;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.scale(Math.cos(p.t), 1); ctx.fillStyle = p.c;
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.w / 2.2, 0, 6.3); ctx.fill(); } else { ctx.fillRect(-p.w / 2, -p.h / 3, p.w, p.h * 0.66); }
      ctx.restore();
      return p.y < H + 40;
    });
    if (parts.length) { raf = window.requestAnimationFrame(frame); } else { raf = 0; fx.hidden = true; }
  }
  function start(){ fx.hidden = false; size(); if (!raf) raf = window.requestAnimationFrame(frame); }
  function rain(){
    if (calm || !ctx) return;
    start();
    for (var i = 0; i < 170; i++) parts.push(piece(Math.random() * W, -20 - Math.random() * H * 0.9, (Math.random() - 0.5) * 1.4, 2 + Math.random() * 3));
  }
  function burst(el){
    if (calm || !ctx) return;
    start();
    var b = el.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    for (var i = 0; i < 120; i++) { var a = Math.random() * 6.3, s = 3 + Math.random() * 7; parts.push(piece(cx, cy, Math.cos(a) * s, Math.sin(a) * s - 3.5)); }
  }
  window.addEventListener('resize', function(){ if (raf) size(); });
  window.gwScene = { rain: rain, burst: burst };
})();
`;
