import type {
  MouseEvent as ReactMouseEvent,
  TouchEvent as ReactTouchEvent,
} from 'react';
import {
  ChevronLeft,
  ChevronRight,
  GripVertical,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { QuickSettingsHandleStyle } from '../types';

type QuickSettingsHandleProps = {
  isOpen: boolean;
  isDragging: boolean;
  style: QuickSettingsHandleStyle;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onTouchStart: (event: ReactTouchEvent<HTMLButtonElement>) => void;
};

export default function QuickSettingsHandle({
  isOpen,
  isDragging,
  style,
  onClick,
  onMouseDown,
  onTouchStart,
}: QuickSettingsHandleProps) {
  const { t } = useTranslation('settings');

  const placementClass = isOpen ? 'end-64' : 'end-0';
  const borderClass = isDragging
    ? 'border-primary'
    : 'border-border';
  const transitionClass = isDragging
    ? ''
    : 'transition-all duration-150 ease-out';
  const cursorClass = isDragging ? 'cursor-grabbing' : 'cursor-pointer';
  const ariaLabel = isDragging
    ? t('quickSettings.dragHandle.dragging')
    : isOpen
      ? t('quickSettings.dragHandle.closePanel')
      : t('quickSettings.dragHandle.openPanel');
  const title = isDragging
    ? t('quickSettings.dragHandle.draggingStatus')
    : t('quickSettings.dragHandle.toggleAndMove');

  const { transform: baseTransform, ...positionStyle } = style;

  return (
    <div
      className={`fixed ${placementClass} z-50 ${transitionClass} ${!isOpen && !isDragging ? 'ltr:translate-x-[75%] rtl:-translate-x-[75%] ltr:hover:translate-x-0 rtl:hover:translate-x-0' : ''}`}
      style={positionStyle}
    >
      <button
        type="button"
        onClick={onClick}
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
        className={`border bg-card ${borderClass} rounded-s-md p-2 shadow-lg transition-[colors,transform,opacity] hover:bg-accent ${cursorClass} touch-none`}
        style={{
          transform: baseTransform,
          touchAction: 'none',
          WebkitTouchCallout: 'none',
          WebkitUserSelect: 'none',
        }}
        aria-label={ariaLabel}
        title={title}
      >
        {isDragging ? (
          <GripVertical className="h-5 w-5 text-primary" />
        ) : isOpen ? (
          <ChevronRight className="h-5 w-5 text-muted-foreground rtl:rotate-180" />
        ) : (
          <ChevronLeft className="h-5 w-5 text-muted-foreground rtl:rotate-180" />
        )}
      </button>
    </div>
  );
}
