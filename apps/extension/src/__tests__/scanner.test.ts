/**
 * @jest-environment jsdom
 */

import { PageScanner, scanElement, scanPage } from '../content/scanner';
import { applyOverlay } from '../content/overlay';
import { SensitiveElementType } from '@veilbrowse/shared-types';

describe('PageScanner & Dynamic DOM Refinements (Phase 2)', () => {
  let scanner: PageScanner;

  beforeEach(() => {
    // Reset body
    document.body.innerHTML = `
      <div id="app">
        <header>
          <a href="#home" id="link-home">Home</a>
        </header>
        <main id="main-content">
          <label for="username">Username</label>
          <input type="text" id="username" name="username" value="initial_user" />
        </main>
      </div>
    `;

    // Ensure requestAnimationFrame is available and testable in jsdom
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      return setTimeout(() => cb(Date.now()), 0) as unknown as number;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      clearTimeout(id);
    });
  });

  afterEach(() => {
    scanner?.stop();
    jest.restoreAllMocks();
  });

  const waitForRaf = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 20));

  test('A. Dynamic Insertion: newly added elements are discovered', async () => {
    const updateSpy = jest.fn();
    scanner = new PageScanner(updateSpy);
    scanner.start();

    // Initial scan should have link and username input
    expect(scanner.getElements().size).toBe(2);

    // Dynamically insert a button
    const newBtn = document.createElement('button');
    newBtn.id = 'dynamic-btn';
    newBtn.textContent = 'Notification Settings';
    document.getElementById('main-content')!.appendChild(newBtn);

    await waitForRaf();

    // Verify discovered
    const elements = scanner.getElements();
    expect(elements.size).toBe(3);

    const scannedBtn = [...elements.values()].find((e) => e.tagName === 'button');
    expect(scannedBtn).toBeDefined();
    expect(scannedBtn?.accessibleLabel).toBe('Notification Settings');
    expect(scannedBtn?.interactable).toBe(true);
    expect(updateSpy).toHaveBeenCalled();
  });

  test('B. Dynamic Removal: removed subtrees are pruned from representation', async () => {
    const updateSpy = jest.fn();
    scanner = new PageScanner(updateSpy);
    scanner.start();

    expect(scanner.getElements().size).toBe(2);

    // Remove the username input
    const inputEl = document.getElementById('username')!;
    inputEl.remove();

    await waitForRaf();

    // Should only have the link left
    const elements = scanner.getElements();
    expect(elements.size).toBe(1);
    expect([...elements.values()][0].tagName).toBe('a');
  });

  test('C. Stable ID: same DOM Element object retains its elementId', () => {
    const testInput = document.createElement('input');
    testInput.setAttribute('type', 'email');
    testInput.setAttribute('name', 'user_email');
    document.body.appendChild(testInput);

    const firstScan = scanElement(testInput);
    expect(firstScan).not.toBeNull();
    const assignedId = firstScan!.elementId;

    // Scan the exact same Element instance again
    const secondScan = scanElement(testInput);
    expect(secondScan).not.toBeNull();
    expect(secondScan!.elementId).toBe(assignedId);

    // Verify third scan also preserves ID
    const thirdScan = scanElement(testInput);
    expect(thirdScan!.elementId).toBe(assignedId);
  });

  test('D. New Element: genuinely new DOM nodes receive distinct IDs', () => {
    const el1 = document.createElement('button');
    el1.textContent = 'Button 1';
    document.body.appendChild(el1);

    const el2 = document.createElement('button');
    el2.textContent = 'Button 2';
    document.body.appendChild(el2);

    const scan1 = scanElement(el1);
    const scan2 = scanElement(el2);

    expect(scan1).not.toBeNull();
    expect(scan2).not.toBeNull();
    expect(scan1!.elementId).not.toBe(scan2!.elementId);
  });

  test('E. Mutation Batching: multiple DOM operations collapse into one scheduled frame', async () => {
    const updateSpy = jest.fn();
    scanner = new PageScanner(updateSpy);
    scanner.start();

    // Clear initial scan invocation
    updateSpy.mockClear();

    // Perform multiple rapid DOM mutations in the same event loop
    const main = document.getElementById('main-content')!;
    for (let i = 0; i < 5; i++) {
      const btn = document.createElement('button');
      btn.id = `rapid-btn-${i}`;
      btn.textContent = `Action ${i}`;
      main.appendChild(btn);
    }

    // Immediately after synchronous mutations, rAF has not fired yet
    expect(updateSpy).not.toHaveBeenCalled();

    // Wait for batched rAF to execute
    await waitForRaf();

    // Should have flushed exactly once for the batch of 5 mutations
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(scanner.getElements().size).toBe(2 + 5);
  });

  test('F. Overlay Protection: applying overlay does not trigger scanner recursion or loops', async () => {
    const updateSpy = jest.fn();
    scanner = new PageScanner(updateSpy);
    scanner.start();

    updateSpy.mockClear();

    // Apply overlay to current elements (injects #veilbrowse-badges and badges into DOM)
    applyOverlay([...scanner.getElements().values()]);

    await waitForRaf();

    // Applying the overlay should NOT cause the scanner to detect badges as page content
    // Nor should it trigger an infinite update loop
    const elements = scanner.getElements();
    for (const el of elements.values()) {
      expect(el.elementId).not.toContain('veilbrowse');
      expect(el.tagName).not.toBe('span'); // Badges are spans with vb-badge
    }

    // MutationObserver should have ignored the VeilBrowse-internal nodes
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test('G. Open Shadow DOM: traverses open shadow roots and tags elements', async () => {
    // Create host element with open shadow root
    const host = document.createElement('div');
    host.id = 'shadow-host';
    const shadowRoot = host.attachShadow({ mode: 'open' });

    const shadowInput = document.createElement('input');
    shadowInput.type = 'password';
    shadowInput.id = 'shadow-pass';
    shadowInput.placeholder = 'Shadow Secret';
    shadowRoot.appendChild(shadowInput);

    document.getElementById('main-content')!.appendChild(host);

    const scanResult = scanPage();

    const scannedShadowInput = scanResult.elements.find(
      (e) => e.accessibleLabel === 'Shadow Secret'
    );

    expect(scannedShadowInput).toBeDefined();
    expect(scannedShadowInput?.sensitivity.type).toBe(SensitiveElementType.PASSWORD);
    expect(scannedShadowInput?.inShadowRoot).toBe(true);
  });

  test('H. Closed Shadow DOM: limitation verified (closed shadow root is not accessible)', () => {
    const host = document.createElement('div');
    host.id = 'closed-host';
    host.attachShadow({ mode: 'closed' });

    document.body.appendChild(host);

    // In accordance with browser security specifications, closed shadowRoot is null
    expect(host.shadowRoot).toBeNull();

    // Scanner does not attempt or claim closed shadow root penetration
    const result = scanPage();
    const shadowElements = result.elements.filter((e) => e.inShadowRoot);
    expect(shadowElements).toHaveLength(0);
  });

  test('I. Privacy Invariant on Dynamic Nodes: dynamic inputs never leak .value', async () => {
    scanner = new PageScanner();
    scanner.start();

    const secretPassword = 'MyDynamicSecretPassword!999';
    const dynamicInput = document.createElement('input');
    dynamicInput.type = 'password';
    dynamicInput.id = 'dynamic-secret';
    dynamicInput.value = secretPassword;
    document.getElementById('main-content')!.appendChild(dynamicInput);

    await waitForRaf();

    const scanResult = scanner.buildScanResult();
    const serialized = JSON.stringify(scanResult);

    // The secret value must never be present in the serialized scan result
    expect(serialized).not.toContain(secretPassword);

    // Verify runtime object does not have .value
    const found = [...scanner.getElements().values()].find(
      (e) => e.sensitivity.type === SensitiveElementType.PASSWORD
    );
    expect(found).toBeDefined();
    expect(found).not.toHaveProperty('value');
  });

  test('J. Documented Limitation: Attribute-only mutations are not observed without childList changes', async () => {
    const updateSpy = jest.fn();
    scanner = new PageScanner(updateSpy);
    scanner.start();

    updateSpy.mockClear();

    const usernameInput = document.getElementById('username') as HTMLInputElement;

    // Mutate attribute directly without DOM node insertion/removal
    usernameInput.setAttribute('type', 'password');

    await waitForRaf();

    // As documented in Phase 2 architectural constraints, childList observer does not fire on attribute mutations
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
