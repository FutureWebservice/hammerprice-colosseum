'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { videoFeatureOn } from '@/lib/streaming/client-flag';
import './video.css';

/** The wizard's optional live video checkbox, off by default. Renders nothing while the feature is off in this deployment. */
export default function VideoOptionField(props: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  return videoFeatureOn() ? <Field {...props} /> : null;
}

function Field({ enabled, onChange }: { enabled: boolean; onChange: (enabled: boolean) => void }) {
  const t = useTranslations('video');
  return (
    <div className="sl-field" data-testid="video-option">
      <label className="vd-check">
        <input type="checkbox" checked={enabled} data-testid="video-enabled" onChange={(e) => onChange(e.target.checked)} />
        <span>{t('option.label')}</span>
      </label>
      <small className="sl-hint">{t('option.hint')}</small>
      {enabled && <small className="sl-hint" data-testid="video-ip-note">{t('option.ipNote')}</small>}
    </div>
  );
}
