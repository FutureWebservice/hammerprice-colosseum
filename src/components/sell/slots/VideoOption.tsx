import React from 'react';
import VideoOptionField from '@/components/streaming/VideoOptionField';

/**
 * The optional live video checkbox, off by default (owner: VIDEO, FEATURE_VIDEO). Mounted by TimeStep inside "Advanced options". It renders
 * nothing while the feature is off in this deployment; the field itself lives with the video components.
 */
export interface VideoOptionProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

export default function VideoOption(props: VideoOptionProps) {
  return <VideoOptionField {...props} />;
}
