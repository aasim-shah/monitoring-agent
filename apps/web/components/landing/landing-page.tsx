'use client';

import { Button } from '@lumen/react';
import { LumenIcon } from '@lumen/icons/react';
import { useRef } from 'react';
import { LandingHeader } from './landing-header';
import { ProductDemo, EvidencePanel, useLandingMotion } from './landing-visuals';
import './landing.css';

export function LandingPage() {
  const root = useRef<HTMLDivElement>(null);
  useLandingMotion(root);
  return (
    <div ref={root} className="landing" data-brand="orange" data-theme="light">
      <div className="wrap">
        <LandingHeader></LandingHeader>
        <main id="main-content">
          <div className="hero-layout">
            <section className="hero">
              <p className="eyebrow">A little less checking. A lot more clarity.</p>
              <h1>
                Your whole product.
                <br />
                <span>One clear picture.</span>
              </h1>
              <p className="intro">
                Connect your tools. Understand what changed.
                <br />
                Know what needs your attention.
              </p>
              <Button href="/signup" className="cta" size="lg">
                Create your workspace <LumenIcon name="arrow-up-right" />
              </Button>
              <a id="hero-explore" className="secondary" href="#product">
                See how it comes together ↓
              </a>
            </section>
            <ProductDemo></ProductDemo>
          </div>
          <div className="integrations">
            <p>Works with the tools you already use.</p>
            <div className="tools">
              <span>GitHub</span>
              <span>Cloudflare</span>
              <span>Prometheus</span>
              <span>Grafana</span>
              <span>Google</span>
            </div>
          </div>
          <section className="benefits upgraded" id="how">
            <div className="section-heading">
              <div>
                <p className="eyebrow">THE WORKFLOW</p>
                <h2>
                  Less noise.
                  <br />
                  <span>A clearer way forward.</span>
                </h2>
              </div>
              <p>
                From the tools you already use
                <br />
                to the context you need to act.
              </p>
            </div>
            <div className="journey-grid">
              <article className="journey-card">
                <div className="step-top">
                  <span className="step-number">01</span>
                  <span>Connect</span>
                </div>
                <div className="mini-visual mini-connect" aria-label="Services connected to one product">
                  <span className="mini-tool tool-a">Website</span>
                  <span className="mini-tool tool-b">GitHub</span>
                  <span className="mini-tool tool-c">Database</span>
                  <svg viewBox="0 0 300 150" aria-hidden="true">
                    <path d="M80 35H112Q128 35 128 51V59Q128 75 144 75H165 M80 115H112Q128 115 128 99V91Q128 75 144 75H165 M205 75H235" />
                  </svg>
                  <span className="mini-hub">Your product</span>
                  <span className="mini-end">↗</span>
                </div>
                <h3>Bring it together.</h3>
                <p>Your services, dependencies, and product signals. Connected in one workspace.</p>
                <span className="card-foot">Your tools stay. The context connects.</span>
              </article>
              <article className="journey-card">
                <div className="step-top">
                  <span className="step-number">02</span>
                  <span>Understand</span>
                </div>
                <div className="mini-visual mini-understand">
                  <div className="mini-query">
                    <span aria-hidden="true">⌕</span> What changed?
                  </div>
                  <div className="mini-finding">
                    <i></i>
                    <span>Deployment</span>
                    <span className="finding-line"></span>
                  </div>
                  <div className="mini-finding">
                    <i></i>
                    <span>API latency</span>
                    <svg viewBox="0 0 70 24" aria-hidden="true">
                      <path d="M0 20H16L23 17L30 18L37 5L45 8L52 4L60 7H70" />
                    </svg>
                  </div>
                  <span className="source-tag">Evidence attached ↗</span>
                </div>
                <h3>Ask what changed.</h3>
                <p>AI brings relevant signals together, with sources behind every finding.</p>
                <span className="card-foot">Cited sources. Visible uncertainty.</span>
              </article>
              <article className="journey-card">
                <div className="step-top">
                  <span className="step-number">03</span>
                  <span>Decide</span>
                </div>
                <div className="mini-visual mini-decide">
                  <div className="approval-mini">
                    <div className="approval-head">
                      <span className="review-ring">✓</span>
                      <span>Proposed next step</span>
                    </div>
                    <strong>Purge selected cache URLs</strong>
                    <div className="approval-bottom">
                      <span>Cloudflare</span>
                      <span className="approval-pill">Review required</span>
                    </div>
                  </div>
                </div>
                <h3>Keep the final say.</h3>
                <p>Review the target and expected effect before a permitted action runs.</p>
                <span className="card-foot">Your approval. A recorded result.</span>
              </article>
            </div>
            <p className="visual-disclaimer">
              Illustrative workflow · Available signals depend on connected sources.
            </p>
          </section>
          <EvidencePanel></EvidencePanel>
          <section className="close">
            <h2>
              Less chasing.
              <br />
              More understanding.
            </h2>
            <p>Your existing product. A clearer way to run it.</p>
            <a id="closing-start" href="/signup">
              Create your workspace ↗
            </a>
          </section>
        </main>
        <footer>
          <span>Product Control Plane</span>
          <span>Your tools. Your context. Your control.</span>
        </footer>
      </div>
    </div>
  );
}
