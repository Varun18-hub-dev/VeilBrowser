import { SensitiveElementType } from '@veilbrowse/shared-types';
import type { ElementAttributes } from '../apps/extension/src/content/classifier';
import type { OcrToken } from '../apps/extension/src/content/visual-scanner';

export interface LabeledTestCase {
  id: string;
  expectedCategory: SensitiveElementType;
  isSensitive: boolean;
  attributes: ElementAttributes;
  syntheticSecret?: string;
  description: string;
}

export interface LabeledVisualTestCase {
  id: string;
  expectedCategory: SensitiveElementType;
  token: OcrToken;
  syntheticSecret: string;
  description: string;
}

export const DOM_BENCHMARK_DATASET: LabeledTestCase[] = [
  // PASSWORD
  {
    id: 'tc-pwd-1',
    expectedCategory: SensitiveElementType.PASSWORD,
    isSensitive: true,
    attributes: { tagName: 'input', type: 'password', name: 'user_password', placeholder: 'Enter password' },
    syntheticSecret: 'UltraSecretPassword#2026',
    description: 'Standard password input',
  },
  {
    id: 'tc-pwd-2',
    expectedCategory: SensitiveElementType.PASSWORD,
    isSensitive: true,
    attributes: { tagName: 'input', type: 'text', name: 'passcode', labelText: 'Security Passcode' },
    syntheticSecret: '984721',
    description: 'Passcode field with type text',
  },

  // EMAIL
  {
    id: 'tc-email-1',
    expectedCategory: SensitiveElementType.EMAIL,
    isSensitive: true,
    attributes: { tagName: 'input', type: 'email', name: 'user_email', autocomplete: 'email' },
    syntheticSecret: 'benchmark.subject@privacytest.org',
    description: 'HTML5 email field',
  },
  {
    id: 'tc-email-2',
    expectedCategory: SensitiveElementType.EMAIL,
    isSensitive: true,
    attributes: { tagName: 'input', type: 'text', name: 'user_mail', placeholder: 'username@company.com' },
    syntheticSecret: 'corporate.exec@enterprise.internal',
    description: 'Text input with email placeholder',
  },

  // PHONE
  {
    id: 'tc-phone-1',
    expectedCategory: SensitiveElementType.PHONE,
    isSensitive: true,
    attributes: { tagName: 'input', type: 'tel', name: 'mobile_number', autocomplete: 'tel' },
    syntheticSecret: '+1-415-555-0199',
    description: 'HTML5 tel field',
  },
  {
    id: 'tc-phone-2',
    expectedCategory: SensitiveElementType.PHONE,
    isSensitive: true,
    attributes: { tagName: 'input', type: 'text', name: 'contact-number', labelText: 'Mobile Phone' },
    syntheticSecret: '+44 7700 900077',
    description: 'Text input with contact-number name and phone label',
  },

  // IDENTITY
  {
    id: 'tc-id-1',
    expectedCategory: SensitiveElementType.IDENTITY,
    isSensitive: true,
    attributes: { tagName: 'input', type: 'text', name: 'ssn', labelText: 'Social Security Number' },
    syntheticSecret: '123-45-6789',
    description: 'SSN identity field',
  },
  {
    id: 'tc-id-2',
    expectedCategory: SensitiveElementType.IDENTITY,
    isSensitive: true,
    attributes: { tagName: 'input', type: 'text', name: 'govt_id', contextHeading: 'Identity Verification' },
    syntheticSecret: 'ID-V-99887766',
    description: 'Government ID with contextual heading',
  },

  // ADDRESS
  {
    id: 'tc-addr-1',
    expectedCategory: SensitiveElementType.ADDRESS,
    isSensitive: true,
    attributes: { tagName: 'input', type: 'text', name: 'billingAddress', autocomplete: 'street-address' },
    syntheticSecret: '123 Test Avenue, Suite 400',
    description: 'Street address field',
  },
  {
    id: 'tc-addr-2',
    expectedCategory: SensitiveElementType.ADDRESS,
    isSensitive: true,
    attributes: { tagName: 'input', type: 'text', name: 'zip_code', labelText: 'Postal Zip Code' },
    syntheticSecret: '94107-1234',
    description: 'Postal code field',
  },

  // PAYMENT
  {
    id: 'tc-pay-1',
    expectedCategory: SensitiveElementType.PAYMENT,
    isSensitive: true,
    attributes: { tagName: 'input', type: 'text', name: 'card-number', autocomplete: 'cc-number' },
    syntheticSecret: '4111-2222-3333-4444',
    description: 'Credit card number field',
  },
  {
    id: 'tc-pay-2',
    expectedCategory: SensitiveElementType.PAYMENT,
    isSensitive: true,
    attributes: { tagName: 'input', type: 'password', name: 'cvv', placeholder: 'CVC / Security code' },
    syntheticSecret: '884',
    description: 'CVV security code field',
  },

  // AMBIGUOUS / UNKNOWN (Fail-closed)
  {
    id: 'tc-unk-1',
    expectedCategory: SensitiveElementType.UNKNOWN,
    isSensitive: true,
    attributes: { tagName: 'input', type: 'text', placeholder: 'suite' },
    syntheticSecret: 'Suite-B-Floor-3',
    description: 'Ambiguous single weak keyword',
  },

  // SAFE CONTROLS (NONE)
  {
    id: 'tc-safe-1',
    expectedCategory: SensitiveElementType.NONE,
    isSensitive: false,
    attributes: { tagName: 'input', type: 'search', name: 'q', placeholder: 'Search products...' },
    description: 'Search input',
  },
  {
    id: 'tc-safe-2',
    expectedCategory: SensitiveElementType.NONE,
    isSensitive: false,
    attributes: { tagName: 'textarea', name: 'user_feedback', placeholder: 'Leave public comment' },
    description: 'Public comments field',
  },
  {
    id: 'tc-safe-3',
    expectedCategory: SensitiveElementType.NONE,
    isSensitive: false,
    attributes: { tagName: 'input', type: 'number', name: 'quantity', placeholder: '1' },
    description: 'Product quantity input',
  },
  {
    id: 'tc-safe-4',
    expectedCategory: SensitiveElementType.NONE,
    isSensitive: false,
    attributes: { tagName: 'button', labelText: 'Enable Notifications' },
    description: 'Safe notification button',
  },
  {
    id: 'tc-safe-5',
    expectedCategory: SensitiveElementType.NONE,
    isSensitive: false,
    attributes: { tagName: 'a', labelText: 'Return to Dashboard' },
    description: 'Safe navigation link',
  },
];

export const VISUAL_BENCHMARK_DATASET: LabeledVisualTestCase[] = [
  {
    id: 'tc-vis-email',
    expectedCategory: SensitiveElementType.EMAIL,
    token: { text: 'support.lead@securecorp.com', bbox: { x: 50, y: 100, width: 250, height: 30 } },
    syntheticSecret: 'support.lead@securecorp.com',
    description: 'Visual email banner',
  },
  {
    id: 'tc-vis-card',
    expectedCategory: SensitiveElementType.PAYMENT,
    token: { text: '4111 8888 9999 1111', bbox: { x: 50, y: 200, width: 280, height: 30 } },
    syntheticSecret: '4111 8888 9999 1111',
    description: 'Visual credit card on receipt',
  },
  {
    id: 'tc-vis-phone',
    expectedCategory: SensitiveElementType.PHONE,
    token: { text: '+1 (555) 987-6543', bbox: { x: 50, y: 300, width: 220, height: 30 } },
    syntheticSecret: '+1 (555) 987-6543',
    description: 'Visual phone number',
  },
  {
    id: 'tc-vis-ssn',
    expectedCategory: SensitiveElementType.IDENTITY,
    token: { text: 'SSN: 987-65-4321', bbox: { x: 50, y: 400, width: 240, height: 30 } },
    syntheticSecret: '987-65-4321',
    description: 'Visual SSN line',
  },
  {
    id: 'tc-vis-safe',
    expectedCategory: SensitiveElementType.NONE,
    token: { text: 'Welcome to System Settings. Click to proceed.', bbox: { x: 50, y: 500, width: 400, height: 30 } },
    syntheticSecret: '',
    description: 'Visual safe instruction text',
  },
];
