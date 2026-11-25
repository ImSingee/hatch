import type { AppCompatibility } from '~/app-compatibility';
import { CompatibilityNotice } from '~components/deployments/compatibility-notice';

export function AppCompatibilityNotice({
  compatibility,
}: {
  compatibility: AppCompatibility | null;
}) {
  return <CompatibilityNotice compatibility={compatibility} />;
}
