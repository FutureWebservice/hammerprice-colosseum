import React from 'react';
import type { ShowStatus } from '@/contracts/common';
import BroadcastSwitch from '@/components/streaming/BroadcastSwitch';

/**
 * The video switch and the link to the broadcast page in the show manager (owner: VIDEO, FEATURE_VIDEO). Mounted by Manage.tsx next to the
 * show actions. It renders nothing while the feature is off in this deployment; the switch itself lives with the video components.
 */
export interface BroadcastLinkProps {
  showId: string;
  /** `show.video.enabled`. */
  videoEnabled: boolean;
  status: ShowStatus;
}

export default function BroadcastLink(props: BroadcastLinkProps) {
  return <BroadcastSwitch {...props} />;
}
