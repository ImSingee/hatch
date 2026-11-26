/**
 * The `@hatch/ui` gallery: every component in every variant and state, with
 * invented sample content. It is the library's verification target and the
 * catalogue screenshot suite. `host.params.section` opens a section.
 */
import { host } from 'nsh';
import {
  AppShell,
  IconButton,
  IconLayoutGrid,
  IconTypography,
  IconLayoutSidebar,
  IconMessage,
  IconPencil,
  IconSettings,
  IconTable,
  mount,
} from '@hatch/ui';
import { Basics } from './sections/basics';
import { Data } from './sections/data';
import { Feedback } from './sections/feedback';
import { Inputs } from './sections/inputs';
import { Navigation } from './sections/navigation';
import { Patterns } from './sections/patterns';

function Gallery() {
  const start = host.params.section;
  return (
    <AppShell
      title="UI gallery"
      defaultValue={typeof start === 'string' ? start : undefined}
      sections={[
        {
          id: 'basics',
          label: 'Basics',
          icon: IconTypography,
          content: Basics,
        },
        { id: 'inputs', label: 'Inputs', icon: IconPencil, content: Inputs },
        { id: 'data', label: 'Data', icon: IconTable, content: Data },
        {
          id: 'feedback',
          label: 'Feedback',
          icon: IconMessage,
          content: Feedback,
        },
        {
          id: 'navigation',
          label: 'Navigation',
          icon: IconLayoutSidebar,
          content: Navigation,
        },
        {
          id: 'patterns',
          label: 'Patterns',
          icon: IconLayoutGrid,
          content: Patterns,
        },
      ]}
      actions={<IconButton icon={IconSettings} label="Gallery settings" />}
    />
  );
}

mount(Gallery);
