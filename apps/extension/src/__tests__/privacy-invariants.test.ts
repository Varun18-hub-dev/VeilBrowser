/**
 * @jest-environment jsdom
 */

import { scanElement, scanPage } from '../content/scanner';
import type { DomScanResultMessage } from '@veilbrowse/shared-types';

describe('VeilBrowse Privacy Invariant Tests', () => {
  const SYNTHETIC_VALUES = {
    email: 'ajay.mehra@example.com',
    phone: '+91 98765 43210',
    accountId: 'VB-7729-AJAY-001',
    address: '12/B Lotus Lane, Bandra West, Mumbai 400050',
    password: 'SuperSecretP@ssw0rd!123',
    fullName: 'Ajay Mehra',
  };

  beforeEach(() => {
    // Construct realistic DOM tree matching the demo page
    document.body.innerHTML = `
      <nav>
        <a href="#dashboard" id="nav-dash">Dashboard</a>
      </nav>
      <form id="test-form">
        <label for="name-input">Full Name</label>
        <input type="text" id="name-input" name="fullname" value="${SYNTHETIC_VALUES.fullName}" autocomplete="name" />

        <label for="email-input">Email Address</label>
        <input type="email" id="email-input" name="email" value="${SYNTHETIC_VALUES.email}" autocomplete="email" />

        <label for="phone-input">Phone Number</label>
        <input type="tel" id="phone-input" name="phone" value="${SYNTHETIC_VALUES.phone}" autocomplete="tel" />

        <label for="account-input">Account Identifier</label>
        <input type="text" id="account-input" name="account_number" value="${SYNTHETIC_VALUES.accountId}" />

        <label for="address-input">Mailing Address</label>
        <input type="text" id="address-input" name="address" value="${SYNTHETIC_VALUES.address}" autocomplete="street-address" />

        <label for="pwd-input">Password Field</label>
        <input type="password" id="pwd-input" name="password" value="${SYNTHETIC_VALUES.password}" autocomplete="current-password" />

        <input type="checkbox" id="notif-toggle" name="notifications" />
        <label for="notif-toggle">Enable Notifications</label>

        <button type="button" id="submit-btn">Save Preferences</button>
      </form>
    `;
  });

  test('INVARIANT 1: ScannedElement runtime object contains NO "value" property', () => {
    const emailInput = document.getElementById('email-input') as HTMLInputElement;
    expect(emailInput.value).toBe(SYNTHETIC_VALUES.email);

    const scanned = scanElement(emailInput);
    expect(scanned).not.toBeNull();

    // Verify runtime keys of ScannedElement
    expect(scanned).not.toHaveProperty('value');
    expect((scanned as unknown as Record<string, unknown>).value).toBeUndefined();
  });

  test('INVARIANT 2: accessibleLabel captures the semantic LABEL text, NEVER the input value', () => {
    const emailInput = document.getElementById('email-input') as HTMLInputElement;
    const scanned = scanElement(emailInput);

    expect(scanned).not.toBeNull();
    expect(scanned!.accessibleLabel).toBe('Email Address');
    expect(scanned!.accessibleLabel).not.toContain(SYNTHETIC_VALUES.email);
  });

  test('INVARIANT 3: Serialized ScannedElement does not leak synthetic secret values', () => {
    const pwdInput = document.getElementById('pwd-input') as HTMLInputElement;
    expect(pwdInput.value).toBe(SYNTHETIC_VALUES.password);

    const scanned = scanElement(pwdInput);
    expect(scanned).not.toBeNull();

    const serialized = JSON.stringify(scanned);

    // Classification type name "password" is valid and expected
    expect(serialized).toContain('"type":"password"');

    // The secret string itself must never appear
    expect(serialized).not.toContain(SYNTHETIC_VALUES.password);
  });

  test('INVARIANT 4: Full DomScanResult serialized string contains 0 occurrences of synthetic PII', () => {
    const scanResult = scanPage();

    expect(scanResult.elements.length).toBeGreaterThanOrEqual(7);
    expect(scanResult.summary.sensitive).toBeGreaterThanOrEqual(4);

    const serializedResult = JSON.stringify(scanResult);

    // Verify none of the sensitive values are leaked in the scan result
    expect(serializedResult).not.toContain(SYNTHETIC_VALUES.email);
    expect(serializedResult).not.toContain(SYNTHETIC_VALUES.phone);
    expect(serializedResult).not.toContain(SYNTHETIC_VALUES.accountId);
    expect(serializedResult).not.toContain(SYNTHETIC_VALUES.address);
    expect(serializedResult).not.toContain(SYNTHETIC_VALUES.password);
  });

  test('INVARIANT 5: Complete Message Pipeline (DOM -> scanner -> message -> JSON) leaks NO sensitive values', () => {
    const scanResult = scanPage();

    const message: DomScanResultMessage = {
      type: 'DOM_SCAN_RESULT',
      payload: scanResult,
    };

    const serializedMessage = JSON.stringify(message);

    // Assert that the outbound message to the background service worker is fully sanitized
    expect(serializedMessage).not.toContain(SYNTHETIC_VALUES.email);
    expect(serializedMessage).not.toContain(SYNTHETIC_VALUES.phone);
    expect(serializedMessage).not.toContain(SYNTHETIC_VALUES.accountId);
    expect(serializedMessage).not.toContain(SYNTHETIC_VALUES.address);
    expect(serializedMessage).not.toContain(SYNTHETIC_VALUES.password);
  });

  test('INVARIANT 6: Every scannable DOM element receives a stable data-veil-id', () => {
    scanPage();

    const allInputs = document.querySelectorAll('input, button, a');
    for (const el of allInputs) {
      const veilId = el.getAttribute('data-veil-id');
      expect(veilId).not.toBeNull();
      expect(veilId).toMatch(/^vb-\d+$/);
    }
  });

  test('INVARIANT 7: URL query parameters are stripped from DomScanResult', () => {
    // Simulate URL with query token using pushState
    window.history.pushState({}, '', '/profile?token=secret123&session=xyz');

    const scanResult = scanPage();
    expect(scanResult.pageUrl).toContain('/profile');
    expect(scanResult.pageUrl).not.toContain('secret123');
    expect(scanResult.pageUrl).not.toContain('xyz');
  });
});
