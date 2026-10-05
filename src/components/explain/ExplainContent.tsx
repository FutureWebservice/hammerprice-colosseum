'use client';

/**
 * The concept, in pictures, then a short FAQ - shared between the modal (ExplainBubble) and
 * the /about page (How it works section) so the two surfaces never drift apart. State-only (which tab, which
 * panel); the copy comes from src/locales/{de,en}/explain.json via content.ts.
 */
import { useState } from 'react';
import { PANEL_KEYS, FAQ_KEYS, type ExplainMessages } from './content';
import { PANEL_ICONS } from './icons';
import './explain.css';

export default function ExplainContent({ messages }: { messages: ExplainMessages }) {
  const [tab, setTab] = useState<'panels' | 'faq'>('panels');
  const [index, setIndex] = useState(0);

  const key = PANEL_KEYS[index];
  const Icon = PANEL_ICONS[key];
  const panel = messages.panels[key];

  return (
    <div className="ex-content">
      <div className="ex-tabs" role="tablist" aria-label={messages.modal.title}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'panels'}
          className={`ex-tab${tab === 'panels' ? ' is-active' : ''}`}
          onClick={() => setTab('panels')}
        >
          {messages.modal.tabPanels}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'faq'}
          className={`ex-tab${tab === 'faq' ? ' is-active' : ''}`}
          onClick={() => setTab('faq')}
        >
          {messages.modal.tabFaq}
        </button>
      </div>

      {tab === 'panels' ? (
        <div className="ex-panels">
          <div className="ex-panel" key={key}>
            <div className="ex-panel-icon">
              <Icon />
            </div>
            <h3 className="ex-panel-title">{panel.title}</h3>
            <p className="ex-panel-body">{panel.body}</p>
          </div>

          <div className="ex-dots" role="tablist" aria-label={messages.modal.tabPanels}>
            {PANEL_KEYS.map((k, i) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={messages.panels[k].title}
                className={`ex-dot${i === index ? ' is-active' : ''}`}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>

          <div className="ex-panel-nav">
            <button
              type="button"
              className="ex-nav-btn"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={index === 0}
            >
              {messages.modal.prev}
            </button>
            <span className="ex-step">
              {index + 1} / {PANEL_KEYS.length}
            </span>
            <button
              type="button"
              className="ex-nav-btn"
              onClick={() => setIndex((i) => Math.min(PANEL_KEYS.length - 1, i + 1))}
              disabled={index === PANEL_KEYS.length - 1}
            >
              {messages.modal.next}
            </button>
          </div>
        </div>
      ) : (
        <dl className="ex-faq">
          {FAQ_KEYS.map((k) => (
            <div className="ex-faq-item" key={k}>
              <dt>{messages.faq[k].q}</dt>
              <dd>{messages.faq[k].a}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
