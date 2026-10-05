import React from 'react';
import { StageVideo } from '@/components/streaming/StageVideo';

/**
 * The optional live video above the lot photo (owner: VIDEO, FEATURE_VIDEO). Mounted by Stage.tsx inside the video frame. It renders nothing
 * unless `enabled` (the seller ticked it AND the feature is on here), and even then nothing until somebody is sending; the viewer's click
 * is what connects to the video host (see StageVideo).
 */
export interface StageMediaProps {
  showId: string;
  /** `show.video.enabled` from the live snapshot: the seller ticked it AND the feature is on here. */
  enabled: boolean;
}

export default function StageMedia({ showId, enabled }: StageMediaProps) {
  return enabled ? <StageVideo showId={showId} /> : null;
}
