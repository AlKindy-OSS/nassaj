import React from 'react';

interface Props {
  date: Date;
}

function formatSeparatorDate(date: Date): string {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  const isToday = date.toDateString() === now.toDateString();
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isToday) return 'اليوم';
  if (isYesterday) return 'أمس';

  return date.toLocaleDateString([], {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export default function DateSeparator({ date }: Props) {
  return (
    <div className="flex items-center justify-center my-4 px-3 select-none" role="separator">
      <div className="flex-1 border-t border-border" />
      <time
        dateTime={date.toISOString()}
        className="mx-3 text-xs text-muted-foreground whitespace-nowrap"
        dir="auto"
      >
        {formatSeparatorDate(date)}
      </time>
      <div className="flex-1 border-t border-border" />
    </div>
  );
}
