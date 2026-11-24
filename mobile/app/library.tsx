import { useLocalSearchParams } from 'expo-router';
import { ResourcesScreen } from '../src/screens/resources';
import { AgentScreen } from '../src/screens/agent';
import { DashboardScreen } from '../src/screens/dashboard';
import { HomeScreen } from '../src/screens/home';

// Hidden tabs stay reachable from Me through this pushed screen; `widgets`
// is the full-height page behind the home screen's widget sheet.
export default function Library() {
  const { kind } = useLocalSearchParams<{ kind?: string }>();
  return kind === 'dashboard' ? (
    <HomeScreen nested />
  ) : kind === 'widgets' ? (
    <DashboardScreen nested />
  ) : kind === 'agent' ? (
    <AgentScreen nested />
  ) : (
    <ResourcesScreen nested />
  );
}
