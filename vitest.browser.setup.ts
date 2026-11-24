import '@vitest/browser/matchers';
import 'vitest-browser-react';
import './src/styles.css';
import { i18n } from './src/i18n';

// Component tests assert the English copy whatever the host's language.
await i18n.changeLanguage('en');
