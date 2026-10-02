/**
 * Accessibility Tree Content Script
 *
 * Walks the DOM from document.body to build a compact, LLM-readable
 * accessibility tree. Each visible interactive element gets a unique
 * ref (stored as __chromeuse_ref on the DOM node) that other tools
 * can use to target elements for clicks, form input, etc.
 *
 * Messages handled:
 * - get_accessibility_tree: Build and return the serialized a11y tree
 * - find_by_ref: Find an element by its ref and return bounding rect
 * - set_form_value: Set value on a form element with framework support
 * - clear_refs: Remove all stored refs from DOM nodes
 *
 * Design:
 * - Skips hidden elements (display:none, visibility:hidden, aria-hidden)
 * - Computes roles via explicit aria-role or implicit tag mapping
 * - Computes names via aria-label > aria-labelledby > title > alt > text content
 * - Captures value for form elements (input, textarea, select)
 * - Captures state (expanded, selected, checked, focused, disabled, required, readonly)
 * - Output is a compact indented text format optimized for LLM readability
 */

// --- Types ---

interface A11yNode {
  role: string;
  name: string;
  ref: string;
  value?: string;
  state?: string[];
  children?: A11yNode[];
}

// --- Ref Counter (reset per tree generation) ---

let refCounter = 0;

/** Property name used to store refs on DOM elements */
const REF_PROP = '__chromeuse_ref';

// --- Implicit Role Mapping ---

/**
 * Maps HTML tag names to their implicit ARIA role.
 * Covers the most common interactive and landmark elements.
 * See: https://www.w3.org/TR/html-aria/#docconformance
 */
const TAG_ROLE_MAP: Readonly<Record<string, string>> = {
  A: 'link',
  ARTICLE: 'article',
  ASIDE: 'complementary',
  BUTTON: 'button',
  DATALIST: 'listbox',
  DETAILS: 'group',
  DIALOG: 'dialog',
  FIELDSET: 'group',
  FIGURE: 'figure',
  FOOTER: 'contentinfo',
  FORM: 'form',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
  HEADER: 'banner',
  HR: 'separator',
  IMG: 'img',
  INPUT: 'textbox', // default; refined by getInputRole()
  LI: 'listitem',
  MAIN: 'main',
  MENU: 'list',
  NAV: 'navigation',
  OL: 'list',
  OPTGROUP: 'group',
  OPTION: 'option',
  OUTPUT: 'status',
  PROGRESS: 'progressbar',
  SEARCH: 'search',
  SECTION: 'region',
  SELECT: 'combobox',
  SUMMARY: 'button',
  TABLE: 'table',
  TBODY: 'rowgroup',
  TD: 'cell',
  TEXTAREA: 'textbox',
  TFOOT: 'rowgroup',
  TH: 'columnheader',
  THEAD: 'rowgroup',
  TR: 'row',
  UL: 'list',
};

/**
 * Refine role for <input> based on its type attribute.
 */
function getInputRole(el: HTMLInputElement): string {
  switch (el.type) {
    case 'button':
    case 'submit':
    case 'reset':
    case 'image':
      return 'button';
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'range':
      return 'slider';
    case 'number':
      return 'spinbutton';
    case 'search':
      return 'searchbox';
    case 'email':
    case 'tel':
    case 'url':
    case 'text':
    case 'password':
    default:
      return 'textbox';
    case 'hidden':
      return 'none';
  }
}

// --- Visibility ---

/**
 * Check if an element is visible and should be included in the tree.
 * Uses a combination of CSS and ARIA checks.
 */
function isVisible(el: Element): boolean {
  // Skip aria-hidden
  if (el.getAttribute('aria-hidden') === 'true') return false;

  // Skip <script>, <style>, <noscript>, <template>, <link>, <meta>
  const tag = el.tagName;
  if (
    tag === 'SCRIPT' ||
    tag === 'STYLE' ||
    tag === 'NOSCRIPT' ||
    tag === 'TEMPLATE' ||
    tag === 'LINK' ||
    tag === 'META'
  ) {
    return false;
  }

  // Check computed styles (expensive, but necessary for accuracy)
  const style = window.getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;

  // Check for zero-size elements (common hidden pattern)
  if (el instanceof HTMLElement) {
    if (el.offsetWidth === 0 && el.offsetHeight === 0) {
      // Exception: elements with overflow:hidden and position:absolute
      // are sometimes used as accessible labels
      if (style.position !== 'absolute' && style.position !== 'fixed') {
        return false;
      }
    }
  }

  return true;
}

// --- Accessible Name Computation ---

/**
 * Compute the accessible name for an element, following a simplified
 * version of the W3C accessible name computation algorithm.
 */
function getAccessibleName(el: Element): string {
  // 1. aria-label takes precedence
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();

  // 2. aria-labelledby references
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts: string[] = [];
    for (const id of labelledBy.split(/\s+/)) {
      const referenced = document.getElementById(id);
      if (referenced) {
        const text = referenced.textContent?.trim();
        if (text) parts.push(text);
      }
    }
    if (parts.length > 0) return parts.join(' ');
  }

  // 3. <label> for form controls
  if (el instanceof HTMLElement && 'labels' in el) {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      const labelText = Array.from(labels)
        .map((l) => l.textContent?.trim())
        .filter(Boolean)
        .join(' ');
      if (labelText) return labelText;
    }
  }

  // 4. title attribute
  const title = el.getAttribute('title');
  if (title?.trim()) return title.trim();

  // 5. alt attribute (for images)
  const alt = el.getAttribute('alt');
  if (alt?.trim()) return alt.trim();

  // 6. placeholder for inputs
  const placeholder = el.getAttribute('placeholder');
  if (placeholder?.trim()) return placeholder.trim();

  // 7. Direct text content (truncated for sanity)
  const textContent = getDirectTextContent(el);
  if (textContent) return textContent;

  return '';
}

/**
 * Get the meaningful text content of an element, excluding text
 * from deeply nested children that have their own semantic meaning.
 * Truncates to keep output compact.
 */
function getDirectTextContent(el: Element): string {
  const MAX_TEXT_LENGTH = 80;

  // For elements that typically contain short text, use innerText
  const tag = el.tagName;
  if (
    tag === 'BUTTON' ||
    tag === 'A' ||
    tag === 'LABEL' ||
    tag === 'SUMMARY' ||
    tag === 'OPTION' ||
    tag === 'TH' ||
    tag === 'TD' ||
    tag === 'H1' ||
    tag === 'H2' ||
    tag === 'H3' ||
    tag === 'H4' ||
    tag === 'H5' ||
    tag === 'H6'
  ) {
    const text = (el as HTMLElement).innerText?.trim();
    if (text) {
      return text.length > MAX_TEXT_LENGTH
        ? text.slice(0, MAX_TEXT_LENGTH) + '...'
        : text;
    }
  }

  // For other elements, only grab direct text nodes
  const parts: string[] = [];
  const childNodes = Array.from(el.childNodes);
  for (let i = 0; i < childNodes.length; i++) {
    const node = childNodes[i];
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) parts.push(text);
    }
  }
  const joined = parts.join(' ');
  if (!joined) return '';
  return joined.length > MAX_TEXT_LENGTH
    ? joined.slice(0, MAX_TEXT_LENGTH) + '...'
    : joined;
}

// --- Role Computation ---

function getRole(el: Element): string {
  // Explicit role attribute takes precedence
  const explicitRole = el.getAttribute('role');
  if (explicitRole) return explicitRole;

  // Refine <input> by type
  if (el.tagName === 'INPUT') {
    return getInputRole(el as HTMLInputElement);
  }

  // <a> without href is generic, not link
  if (el.tagName === 'A' && !el.hasAttribute('href')) {
    return 'generic';
  }

  return TAG_ROLE_MAP[el.tagName] ?? 'generic';
}

// --- State Detection ---

function getStates(el: Element): string[] {
  const states: string[] = [];

  // ARIA states
  if (el.getAttribute('aria-expanded') === 'true') states.push('expanded');
  if (el.getAttribute('aria-expanded') === 'false') states.push('collapsed');
  if (el.getAttribute('aria-selected') === 'true') states.push('selected');
  if (el.getAttribute('aria-checked') === 'true') states.push('checked');
  if (el.getAttribute('aria-checked') === 'mixed') states.push('mixed');
  if (el.getAttribute('aria-pressed') === 'true') states.push('pressed');
  if (el.getAttribute('aria-current') === 'true' || el.getAttribute('aria-current') === 'page') {
    states.push('current');
  }
  if (el.getAttribute('aria-busy') === 'true') states.push('busy');
  if (el.getAttribute('aria-invalid') === 'true') states.push('invalid');

  // HTML states
  if ((el as HTMLElement).matches?.(':focus')) states.push('focused');
  if (
    el.getAttribute('aria-disabled') === 'true' ||
    (el as HTMLInputElement).disabled === true
  ) {
    states.push('disabled');
  }
  if ((el as HTMLInputElement).required === true) states.push('required');
  if ((el as HTMLInputElement).readOnly === true) states.push('readonly');

  return states;
}

// --- Value Extraction ---

function getValue(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') {
      return el.checked ? 'true' : 'false';
    }
    if (el.type === 'hidden') return undefined;
    return el.value || undefined;
  }
  if (el instanceof HTMLTextAreaElement) {
    return el.value || undefined;
  }
  if (el instanceof HTMLSelectElement) {
    return el.options[el.selectedIndex]?.text || el.value || undefined;
  }
  if (el instanceof HTMLProgressElement) {
    return String(el.value);
  }
  if (el instanceof HTMLMeterElement) {
    return String(el.value);
  }
  return undefined;
}

// --- Tree Building ---

/**
 * Determines if a role is "interesting" enough to show in the tree.
 * Generic containers that have no name, value, or state are pruned
 * to keep the output compact.
 */
function isInterestingNode(
  role: string,
  name: string,
  value: string | undefined,
  states: string[]
): boolean {
  // Always include interactive / landmark / semantic roles
  const ALWAYS_INCLUDE: ReadonlySet<string> = new Set([
    'link',
    'button',
    'textbox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'tabpanel',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'img',
    'heading',
    'navigation',
    'main',
    'banner',
    'contentinfo',
    'complementary',
    'form',
    'search',
    'dialog',
    'alertdialog',
    'alert',
    'status',
    'progressbar',
    'tree',
    'treeitem',
    'grid',
    'row',
    'cell',
    'columnheader',
    'rowheader',
    'table',
    'region',
    'article',
    'listbox',
  ]);

  if (ALWAYS_INCLUDE.has(role)) return true;

  // Include if it has a name, value, or meaningful state
  if (name) return true;
  if (value !== undefined) return true;
  if (states.length > 0) return true;

  return false;
}

/**
 * Process a single DOM element into an A11yNode, recursively
 * processing children. Returns null if the element should be
 * excluded from the tree.
 */
function processElement(el: Element): A11yNode | null {
  if (!isVisible(el)) return null;

  const role = getRole(el);

  // Skip elements with role="none" or role="presentation"
  if (role === 'none' || role === 'presentation') {
    // Still process children - they may be interesting
    return processChildrenOnly(el);
  }

  const name = getAccessibleName(el);
  const value = getValue(el);
  const states = getStates(el);

  // Process children first
  const children: A11yNode[] = [];
  const elChildren = el.children;
  for (let i = 0; i < elChildren.length; i++) {
    const childNode = processElement(elChildren[i]);
    if (childNode) children.push(childNode);
  }

  const interesting = isInterestingNode(role, name, value, states);

  // If this node isn't interesting AND has no interesting children, skip it
  if (!interesting && children.length === 0) return null;

  // If this node isn't interesting but has children, flatten them up
  if (!interesting && children.length > 0) {
    // Create a wrapper only if there are multiple children
    if (children.length === 1) return children[0];
    // For multiple children we need a container
    // but we make it generic so it doesn't clutter the output
  }

  // Assign a ref to this element
  const ref = `ref_${++refCounter}`;
  (el as unknown as Record<string, string>)[REF_PROP] = ref;

  const node: A11yNode = { role, name, ref };
  if (value !== undefined) node.value = value;
  if (states.length > 0) node.state = states;
  if (children.length > 0) node.children = children;

  return node;
}

/**
 * For elements with role=none/presentation, just process their children
 * without creating a node for the element itself.
 */
function processChildrenOnly(el: Element): A11yNode | null {
  const children: A11yNode[] = [];
  const elChildren = el.children;
  for (let i = 0; i < elChildren.length; i++) {
    const childNode = processElement(elChildren[i]);
    if (childNode) children.push(childNode);
  }

  if (children.length === 0) return null;
  if (children.length === 1) return children[0];

  // Multiple children need a container - use generic with no ref
  const ref = `ref_${++refCounter}`;
  (el as unknown as Record<string, string>)[REF_PROP] = ref;
  return { role: 'generic', name: '', ref, children };
}

/**
 * Build the full accessibility tree starting from document.body.
 * Resets the ref counter so refs are consistent per invocation.
 */
function buildAccessibilityTree(): A11yNode | null {
  refCounter = 0;

  if (!document.body) return null;

  return processElement(document.body);
}

// --- Serialization ---

/**
 * Serialize the a11y tree to a compact indented text format.
 *
 * Format per line:
 *   [ref_N] role "name" value="val" (state1, state2)
 *     [ref_M] child_role "child_name"
 *
 * This format is optimized for LLM consumption: compact but readable,
 * with enough structure to understand the page layout.
 */
function serializeTree(node: A11yNode, depth: number = 0): string {
  const indent = '  '.repeat(depth);
  const parts: string[] = [`${indent}[${node.ref}] ${node.role}`];

  if (node.name) {
    // Escape quotes and truncate for readability
    const escaped = node.name.replace(/"/g, '\\"');
    parts.push(`"${escaped}"`);
  }

  if (node.value !== undefined) {
    const escaped = node.value.replace(/"/g, '\\"');
    parts.push(`value="${escaped}"`);
  }

  if (node.state && node.state.length > 0) {
    parts.push(`(${node.state.join(', ')})`);
  }

  const lines: string[] = [parts.join(' ')];

  if (node.children) {
    for (const child of node.children) {
      lines.push(serializeTree(child, depth + 1));
    }
  }

  return lines.join('\n');
}

/**
 * Serialize the tree as a text-only format (just the readable text
 * content, no refs or roles).
 */
function serializeAsText(node: A11yNode, depth: number = 0): string {
  const lines: string[] = [];

  if (node.name) {
    const indent = '  '.repeat(depth);
    lines.push(`${indent}${node.name}`);
  }

  if (node.children) {
    for (const child of node.children) {
      const childText = serializeAsText(child, node.name ? depth + 1 : depth);
      if (childText) lines.push(childText);
    }
  }

  return lines.join('\n');
}

// --- Find by Ref ---

/**
 * Find a DOM element by its stored ref property.
 * Walks all elements in the document looking for the matching ref.
 */
function findElementByRef(ref: string): Element | null {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    null
  );

  let node: Node | null = walker.currentNode;
  while (node) {
    if (
      node instanceof Element &&
      (node as unknown as Record<string, string>)[REF_PROP] === ref
    ) {
      return node;
    }
    node = walker.nextNode();
  }

  return null;
}

/**
 * Clear all stored refs from DOM elements.
 */
function clearAllRefs(): void {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    null
  );

  let node: Node | null = walker.currentNode;
  while (node) {
    if (node instanceof Element && REF_PROP in node) {
      delete (node as unknown as Record<string, string>)[REF_PROP];
    }
    node = walker.nextNode();
  }
}

// --- Form Value Setting ---

/**
 * Set the value of a form element and dispatch proper DOM events
 * so that framework bindings (React, Vue, Angular) are notified.
 */
function setFormElementValue(
  el: Element,
  value: string
): {
  success: boolean;
  error?: string;
  tagName?: string;
  type?: string;
  previousValue?: string;
  newValue?: string;
} {
  const tagName = el.tagName.toLowerCase();

  if (el instanceof HTMLElement) {
    el.focus();
  }

  if (el instanceof HTMLInputElement) {
    const inputType = el.type;

    if (inputType === 'checkbox' || inputType === 'radio') {
      const previousValue = String(el.checked);
      el.checked = value === 'true' || value === '1';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        success: true,
        tagName,
        type: inputType,
        previousValue,
        newValue: String(el.checked),
      };
    }

    const previousValue = el.value;

    // Use native setter to trigger React/Vue bindings
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    return {
      success: true,
      tagName,
      type: inputType,
      previousValue,
      newValue: el.value,
    };
  }

  if (el instanceof HTMLTextAreaElement) {
    const previousValue = el.value;

    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    return {
      success: true,
      tagName,
      type: 'textarea',
      previousValue,
      newValue: el.value,
    };
  }

  if (el instanceof HTMLSelectElement) {
    const previousValue = el.value;

    // Match by value or visible text
    let matched = false;
    for (let i = 0; i < el.options.length; i++) {
      const opt = el.options[i];
      if (opt.value === value || opt.text === value) {
        el.selectedIndex = i;
        matched = true;
        break;
      }
    }

    // Fallback: case-insensitive match
    if (!matched) {
      const lowerValue = value.toLowerCase();
      for (let i = 0; i < el.options.length; i++) {
        const opt = el.options[i];
        if (opt.value.toLowerCase() === lowerValue || opt.text.toLowerCase() === lowerValue) {
          el.selectedIndex = i;
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      return {
        success: false,
        error: `No option matching "${value}" in select element (ref: ${(el as unknown as Record<string, string>)[REF_PROP] ?? 'unknown'})`,
      };
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));

    return {
      success: true,
      tagName,
      type: 'select',
      previousValue,
      newValue: el.value,
    };
  }

  // Contenteditable elements
  if (el instanceof HTMLElement && el.isContentEditable) {
    const previousValue = el.innerText;
    el.innerText = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    return {
      success: true,
      tagName,
      type: 'contenteditable',
      previousValue,
      newValue: el.innerText,
    };
  }

  return {
    success: false,
    error: `Element <${tagName}> is not a supported form element`,
  };
}

// --- Message Listener ---

chrome.runtime.onMessage.addListener(
  (
    message: {
      action: string;
      format?: string;
      ref?: string;
      value?: string;
    },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    switch (message.action) {
      case 'get_accessibility_tree': {
        const format = message.format ?? 'accessibility';
        const tree = buildAccessibilityTree();

        if (!tree) {
          sendResponse({ success: false, error: 'No document body found' });
          return;
        }

        let result: string;
        switch (format) {
          case 'text':
            result = serializeAsText(tree);
            break;
          case 'accessibility':
          default:
            result = serializeTree(tree);
            break;
        }

        sendResponse({ success: true, data: result });
        break;
      }

      case 'find_by_ref': {
        if (!message.ref) {
          sendResponse({ success: false, error: 'Missing ref parameter' });
          return;
        }

        const el = findElementByRef(message.ref);
        if (!el) {
          sendResponse({ success: false, error: `Element not found: ${message.ref}` });
          return;
        }

        const rect = el.getBoundingClientRect();
        sendResponse({
          success: true,
          bounds: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          tagName: el.tagName.toLowerCase(),
          isInteractive:
            el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement ||
            el instanceof HTMLSelectElement ||
            el instanceof HTMLButtonElement ||
            el.tagName === 'A',
        });
        break;
      }

      case 'set_form_value': {
        if (!message.ref) {
          sendResponse({ success: false, error: 'Missing ref parameter' });
          return;
        }
        if (message.value === undefined) {
          sendResponse({ success: false, error: 'Missing value parameter' });
          return;
        }

        const formEl = findElementByRef(message.ref);
        if (!formEl) {
          sendResponse({ success: false, error: `Element not found: ${message.ref}` });
          return;
        }

        const formResult = setFormElementValue(formEl, message.value);
        sendResponse(formResult);
        break;
      }

      case 'clear_refs': {
        clearAllRefs();
        sendResponse({ success: true });
        break;
      }

      default:
        // Unknown action - don't respond
        return;
    }
  },
);
