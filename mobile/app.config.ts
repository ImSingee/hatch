import type { ExpoConfig } from 'expo/config';

// Store/TestFlight builds talk to production APNs; development clients and
// Simulator builds receive sandbox tokens. The app registers its token with
// the matching environment so the instance picks the right APNs host and key.
const apnsEnvironment =
  process.env.EAS_BUILD_PROFILE === 'production' ||
  process.env.HATCH_APNS_ENVIRONMENT === 'production'
    ? 'production'
    : 'sandbox';

// Recalled notifications disappear from Notification Center only when the
// extension may suppress pushes, which needs Apple's approved
// com.apple.developer.usernotifications.filtering entitlement on the team.
// Without it a recall replaces the notification with a silent placeholder.
const notificationFiltering = process.env.HATCH_NOTIFICATION_FILTERING === '1';

// Nunito and JetBrains Mono are linked into the native projects, so text is
// set in them from the first frame. The family names match
// `packages/hatch-design-tokens/tokens.json`. iOS reads the family from each
// file; Android needs every weight declared.
const fontFile = (family: string, face: string) =>
  `./node_modules/@expo-google-fonts/${family}/${face}/${face.replace(/^\d+/, (weight) => `${family === 'nunito' ? 'Nunito' : 'JetBrainsMono'}_${weight}`)}.ttf`;
const nunito = ['500Medium', '600SemiBold', '700Bold', '800ExtraBold'];
const jetBrainsMono = ['400Regular', '500Medium', '700Bold'];
const faces = (family: string, names: string[]) =>
  names.map((face) => ({
    path: fontFile(family, face),
    weight: Number.parseInt(face, 10),
  }));

const config: ExpoConfig = {
  name: 'Hatch',
  slug: 'hatch-mobile',
  owner: 'singee',
  extra: {
    apnsEnvironment,
    notificationFiltering,
    eas: {
      projectId: '2ed99159-8abc-41eb-91a5-c6c754bb4354',
      build: {
        experimental: {
          ios: {
            appExtensions: [
              {
                targetName: 'HatchNotificationService',
                bundleIdentifier: 'app.hatch.mobile.NotificationService',
                entitlements: {
                  'aps-environment':
                    apnsEnvironment === 'production'
                      ? 'production'
                      : 'development',
                  'keychain-access-groups': [
                    '$(AppIdentifierPrefix)app.hatch.mobile.shared',
                  ],
                  ...(notificationFiltering
                    ? {
                        'com.apple.developer.usernotifications.filtering': true,
                      }
                    : {}),
                },
              },
            ],
          },
        },
      },
    },
  },
  version: '0.1.0',
  icon: '../public/logo512.png',
  scheme: 'hatch',
  orientation: 'default',
  // The instance theme sets the appearance at run time
  // (`src/state/instance-theme.tsx`); the device's own setting is not used.
  userInterfaceStyle: 'light',
  ios: {
    buildNumber: '3',
    supportsTablet: true,
    deploymentTarget: '16.4',
    bundleIdentifier: 'app.hatch.mobile',
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      UIViewControllerBasedStatusBarAppearance: true,
    },
  },
  android: { package: 'app.hatch.mobile' },
  plugins: [
    './plugins/with-private-networking.cjs',
    // Hatch's native App runtime (mobile/native) and its pinned NSH SDK.
    './plugins/with-hatch-native-runtime.cjs',
    [
      'expo-font',
      {
        ios: {
          fonts: [
            ...faces('nunito', nunito),
            ...faces('jetbrains-mono', jetBrainsMono),
          ].map((face) => face.path),
        },
        android: {
          fonts: [
            { fontFamily: 'Nunito', fontDefinitions: faces('nunito', nunito) },
            {
              fontFamily: 'JetBrains Mono',
              fontDefinitions: faces('jetbrains-mono', jetBrainsMono),
            },
          ],
        },
      },
    ],
    [
      'expo-notifications',
      {
        mode: apnsEnvironment === 'production' ? 'production' : 'development',
      },
    ],
    './plugins/with-notification-service-extension.cjs',
    'expo-router',
    'expo-secure-store',
    'expo-status-bar',
    'expo-web-browser',
    ['expo-dev-client', { launchMode: 'launcher' }],
    [
      'expo-image-picker',
      {
        photosPermission: 'Choose images to attach to your Hatch conversation.',
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
  ],
  experiments: { typedRoutes: true },
};
export default config;
