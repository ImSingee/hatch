/**
 * A notification's card: its status pill and its one block, shown in the
 * timeline and on the notification's detail page.
 */
import type { NotificationCard } from '../../../packages/hatch-platform-api/notification-card';
import classes from './notification-card-view.module.css';

/** The card's status: a tinted pill with a dot, its tone also in words. */
export function CardStatus({ card }: { card: NotificationCard }) {
  const status = card.status;
  if (!status) return null;
  return (
    <span className={classes.status} data-tone={status.tone}>
      <span className={classes.statusDot} aria-hidden />
      {status.label}
    </span>
  );
}

/** The card's one block: progress, a few figures, or a quoted comment. */
export function CardBlock({ card }: { card: NotificationCard }) {
  const block = card.block;
  if (!block) return null;
  switch (block.type) {
    case 'progress':
      return (
        <div className={classes.progress}>
          <div className={classes.progressHead}>
            <span>{block.label}</span>
            {block.value ? (
              <span className={classes.progressValue}>{block.value}</span>
            ) : null}
          </div>
          <progress
            className={classes.progressTrack}
            aria-label={block.label}
            aria-valuetext={block.value}
            value={block.percent}
            max={100}
            data-tone={card.status?.tone ?? 'neutral'}
          />
        </div>
      );
    case 'stats':
      return (
        <dl className={classes.stats}>
          {block.items.map((stat, index) => (
            // Figures have no ids; their order is their identity.
            // eslint-disable-next-line react/no-array-index-key
            <div key={index} className={classes.stat}>
              <dd className={classes.statValue}>{stat.value}</dd>
              <dt className={classes.statLabel}>{stat.label}</dt>
            </div>
          ))}
        </dl>
      );
    case 'quote':
      return (
        <blockquote className={classes.quote}>
          <span className={classes.quoteMeta}>
            <span className={classes.quoteAuthor}>{block.author}</span>
            {block.location ? (
              <span className={classes.quoteLocation}>{block.location}</span>
            ) : null}
          </span>
          <span className={classes.quoteText}>{block.text}</span>
        </blockquote>
      );
  }
}
