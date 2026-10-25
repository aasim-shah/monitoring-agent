'use client';

import { LumenIcon, type IconName } from '@lumen/icons/react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useEffect, useRef, useState, type RefObject, type KeyboardEvent } from 'react';

export function useLandingMotion(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      const context = gsap.context(() => {
        gsap
          .timeline({ defaults: { duration: 0.7, ease: 'power2.out' } })
          .from('.hero .eyebrow, .hero h1, .hero .intro, .hero .secondary', {
            y: 20,
            opacity: 0,
            stagger: 0.09,
          })
          .from('.demo', { x: 24, opacity: 0, duration: 0.9 }, 0.18)
          .from('.demo .node', { y: 12, opacity: 0, stagger: 0.09 }, 0.55);
        gsap.from('.journey-card', {
          scrollTrigger: { trigger: '.journey-grid', start: 'top 90%', once: true },
          y: 24,
          opacity: 0,
          stagger: 0.12,
          duration: 0.7,
        });
        gsap.utils.toArray<HTMLElement>('.evidence-intro, .investigation, .close').forEach((element) => {
          gsap.from(element, {
            scrollTrigger: { trigger: element, start: 'top 92%', once: true },
            y: 20,
            opacity: 0,
            duration: 0.7,
          });
        });
      }, root);
      return () => context.revert();
    });
    return () => media.revert();
  }, [root]);
}

function switchTab(event: KeyboardEvent<HTMLButtonElement>, index: number, set: (n: number) => void) {
  let next = index;
  if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = (index + 1) % 3;
  else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (index + 2) % 3;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = 2;
  else return;
  event.preventDefault();
  set(next);
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
}

const stages = [
  {
    key: 'connect',
    tab: '01 Connect',
    icon: 'arrow-up-right' as IconName,
    title: 'Context comes together.',
    detail: '5 connected assets. One product workspace.',
    label: 'One connected product',
    caption: 'Your website, app, and infrastructure. Connected in one product workspace.',
  },
  {
    key: 'investigate',
    tab: '02 Investigate',
    icon: 'search' as IconName,
    title: 'A change worth investigating.',
    detail: 'Deployment → API latency → database signals.',
    label: 'Follow the evidence',
    caption: 'A deployment, a slower API, a busier database. Review the evidence together.',
  },
  {
    key: 'review',
    tab: '03 Review',
    icon: 'check' as IconName,
    title: 'A next step. Your decision.',
    detail: 'Review the target and expected effect before approval.',
    label: 'You stay in control',
    caption: 'Review the proposed target and expected effect. You decide whether an action runs.',
  },
];
const nodes: { key: string; label: string; icon: IconName }[] = [
  { key: 'website', label: 'Website', icon: 'globe' },
  { key: 'app', label: 'Mobile app', icon: 'phone' },
  { key: 'api', label: 'Core API', icon: 'grid' },
  { key: 'database', label: 'Database', icon: 'archive' },
  { key: 'server', label: 'Server', icon: 'cloud' },
];

export function ProductDemo() {
  const [stage, setStage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [paths, setPaths] = useState({ width: 800, height: 320, all: '', signal: '' });
  const map = useRef<HTMLDivElement>(null);
  const demo = useRef<HTMLElement>(null);
  const ambient = useRef<gsap.core.Tween[]>([]);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  useEffect(() => {
    const canvas = map.current;
    if (!canvas) return;
    const draw = () => {
      const box = (key: string) => {
        const node = canvas.querySelector<HTMLButtonElement>(`.node.${key}`)!;
        return { x: node.offsetLeft, y: node.offsetTop, w: node.offsetWidth, h: node.offsetHeight };
      };
      const mobile = window.innerWidth <= 700,
        core = box('api');
      const routes = ['website', 'app', 'database', 'server'].map((key, i) => {
        const node = box(key);
        if (mobile) {
          const sx = i < 2 ? node.x + node.w / 2 : core.x + core.w / 2,
            sy = i < 2 ? node.y + node.h : core.y + core.h;
          const ex = i < 2 ? core.x + core.w / 2 : node.x + node.w / 2,
            ey = i < 2 ? core.y : node.y,
            mid = (sy + ey) / 2;
          return `M${sx} ${sy}V${mid - 8}Q${sx} ${mid} ${sx + (ex > sx ? 8 : -8)} ${mid}H${ex + (ex > sx ? -8 : 8)}Q${ex} ${mid} ${ex} ${mid + 8}V${ey}`;
        }
        const sx = i < 2 ? node.x + node.w : core.x + core.w,
          sy = i < 2 ? node.y + node.h / 2 : core.y + core.h / 2;
        const ex = i < 2 ? core.x : node.x,
          ey = i < 2 ? core.y + core.h / 2 : node.y + node.h / 2,
          mid = (sx + ex) / 2;
        return `M${sx} ${sy}H${mid - 12}Q${mid} ${sy} ${mid} ${sy + (ey > sy ? 12 : -12)}V${ey + (ey > sy ? -12 : 12)}Q${mid} ${ey} ${mid + 12} ${ey}H${ex}`;
      });
      setPaths({
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        all: routes.join(' '),
        signal: `${routes[0]} ${routes[2]}`,
      });
    };
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (reduced) return;
    const ctx = gsap.context(() => {
      ambient.current = [
        gsap.to('.signal-path', { strokeDashoffset: -160, duration: 12, repeat: -1, ease: 'none' }),
        gsap.to('.blend-orb', { x: 24, y: 20, duration: 6, repeat: -1, yoyo: true, ease: 'sine.inOut' }),
      ];
    }, demo);
    return () => {
      ctx.revert();
      ambient.current = [];
    };
  }, [reduced]);
  useEffect(() => {
    ambient.current.forEach((tween) => tween.paused(paused));
  }, [paused, reduced]);
  const current = stages[stage] ?? stages[0]!;
  function choose(index: number) {
    setStage(index);
    setSelected(null);
  }
  return (
    <section
      ref={demo}
      className="demo"
      id="product"
      data-state={current.key}
      aria-label="Interactive product example"
    >
      <div className="blend-orb" aria-hidden="true" />
      <div className="mesh-cool" aria-hidden="true" />
      <div className="demohead">
        <span>
          FireMaps <span className="example">/ Production</span>
        </span>
        <span className="example">Illustrative example</span>
      </div>
      <div className="map" ref={map}>
        <div className="orbital" aria-hidden="true" />
        <svg
          className="paths"
          viewBox={`0 0 ${paths.width} ${paths.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d={paths.all} />
          <path className="signal-path" d={paths.signal} style={{ opacity: stage === 2 ? 0.15 : 0.7 }} />
        </svg>
        {nodes.map((node) => (
          <button
            key={node.key}
            type="button"
            className={`node ${node.key}`}
            aria-label={`Inspect ${node.label}`}
            aria-pressed={selected === node.key || (!selected && stage === 1 && node.key === 'api')}
            onClick={() => setSelected(node.key)}
          >
            <LumenIcon name={node.icon} />
            <span>{node.label}</span>
          </button>
        ))}
        <div className="map-label">
          <i />
          <span>{current.label}</span>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label="Explore the workflow">
        {stages.map((item, i) => (
          <button
            key={item.key}
            id={`workflow-${item.key}`}
            type="button"
            role="tab"
            aria-selected={stage === i}
            aria-controls="workflow-panel"
            tabIndex={stage === i ? 0 : -1}
            onClick={() => choose(i)}
            onKeyDown={(e) => switchTab(e, i, choose)}
          >
            {item.tab}
          </button>
        ))}
      </div>
      <div id="workflow-panel" role="tabpanel" aria-labelledby={`workflow-${current.key}`}>
        <div className="state-visual" aria-live="polite">
          <span className="state-icon">
            <LumenIcon name={current.icon} />
          </span>
          <div>
            <strong>{current.title}</strong>
            <p>{current.detail}</p>
          </div>
        </div>
        <p className="caption" aria-live="polite">
          {selected
            ? `${nodes.find((n) => n.key === selected)?.label} is part of your connected product. Select Investigate to follow the evidence.`
            : current.caption}
        </p>
      </div>
      {!reduced && (
        <div style={{ textAlign: 'center' }}>
          <button type="button" className="motion" aria-pressed={paused} onClick={() => setPaused(!paused)}>
            <LumenIcon name={paused ? 'play' : 'pause'} size={12} />
            {paused ? 'Play animation' : 'Pause animation'}
          </button>
        </div>
      )}
    </section>
  );
}

const evidence = [
  {
    label: 'New deployment',
    source: 'GitHub',
    time: '14:02',
    pill: 'GitHub deployment',
    title: 'A change before the slowdown.',
    body: 'A deployment preceded the latency increase. Compare it with the service and database signals.',
    note: 'Timing is a clue, not a confirmed cause.',
    path: 'M0 61H85L100 60L130 59L150 52L170 25L190 29L210 16L235 23L260 20L280 25H300',
    chart: 'Illustrative deployment marker preceding a rise in latency',
  },
  {
    label: 'Latency increased',
    source: 'Prometheus',
    time: '14:05',
    pill: 'Prometheus metrics',
    title: 'The API started responding slower.',
    body: 'Latency rose after the deployment. The metric shows a symptom; it does not explain the cause.',
    note: 'Compare with deployments and database health.',
    path: 'M0 65L30 63L55 65L80 62L110 61L140 54L160 40L180 21L200 28L230 13L250 21L280 17L300 22',
    chart: 'Illustrative API latency trend increasing over time',
  },
  {
    label: 'Connections rose',
    source: 'Database health',
    time: '14:07',
    pill: 'Database health',
    title: 'Connections increased in the same window.',
    body: 'Database connections rose alongside API latency. Investigate whether both reflect the same underlying change.',
    note: 'A shared time window does not establish causation.',
    path: 'M0 65H55V59H95V48H135V35H185V23H240V17H300',
    chart: 'Illustrative database connection trend increasing in steps',
  },
];
export function EvidencePanel() {
  const [selected, setSelected] = useState(0);
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = matchMedia('(max-width:700px)');
    const sync = () => setMobile(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  const item = evidence[selected] ?? evidence[0]!;
  return (
    <section className="evidence evidence-upgrade">
      <div className="evidence-intro">
        <p className="eyebrow">ANSWERS YOU CAN TRACE</p>
        <h2>
          See the signal.
          <br />
          <span>Understand the context.</span>
        </h2>
        <p>
          A finding is more useful when you can see where it came from. Follow an example investigation, one
          signal at a time.
        </p>
        <div className="evidence-promises">
          <span>↗ Connected sources</span>
          <span>○ Clear uncertainty</span>
        </div>
      </div>
      <div className="investigation">
        <div className="investigation-top">
          <span className="investigation-icon">
            <LumenIcon name="search" size={18} />
          </span>
          <div>
            <span className="panel-label">EXAMPLE INVESTIGATION</span>
            <h3>Why is the API slower?</h3>
          </div>
          <span className="example-badge">Illustrative</span>
        </div>
        <div className="investigation-body">
          <div
            className="signal-list"
            role="tablist"
            aria-label="Inspect the evidence"
            aria-orientation={mobile ? 'horizontal' : 'vertical'}
          >
            {evidence.map((entry, i) => (
              <button
                key={entry.label}
                id={`signal-${i}`}
                type="button"
                role="tab"
                aria-selected={selected === i}
                aria-controls="signal-detail"
                tabIndex={selected === i ? 0 : -1}
                onClick={() => setSelected(i)}
                onKeyDown={(e) => switchTab(e, i, setSelected)}
              >
                <span className="signal-dot" />
                <span className="signal-text">
                  <strong>{entry.label}</strong>
                  <span>
                    {entry.source} · {entry.time}
                  </span>
                </span>
                <span className="signal-arrow" aria-hidden="true">
                  ↗
                </span>
              </button>
            ))}
          </div>
          <div
            className="signal-detail"
            id="signal-detail"
            role="tabpanel"
            aria-labelledby={`signal-${selected}`}
            aria-live="polite"
          >
            <div className="source-pill">{item.pill}</div>
            <h4>{item.title}</h4>
            <div className="chart-context">
              <span>Signal trend</span>
              <span>Illustrative · not to scale</span>
            </div>
            <svg className="signal-chart" viewBox="0 0 300 80" role="img" aria-label={item.chart}>
              <path className="chart-grid" d="M0 20H300M0 60H300" />
              <path className="chart-marker" d="M100 6V76" />
              <path className="chart-line" d={item.path} />
              <circle cx="100" cy="60" r="4" />
            </svg>
            <div className="chart-times">
              <span>14:00</span>
              <span>14:10</span>
            </div>
            <p>{item.body}</p>
            <span className="detail-note">
              <LumenIcon name="info" size={14} />
              {item.note}
            </span>
          </div>
        </div>
        <div className="investigation-bottom">
          <span className="uncertainty-dot" aria-hidden="true">
            ○
          </span>
          <span>These signals overlap. More evidence is needed to establish a cause.</span>
        </div>
      </div>
    </section>
  );
}
