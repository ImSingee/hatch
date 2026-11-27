import { authClient } from '~auth/client';
import { GroupCard } from '~components/page/page';
import { AccentPanel } from './accent-panel';
import { DockLabelsPanel } from './dock-labels-panel';
import { LanguagePanel } from './language-panel';

/**
 * The signed-in user's appearance settings. The user comes from the live
 * session rather than the route loader, so an account switched in another
 * tab shows that account's settings instead of failing on the old one.
 */
export function AppearancePanels() {
  const userId = authClient.useSession().data?.user.id;
  if (!userId) return null;
  return (
    <>
      <GroupCard padded>
        <AccentPanel key={userId} userId={userId} />
      </GroupCard>
      <GroupCard padded>
        <DockLabelsPanel key={userId} userId={userId} />
      </GroupCard>
      <GroupCard padded>
        <LanguagePanel />
      </GroupCard>
    </>
  );
}
