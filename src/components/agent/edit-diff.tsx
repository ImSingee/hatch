/** Compact, line-oriented rendering for an `edit_file` display diff. */
import { useI18n } from '~i18n';
import classes from './chat.module.css';

function lineClass(line: string): string {
  if (line.startsWith('+')) return classes.editDiffAdded;
  if (line.startsWith('-')) return classes.editDiffRemoved;
  return classes.editDiffContext;
}

export function EditDiff({ diff }: { diff: string }) {
  const { t } = useI18n();
  return (
    <section
      className={classes.editDiff}
      aria-label={t('agent.editDiff.label')}
    >
      {diff.split('\n').map((line, index) => (
        <span key={index} className={lineClass(line)}>
          {line.replaceAll('\t', '   ')}
        </span>
      ))}
    </section>
  );
}
