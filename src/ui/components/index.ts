/**
 * Module: ui/components
 * Purpose: Reusable Material Design 3 components — media cards, buttons, progress,
 *          icons, status views (PROJECT_BIBLE.md §11.6–§11.12).
 * Responsibilities: Accessible, theme-aware primitives consuming ui/design-system
 *          exclusively. They hold no domain state and no hard-coded copy: every
 *          string arrives as a prop (§8.7, §19.1).
 * Restrictions: UI layer — no platform/ or runtime/ imports (§8.4).
 * Public API: Button, IconButton, Icon, ProgressBar, StatusView, MediaCard.
 */
export {
  Button,
  IconButton,
  type ButtonProps,
  type ButtonVariant,
  type IconButtonProps,
} from './button';
export { Icon, type IconName, type IconProps } from './icons';
export { ProgressBar, type ProgressBarProps } from './progress-bar';
export { StatusView, type StatusKind, type StatusViewProps } from './status-view';
export { MediaCard, type MediaCardLabels, type MediaCardProps } from './media-card';
