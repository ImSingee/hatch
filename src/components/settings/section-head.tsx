import type { ReactNode } from 'react';
import { PageHeading } from '~components/page/page';

/** The heading of a settings section: what it is and its main action. */
export function SectionHead({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <PageHeading title={title} description={description} actions={action} />
  );
}
